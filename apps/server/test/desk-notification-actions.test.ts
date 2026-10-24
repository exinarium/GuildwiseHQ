import { randomUUID } from 'node:crypto';
import { DESK_ACTION_TOKEN_TTL_MS, streamId } from '@aom/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sweepDeskActionTokens } from '../src/push/desk-actions.ts';
import { createTestApp, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';

const send = vi.hoisted(() => vi.fn());
vi.mock('web-push', () => ({ default: { sendNotification: send, generateVAPIDKeys: () => ({}) } }));

const VAPID = {
  AOM_VAPID_PUBLIC_KEY: 'BPublicKeyForTests',
  AOM_VAPID_PRIVATE_KEY: 'privateKeyForTests',
  AOM_VAPID_SUBJECT: 'mailto:ops@example.com',
  AOM_PUSH_OFFLINE_GRACE_SECONDS: '0',
};

let t: TestApp;
let owner: { id: string; cookie: string };
let member: { id: string; cookie: string };
beforeAll(async () => {
  t = await createTestApp({ env: VAPID });
  owner = await t.userSession(uniqueEmail('owner'));
  member = await t.userSession(uniqueEmail('member'));
  await t.addOrgMember(owner.id, member.id, 'member');
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});
beforeEach(async () => {
  send.mockReset();
  send.mockResolvedValue({ statusCode: 201 });
  await q('DELETE FROM push_subscriptions');
  await q('DELETE FROM push_deliveries');
  await q('DELETE FROM push_prefs');
  await q('DELETE FROM desk_action_tokens');
});

const ctx = () => t.app.ctx;
const payloads = () => send.mock.calls.map((c) => JSON.parse(c[1] as string));
async function subscribe(user: { cookie: string }) {
  const r = await t.req('POST', '/api/push/subscriptions', {
    cookie: user.cookie,
    body: {
      endpoint: `https://push.example.com/send/${randomUUID()}`,
      keys: { p256dh: 'p256dh-key', auth: 'auth-secret' },
    },
  });
  expect(r.status).toBe(201);
}

async function approval(over: Record<string, unknown> = {}) {
  const deskItemId = randomUUID();
  await ctx().store.append([
    {
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'DeskItemCreated',
        payload: { deskItemId, kind: 'approval', title: 'Ship the thing?', body: 'Details', ...over },
      } as never,
      actor: { kind: 'system', id: null } as never,
      scope: { orgId: owner.id, projectId: null, audience: 'org' },
    },
  ]);
  await ctx().services.push?.flush();
  return deskItemId;
}
async function question(options: Array<{ id: string; label: string }>, recommendation?: string) {
  const deskItemId = randomUUID();
  await ctx().store.append([
    {
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'QuestionRaised',
        payload: {
          deskItemId,
          blocking: true,
          pinned: true,
          affectedCardIds: [],
          askedBy: { kind: 'system' },
          question: 'Which database?',
          options,
          ...(recommendation ? { recommendation } : {}),
        },
      } as never,
      actor: { kind: 'system', id: null } as never,
      scope: { orgId: owner.id, projectId: null, audience: 'org' },
    },
  ]);
  await ctx().services.push?.flush();
  return deskItemId;
}
const tokenOf = (url: string) => decodeURIComponent(url.replace('/m/desk/', ''));
const itemStatus = async (id: string) =>
  (await q('SELECT status FROM desk_items WHERE id=$1', [id]))[0]?.status;
const audits = async (id: string) =>
  (
    await q(
      `SELECT payload FROM events WHERE type='DeskNotificationActionTaken' AND payload->>'deskItemId'=$1 ORDER BY seq`,
      [id],
    )
  ).map((r) => r.payload as Record<string, string>);

describe('actions on the push payload', () => {
  it('an approval carries Approve and Reject, each with its own confirm link', async () => {
    await subscribe(owner);
    await approval();
    const [p] = payloads();
    expect(p.actions.map((a: any) => a.action)).toEqual(['approve', 'reject']);
    expect(p.actions.map((a: any) => a.title)).toEqual(['Approve', 'Reject']);
    expect(p.actions[0].url).toMatch(/^\/m\/desk\/[^/]+$/);
    expect(p.actions[0].url).not.toBe(p.actions[1].url);
    expect(p.url).toMatch(/^\/desk#desk-item-/);
    const rows = await q('SELECT action, user_id FROM desk_action_tokens ORDER BY action');
    expect(rows.map((r) => r.action)).toEqual(['approve', 'reject']);
    expect(rows.every((r) => r.user_id === owner.id)).toBe(true);
  });

  it('a question offers at most two options, the recommended one first', async () => {
    await subscribe(owner);
    await question(
      [
        { id: 'o1', label: 'SQLite' },
        { id: 'o2', label: 'Postgres' },
        { id: 'o3', label: 'MySQL' },
      ],
      'o2',
    );
    const [p] = payloads();
    expect(p.actions.map((a: any) => a.title)).toEqual(['Postgres', 'SQLite']);
    expect(p.actions.map((a: any) => a.action)).toEqual(['o2', 'o1']);
  });

  it('a question without options carries no actions', async () => {
    await subscribe(owner);
    await question([]);
    expect(payloads()[0].actions).toBeUndefined();
  });

  it('the buttons are made for the person who gets the notification (their own tokens)', async () => {
    await subscribe(member);
    await approval({ addresseeUserId: member.id });
    expect(payloads()[0].actions).toHaveLength(2);
    const rows = await q('SELECT DISTINCT user_id FROM desk_action_tokens');
    expect(rows.map((r) => r.user_id)).toEqual([member.id]);
  });

  it('an approval that is a choice of its own (options) and the card approval step get no buttons', async () => {
    await subscribe(owner);
    await approval({ options: [{ id: 'a', label: 'Use A' }] });
    expect(payloads()[0].actions).toBeUndefined();
  });
});

describe('the confirm link', () => {
  async function link(action = 'approve') {
    await subscribe(owner);
    const id = await approval();
    const p = payloads().at(-1);
    const url = p.actions.find((a: any) => a.action === action).url as string;
    return { id, token: tokenOf(url) };
  }

  it('GET only previews: nothing is applied, and it can be repeated', async () => {
    const { id, token } = await link();
    for (let i = 0; i < 2; i++) {
      const r = await t.req('GET', `/api/m/desk/${encodeURIComponent(token)}`, { cookie: owner.cookie });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        state: 'ready',
        deskItemId: id,
        actionLabel: 'Approve',
        action: 'approve',
      });
    }
    expect(await itemStatus(id)).toBe('open');
    expect(await audits(id)).toEqual([]);
  });

  it('needs a signed-in person', async () => {
    const { token } = await link();
    expect((await t.req('GET', `/api/m/desk/${encodeURIComponent(token)}`)).status).toBe(401);
    expect((await t.req('POST', `/api/m/desk/${encodeURIComponent(token)}/apply`, { body: {} })).status).toBe(
      401,
    );
  });

  it('POST applies once, audits it, and refuses a replay', async () => {
    const { id, token } = await link();
    const url = `/api/m/desk/${encodeURIComponent(token)}/apply`;
    const r = await t.req('POST', url, { cookie: owner.cookie, body: {} });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ deskItemId: id, outcome: 'approved' });
    expect(await itemStatus(id)).not.toBe('open');
    const again = await t.req('POST', url, { cookie: owner.cookie, body: {} });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('link_used');
    const a = await audits(id);
    expect(a.map((x) => x.outcome)).toEqual(['applied', 'refused']);
    expect(a[0]).toMatchObject({ userId: owner.id, action: 'approve' });
    expect(a[1]?.reason).toBe('used');
    // a used link previews as used
    const pv = await t.req('GET', `/api/m/desk/${encodeURIComponent(token)}`, { cookie: owner.cookie });
    expect(pv.body.state).toBe('used');
  });

  it('Reject rejects', async () => {
    const { id, token } = await link('reject');
    const r = await t.req('POST', `/api/m/desk/${encodeURIComponent(token)}/apply`, {
      cookie: owner.cookie,
      body: {},
    });
    expect(r.body.outcome).toBe('rejected');
    expect(
      (await q('SELECT status, answer_option FROM desk_items WHERE id=$1', [id]))[0]?.answer_option,
    ).toBe('rejected');
  });

  it('a quick option answers the question with that option', async () => {
    await subscribe(owner);
    const id = await question([
      { id: 'o1', label: 'SQLite' },
      { id: 'o2', label: 'Postgres' },
    ]);
    const url = payloads()
      .at(-1)
      .actions.find((a: any) => a.action === 'o2').url as string;
    const r = await t.req('POST', `/api/m/desk/${encodeURIComponent(tokenOf(url))}/apply`, {
      cookie: owner.cookie,
      body: {},
    });
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe('answered');
    const row = (await q('SELECT status, answer, answer_option FROM desk_items WHERE id=$1', [id]))[0];
    expect(row).toMatchObject({ status: 'answered', answer: 'Postgres', answer_option: 'o2' });
  });

  it('another signed-in person cannot use it, it stays unspent, and the attempt is audited', async () => {
    const { id, token } = await link();
    const url = `/api/m/desk/${encodeURIComponent(token)}`;
    expect((await t.req('GET', url, { cookie: member.cookie })).status).toBe(403);
    const r = await t.req('POST', `${url}/apply`, { cookie: member.cookie, body: {} });
    expect(r.status).toBe(403);
    expect(await itemStatus(id)).toBe('open');
    const a = await audits(id);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      outcome: 'refused',
      reason: 'wrong_user',
      userId: owner.id,
      attemptedBy: member.id,
    });
    // the rightful person can still use it
    expect((await t.req('POST', `${url}/apply`, { cookie: owner.cookie, body: {} })).status).toBe(200);
  });

  it('expires after 15 minutes', async () => {
    const { id, token } = await link();
    t.clock.advance(DESK_ACTION_TOKEN_TTL_MS + 1000);
    try {
      const pv = await t.req('GET', `/api/m/desk/${encodeURIComponent(token)}`, { cookie: owner.cookie });
      expect(pv.body.state).toBe('expired');
      const r = await t.req('POST', `/api/m/desk/${encodeURIComponent(token)}/apply`, {
        cookie: owner.cookie,
        body: {},
      });
      expect(r.status).toBe(410);
      expect(await itemStatus(id)).toBe('open');
      expect((await audits(id))[0]).toMatchObject({ outcome: 'refused', reason: 'expired' });
      expect(await sweepDeskActionTokens(ctx())).toBe(0);
      t.clock.advance(24 * 3600_000);
      expect(await sweepDeskActionTokens(ctx())).toBeGreaterThan(0);
    } finally {
      t.clock.setOffset(0);
    }
  });

  it('a tampered or foreign token is not valid', async () => {
    const { token } = await link();
    const bad = `${token.slice(0, -2)}xx`;
    expect(
      (await t.req('GET', `/api/m/desk/${encodeURIComponent(bad)}`, { cookie: owner.cookie })).status,
    ).toBe(404);
    expect(
      (
        await t.req('POST', `/api/m/desk/${encodeURIComponent(`${randomUUID()}.abcdefghijkl`)}/apply`, {
          cookie: owner.cookie,
          body: {},
        })
      ).status,
    ).toBe(404);
  });

  it('an item decided elsewhere first is reported, not applied twice', async () => {
    const { id, token } = await link();
    const r1 = await t.req('POST', `/api/desk/${id}/resolve`, {
      cookie: owner.cookie,
      body: { resolution: 'rejected' },
    });
    expect(r1.status).toBe(200);
    const pv = await t.req('GET', `/api/m/desk/${encodeURIComponent(token)}`, { cookie: owner.cookie });
    expect(pv.body.state).toBe('resolved');
    const r = await t.req('POST', `/api/m/desk/${encodeURIComponent(token)}/apply`, {
      cookie: owner.cookie,
      body: {},
    });
    expect(r.status).toBe(409);
  });
});
