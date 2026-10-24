import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { followUpSweep } from '../src/commands/follow-up.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { addMember } from './helpers/members.ts';
import { seed } from './helpers/seed.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

const send = vi.hoisted(() => vi.fn());
vi.mock('web-push', () => ({ default: { sendNotification: send, generateVAPIDKeys: () => ({}) } }));

const DAY = 86_400_000;
let w: World;
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
  const r = await w.t.req('POST', '/api/push/subscriptions', {
    cookie: w.owner.cookie,
    body: { endpoint: `https://push.example.com/send/${randomUUID()}`, keys: { p256dh: 'p', auth: 'a' } },
  });
  expect(r.status).toBe(201);
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});
beforeEach(async () => {
  send.mockReset();
  send.mockResolvedValue({ statusCode: 201 });
  await q('TRUNCATE desk_items, ledger_entries CASCADE');
  await q('DELETE FROM desk_follow_ups');
  await q('DELETE FROM org_follow_up');
  await q('DELETE FROM push_deliveries');
});

/** Time passes: every recorded moment moves back (the session cookies live on the real clock). */
async function age(ms: number) {
  const iv = `${ms} * interval '1 millisecond'`;
  await q(`UPDATE desk_items SET created_at = created_at - ${iv}, updated_at = updated_at - ${iv}`);
  await q(
    `UPDATE desk_follow_ups SET last_nudge_at = last_nudge_at - ${iv}, snoozed_until = snoozed_until - ${iv}`,
  );
}
const sweep = () => followUpSweep(w.t.app.ctx);
const pushes = () => send.mock.calls.map((c) => JSON.parse(c[1] as string));
async function raise(over: Record<string, unknown> = {}, kind = 'question'): Promise<string> {
  const deskItemId = randomUUID();
  const event =
    kind === 'question'
      ? {
          type: 'QuestionRaised',
          payload: {
            deskItemId,
            question: 'Which payment provider should we use for the pilot?',
            blocking: false,
            pinned: false,
            affectedCardIds: [],
            askedBy: { kind: 'system' },
            ...over,
          },
        }
      : {
          type: 'DeskItemCreated',
          payload: {
            deskItemId,
            kind,
            title: 'Rate the digest',
            body: '',
            options: [],
            blocking: false,
            pinned: false,
            affectedCardIds: [],
            askedBy: { kind: 'system' },
            ...over,
          },
        };
  await seed(w, [
    {
      streamId: streamId.desk(deskItemId),
      event: event as never,
      actor: { kind: 'system', id: null },
      scope: { orgId: w.owner.id, projectId: null, audience: 'org' },
    },
  ]);
  await w.t.app.ctx.services.push?.flush();
  send.mockClear();
  return deskItemId;
}
const followUp = async (id: string) =>
  (await q('SELECT * FROM desk_follow_ups WHERE desk_item_id=$1', [id]))[0];

describe('follow-up and chase', () => {
  it('nudges the owner once after the default 3 days, never twice inside the window, again after another 3', async () => {
    const id = await raise();
    await age(2 * DAY);
    expect(await sweep()).toEqual({ nudged: 0, requeued: 0 });
    expect(await followUp(id)).toBeUndefined();
    await age(1 * DAY + 1000);
    expect(await sweep()).toEqual({ nudged: 1, requeued: 0 });
    expect(await followUp(id)).toMatchObject({ nudge_count: 1 });
    expect(pushes()).toHaveLength(1);
    expect(pushes()[0]).toMatchObject({ title: 'Still waiting for you', url: `/desk#desk-item-${id}` });
    expect(pushes()[0].body).toContain('open for 3 days');
    // a second pass right after, and two days later: nothing
    expect(await sweep()).toEqual({ nudged: 0, requeued: 0 });
    await age(2 * DAY);
    expect(await sweep()).toEqual({ nudged: 0, requeued: 0 });
    expect(pushes()).toHaveLength(1);
    // three days after the first nudge: the second one
    await age(1 * DAY + 1000);
    expect(await sweep()).toEqual({ nudged: 1, requeued: 0 });
    expect(await followUp(id)).toMatchObject({ nudge_count: 2 });
    expect(pushes()).toHaveLength(2);
  });

  it('shows the reminder on the desk item and drops the chase once it is answered', async () => {
    const id = await raise();
    await age(3 * DAY + 1000);
    await sweep();
    const desk = await ok<any>(w.t.req('GET', '/api/desk', { cookie: w.owner.cookie }));
    const item = desk.items.find((i: any) => i.id === id);
    expect(item.followUp).toMatchObject({ nudgeCount: 1, snoozedUntil: null });
    expect(item.followUp.nudgedAt).toBeTruthy();
    await ok(
      w.t.req('POST', `/api/desk/${id}/answer`, { cookie: w.owner.cookie, body: { answer: 'Stripe' } }),
    );
    await age(10 * DAY);
    expect(await sweep()).toEqual({ nudged: 0, requeued: 0 });
  });

  it('uses the organization’s window; only Owners and Admins change it; 0 turns the chase off', async () => {
    const id = await raise();
    expect((await ok<any>(w.t.req('GET', '/api/org/follow-up', { cookie: w.owner.cookie }))).days).toBe(3);
    const m = await addMember(w, 'mem');
    await w.t.addOrgMember(w.owner.id, m.id, 'member');
    const org = { 'x-aom-org': w.owner.id };
    expect(
      (await w.t.req('PUT', '/api/org/follow-up', { cookie: m.cookie, headers: org, body: { days: 1 } }))
        .status,
    ).toBe(403);
    expect(
      (await w.t.req('PUT', '/api/org/follow-up', { cookie: w.owner.cookie, body: { days: 31 } })).status,
    ).toBe(400);
    expect(
      await ok<any>(w.t.req('PUT', '/api/org/follow-up', { cookie: w.owner.cookie, body: { days: 1 } })),
    ).toEqual({ days: 1 });
    await age(1 * DAY + 1000);
    expect(await sweep()).toEqual({ nudged: 1, requeued: 0 });
    await ok(w.t.req('PUT', '/api/org/follow-up', { cookie: w.owner.cookie, body: { days: 0 } }));
    await age(10 * DAY);
    expect(await sweep()).toEqual({ nudged: 0, requeued: 0 });
    expect(await followUp(id)).toMatchObject({ nudge_count: 1 });
  });

  it('holds the nudge back while an item is snoozed, then goes on', async () => {
    const id = await raise();
    const snoozed = await ok<any>(
      w.t.req('POST', `/api/desk/${id}/snooze`, { cookie: w.owner.cookie, body: { days: 5 } }),
    );
    expect(new Date(snoozed.snoozedUntil).getTime()).toBeGreaterThan(w.t.clock.now().getTime());
    await age(4 * DAY);
    expect(await sweep()).toEqual({ nudged: 0, requeued: 0 });
    await age(1 * DAY + 1000);
    expect(await sweep()).toEqual({ nudged: 1, requeued: 0 });
    expect(
      (await w.t.req('POST', `/api/desk/${id}/snooze`, { cookie: w.owner.cookie, body: { days: 15 } }))
        .status,
    ).toBe(400);
    expect(
      (
        await w.t.req('POST', `/api/desk/${randomUUID()}/snooze`, {
          cookie: w.owner.cookie,
          body: { days: 1 },
        })
      ).status,
    ).toBe(404);
    expect((await w.t.req('POST', `/api/desk/${id}/snooze`, { body: { days: 1 } })).status).toBe(401);
  });

  it('chases digest rating items but not reports', async () => {
    const rating = await raise({ subkind: 'digest' }, 'rating');
    const report = await raise({ subkind: 'floor_report' }, 'alert');
    await age(3 * DAY + 1000);
    expect(await sweep()).toEqual({ nudged: 1, requeued: 0 });
    expect(await followUp(rating)).toMatchObject({ nudge_count: 1 });
    expect(await followUp(report)).toBeUndefined();
  });

  it('re-queues an item that sits with an agent, once, with no push', async () => {
    const agent = await w.hire('Una', 'builder', 'junior');
    const id = await raise({ routedTo: 'agent', routedAgentId: agent.id });
    const before = (await q('SELECT updated_at FROM desk_items WHERE id=$1', [id]))[0]!.updated_at as Date;
    await age(3 * DAY + 1000);
    expect(await sweep()).toEqual({ nudged: 0, requeued: 1 });
    expect(await followUp(id)).toMatchObject({ nudge_count: 1 });
    const after = (await q('SELECT updated_at, routed_to FROM desk_items WHERE id=$1', [id]))[0]!;
    expect(after.routed_to).toBe('agent');
    expect(new Date(after.updated_at).getTime()).toBeGreaterThan(new Date(before).getTime());
    expect(pushes()).toHaveLength(0);
    await age(9 * DAY);
    expect(await sweep()).toEqual({ nudged: 0, requeued: 0 });
  });

  it('skips an agent’s item while its project is paused', async () => {
    const agent = await w.hire('Vera', 'builder', 'junior');
    const id = await raise({ routedTo: 'agent', routedAgentId: agent.id, projectId: w.projectId });
    await ok(w.t.req('POST', `/api/projects/${w.projectId}/pause`, { cookie: w.owner.cookie, body: {} }));
    await age(4 * DAY);
    expect(await sweep()).toEqual({ nudged: 0, requeued: 0 });
    await ok(w.t.req('POST', `/api/projects/${w.projectId}/resume`, { cookie: w.owner.cookie }));
    expect(await followUp(id)).toBeUndefined();
  });

  it('records the nudge even when the person turned the reminder category off', async () => {
    const id = await raise();
    await ok(
      w.t.req('PUT', '/api/push/preferences', {
        cookie: w.owner.cookie,
        body: { categories: { follow_ups: false } },
      }),
    );
    await age(3 * DAY + 1000);
    expect(await sweep()).toEqual({ nudged: 1, requeued: 0 });
    expect(pushes()).toHaveLength(0);
    expect(await followUp(id)).toMatchObject({ nudge_count: 1 });
  });
});
