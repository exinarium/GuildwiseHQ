import { randomUUID } from 'node:crypto';
import { BOARD_VERBS_CAPABILITY, SESSION_TURNS_CAPABILITY, SESSION_VERBS_CAPABILITY } from '@aom/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeAdminPool } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { kit, q } from './helpers/sessions-r2.ts';
import { createWorld, type World } from './helpers/world.ts';

const send = vi.hoisted(() => vi.fn());
vi.mock('web-push', () => ({ default: { sendNotification: send, generateVAPIDKeys: () => ({}) } }));

/** Q54: the creator of a session is pushed at the time-limit warning and at time-up (both kinds). */
let w: World;
let r: FakeRunner;
let K: ReturnType<typeof kit>;
beforeAll(async () => {
  w = await createWorld({
    env: {
      AOM_FIRST_RUN_HIRE_CAP: 'false',
      AOM_VAPID_PUBLIC_KEY: 'BPublicKeyForTests',
      AOM_VAPID_PRIVATE_KEY: 'privateKeyForTests',
      AOM_VAPID_SUBJECT: 'mailto:ops@example.com',
      AOM_PUSH_OFFLINE_GRACE_SECONDS: '0',
    },
  });
  r = await w.connectRunner({
    capabilities: [SESSION_TURNS_CAPABILITY, SESSION_VERBS_CAPABILITY, BOARD_VERBS_CAPABILITY],
  });
  K = kit(w, () => r);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});
beforeEach(async () => {
  send.mockReset();
  send.mockResolvedValue({ statusCode: 201 });
  await q('DELETE FROM push_subscriptions');
  await q('DELETE FROM push_deliveries');
  await q('DELETE FROM push_prefs');
  const sub = await w.t.req('POST', '/api/push/subscriptions', {
    cookie: w.owner.cookie,
    body: {
      endpoint: `https://push.example.com/send/${randomUUID()}`,
      keys: { p256dh: 'p256dh-key', auth: 'auth-secret' },
    },
  });
  expect(sub.status).toBe(201);
});
afterEach(async () => {
  await K.cleanup();
});
const sweeps = [() => w.t.app.ctx.services.board.sweep(), () => w.t.app.ctx.services.discovery.sweep()];
const pushes = async () => {
  await w.t.app.ctx.services.push?.flush();
  return send.mock.calls.map(
    (c) => JSON.parse(c[1] as string) as { title: string; body: string; url: string },
  );
};

describe('push to the session creator at the time limit (Q54)', () => {
  it('tells the creator of a boardroom at the warning and at time-up, once each, with a link to the session', async () => {
    const st = await K.createBoard({ timeLimitMinutes: 15 });
    await K.tickMinutes(9, sweeps);
    expect(await pushes()).toHaveLength(0);
    await K.tickMinutes(2, sweeps);
    let list = await pushes();
    expect(list).toHaveLength(1);
    expect(list[0]?.title).toMatch(/Boardroom: about \d+ minutes? left/);
    expect(list[0]?.url).toBe(`/boardroom/${st.threadId}`);
    // more ticks do not repeat the warning
    await K.tickMinutes(2, sweeps);
    expect(await pushes()).toHaveLength(1);
    await K.tickMinutes(3, sweeps);
    list = await pushes();
    expect(list).toHaveLength(2);
    expect(list[1]?.title).toBe('Boardroom time is up');
    expect(list[1]?.body).toContain('extend');
    // extending and running out again tells them again
    await K.owner('POST', `/api/board/${st.threadId}/time`, { action: 'extend', minutes: 10 });
    await K.tickMinutes(8, sweeps);
    expect((await pushes()).length).toBeGreaterThanOrEqual(3);
  });

  it('tells the creator of a discovery session, and only the creator; a category switch-off stops it', async () => {
    const other = await w.t.userSession(`r3c-push-${randomUUID().slice(0, 6)}@example.test`);
    await w.t.addOrgMember(w.owner.id, other.id, 'member');
    await w.t.req('POST', '/api/push/subscriptions', {
      cookie: other.cookie,
      body: {
        endpoint: `https://push.example.com/send/${randomUUID()}`,
        keys: { p256dh: 'p256dh-key', auth: 'auth-secret' },
      },
    });
    const st = await K.createDiscovery({ timeBoxMinutes: 12 });
    await K.tickMinutes(9, sweeps);
    const list = await pushes();
    expect(list).toHaveLength(1);
    expect(list[0]?.url).toBe(`/discovery/${st.threadId}`);
    expect(send.mock.calls).toHaveLength(1); // the other member has a device but did not create the session
    await K.tickMinutes(4, sweeps);
    expect((await pushes()).map((x) => x.title)).toContain('Discovery time is up');
    // switching the category off
    await w.t.req('PUT', '/api/push/preferences', {
      cookie: w.owner.cookie,
      body: { categories: { session_time: false } },
    });
    send.mockClear();
    const st2 = await K.createDiscovery({ timeBoxMinutes: 12 });
    await K.tickMinutes(13, sweeps);
    expect(st2.threadId).toBeTruthy();
    expect(await pushes()).toHaveLength(0);
  });
});
