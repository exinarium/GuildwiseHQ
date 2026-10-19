import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { streamId } from '@aom/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { notifyUsers, safeBody } from '../src/push/notifier.ts';
import { inQuietHours, localMinutes } from '../src/push/prefs.ts';
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
});

const ctx = () => t.app.ctx;
const sub = (n = 1) => ({
  endpoint: `https://push.example.com/send/${n}-${randomUUID()}`,
  keys: { p256dh: 'p256dh-key', auth: 'auth-secret' },
});
async function subscribe(user: { cookie: string }, body = sub()) {
  const r = await t.req('POST', '/api/push/subscriptions', { cookie: user.cookie, body });
  expect(r.status).toBe(201);
  return { id: r.body.id as string, ...body };
}
const sent = () => send.mock.calls.map((c) => ({ sub: c[0], payload: JSON.parse(c[1] as string) }));

async function raise(
  over: Record<string, unknown> = {},
  actor: { kind: string; id: string | null } = { kind: 'system', id: null },
) {
  const deskItemId = randomUUID();
  const kind = (over.kind as string | undefined) ?? 'question';
  const common = {
    deskItemId,
    blocking: true,
    pinned: true,
    affectedCardIds: [],
    askedBy: { kind: 'system' },
  };
  const { title, body, ...rest } = over as { title?: string; body?: string };
  const event =
    kind === 'question'
      ? {
          type: 'QuestionRaised',
          payload: {
            ...common,
            question: `${title ?? 'Which database should the report use?'} See \`src/db.ts\`. password=hunter2hunter2`,
            ...rest,
            kind: undefined,
          },
        }
      : {
          type: 'DeskItemCreated',
          payload: { ...common, title: title ?? 'Something', body: body ?? '', options: [], ...rest },
        };
  await ctx().store.append([
    {
      streamId: streamId.desk(deskItemId),
      event: event as never,
      actor: actor as never,
      scope: { orgId: owner.id, projectId: null, audience: 'org' },
    },
  ]);
  await ctx().services.push?.flush();
  return deskItemId;
}

describe('config and subscriptions', () => {
  it('reports the public key when VAPID is configured', async () => {
    const r = await t.req('GET', '/api/push/config', { cookie: member.cookie });
    expect(r.body).toEqual({ enabled: true, publicKey: VAPID.AOM_VAPID_PUBLIC_KEY });
  });

  it('is disabled without a complete VAPID configuration and refuses subscriptions', async () => {
    const off = await createTestApp({ env: { AOM_VAPID_PUBLIC_KEY: 'x' }, reset: false });
    try {
      const u = await off.userSession(uniqueEmail('off'));
      expect((await off.req('GET', '/api/push/config', { cookie: u.cookie })).body).toEqual({
        enabled: false,
      });
      expect(
        (await off.req('POST', '/api/push/subscriptions', { cookie: u.cookie, body: sub() })).status,
      ).toBe(409);
      expect(off.app.ctx.services.push).toBeUndefined();
    } finally {
      await off.close();
    }
  });

  it('rejects a mailto-less or malformed subject', async () => {
    const bad = await createTestApp({
      env: { ...VAPID, AOM_VAPID_SUBJECT: 'ops@example.com' },
      reset: false,
    });
    try {
      expect(bad.app.ctx.config.push.enabled).toBe(false);
    } finally {
      await bad.close();
    }
  });

  it('requires a session', async () => {
    expect((await t.req('GET', '/api/push/subscriptions')).status).toBe(401);
    expect((await t.req('POST', '/api/push/subscriptions', { body: sub() })).status).toBe(401);
    expect((await t.req('POST', '/api/push/test')).status).toBe(401);
  });

  it('lists only your own devices, labels them and deletes only your own', async () => {
    const mine = await subscribe(owner);
    const theirs = await subscribe(member);
    const list = await t.req('GET', '/api/push/subscriptions', { cookie: owner.cookie });
    expect(list.body.devices.map((d: any) => d.id)).toEqual([mine.id]);
    expect(list.body.devices[0].label).toBeTruthy();
    expect(
      (await t.req('DELETE', `/api/push/subscriptions/${theirs.id}`, { cookie: owner.cookie })).status,
    ).toBe(404);
    expect((await q('SELECT 1 FROM push_subscriptions WHERE id=$1', [theirs.id])).length).toBe(1);
    expect(
      (await t.req('DELETE', `/api/push/subscriptions/${mine.id}`, { cookie: owner.cookie })).status,
    ).toBe(204);
    expect((await t.req('GET', '/api/push/subscriptions', { cookie: owner.cookie })).body.devices).toEqual(
      [],
    );
  });

  it('subscribing again with the same endpoint keeps one row', async () => {
    const s = sub();
    await subscribe(owner, s);
    await subscribe(owner, s);
    expect((await q('SELECT 1 FROM push_subscriptions WHERE endpoint=$1', [s.endpoint])).length).toBe(1);
  });

  it('sends a test notification to your own devices only', async () => {
    const mine = await subscribe(owner);
    await subscribe(member);
    const r = await t.req('POST', '/api/push/test', { cookie: owner.cookie });
    expect(r.body).toEqual({ sent: 1, failed: 0 });
    expect(sent()).toHaveLength(1);
    expect(sent()[0]?.sub.endpoint).toBe(mine.endpoint);
    expect(sent()[0]?.payload.tag).toBe('test');
  });
});

describe('delivery results', () => {
  it('deletes a subscription the push service reports gone (404 and 410)', async () => {
    const a = await subscribe(owner, sub(1));
    const b = await subscribe(owner, sub(2));
    send.mockImplementation(async (s: { endpoint: string }) => {
      throw Object.assign(new Error('gone'), { statusCode: s.endpoint === a.endpoint ? 410 : 404 });
    });
    const r = await t.req('POST', '/api/push/test', { cookie: owner.cookie });
    expect(r.body).toEqual({ sent: 0, failed: 2 });
    expect((await q('SELECT id FROM push_subscriptions WHERE id = ANY($1)', [[a.id, b.id]])).length).toBe(0);
  });

  it('counts other failures and resets the count on success', async () => {
    const a = await subscribe(owner);
    send.mockRejectedValueOnce(Object.assign(new Error('boom'), { statusCode: 500 }));
    await t.req('POST', '/api/push/test', { cookie: owner.cookie });
    let row = (
      await q('SELECT failure_count, last_failure_at FROM push_subscriptions WHERE id=$1', [a.id])
    )[0];
    expect(row?.failure_count).toBe(1);
    expect(row?.last_failure_at).not.toBeNull();
    await t.req('POST', '/api/push/test', { cookie: owner.cookie });
    row = (await q('SELECT failure_count, last_success_at FROM push_subscriptions WHERE id=$1', [a.id]))[0];
    expect(row?.failure_count).toBe(0);
    expect(row?.last_success_at).not.toBeNull();
  });
});

describe('preferences', () => {
  it('defaults every category on except chat replies, and saves changes', async () => {
    const r = await t.req('GET', '/api/push/preferences', { cookie: member.cookie });
    expect(r.body.categories.desk_blocking).toBe(true);
    expect(r.body.categories.chat_replies).toBe(false);
    expect(r.body.quietHours.enabled).toBe(false);
    const put = await t.req('PUT', '/api/push/preferences', {
      cookie: member.cookie,
      body: {
        categories: { desk_blocking: false },
        quietHours: { enabled: true, start: '21:00', end: '06:30' },
      },
    });
    expect(put.status).toBe(200);
    const again = await t.req('GET', '/api/push/preferences', { cookie: member.cookie });
    expect(again.body.categories.desk_blocking).toBe(false);
    expect(again.body.categories.owner_approvals).toBe(true);
    expect(again.body.quietHours).toEqual({ enabled: true, start: '21:00', end: '06:30' });
    expect(
      (
        await t.req('PUT', '/api/push/preferences', {
          cookie: member.cookie,
          body: { quietHours: { enabled: true, start: '25:00', end: '06:30' } },
        })
      ).status,
    ).toBe(400);
  });
});

describe('routing', () => {
  it('sends a blocking question to its addressee with a deep link, a clean body and a tag', async () => {
    await subscribe(member);
    await subscribe(owner);
    const id = await raise({ addresseeUserId: member.id });
    expect(sent()).toHaveLength(1);
    const p = sent()[0]?.payload;
    expect(p.url).toBe(`/desk#desk-item-${id}`);
    expect(p.tag).toBe(`desk_blocking:${id}`);
    expect(p.title).toBe('A question for you');
    expect(p.body).toContain('Which database');
    expect(p.body.length).toBeLessThanOrEqual(140);
    expect(p.body).not.toContain('hunter2');
    expect(p.body).not.toContain('src/db.ts');
    expect(typeof p.badge).toBe('number');
  });

  it('sends an org-level item without an addressee to the Owner and Admins, not to members', async () => {
    await subscribe(member);
    await subscribe(owner);
    await raise({});
    expect(sent().map((s) => s.sub.endpoint)).toHaveLength(1);
    const ownerSub = (await q('SELECT endpoint FROM push_subscriptions WHERE user_id=$1', [owner.id]))[0];
    expect(sent()[0]?.sub.endpoint).toBe(ownerSub?.endpoint);
  });

  it('does not notify for a plain alert or for a category that is switched off', async () => {
    await subscribe(member);
    await raise({ addresseeUserId: member.id, kind: 'alert', blocking: false, pinned: false });
    expect(send).not.toHaveBeenCalled();
    await t.req('PUT', '/api/push/preferences', {
      cookie: member.cookie,
      body: { allOrgs: true, categories: { desk_blocking: false } },
    });
    await raise({ addresseeUserId: member.id });
    expect(send).not.toHaveBeenCalled();
  });

  it('does not push a question that is still with an agent; pushes once when it is escalated to the desk', async () => {
    await subscribe(member);
    const id = await raise({ addresseeUserId: member.id, routedTo: 'agent' });
    expect(send).not.toHaveBeenCalled();
    const escalate = async (routedTo: 'agent' | 'manager') => {
      await ctx().store.append([
        {
          streamId: streamId.desk(id),
          event: {
            type: 'QuestionEscalated',
            payload: { deskItemId: id, routedTo, note: 'passed on' },
          } as never,
          actor: { kind: 'system', id: null } as never,
          scope: { orgId: owner.id, projectId: null, audience: 'org' },
        },
      ]);
      await ctx().services.push?.flush();
    };
    await escalate('agent');
    expect(send).not.toHaveBeenCalled();
    await escalate('manager');
    expect(sent()).toHaveLength(1);
    expect(sent()[0]?.payload.url).toBe(`/desk#desk-item-${id}`);
    await escalate('manager');
    expect(sent()).toHaveLength(1); // deduped
  });

  it('still pushes an approval desk item', async () => {
    await subscribe(member);
    await raise({ addresseeUserId: member.id, kind: 'approval', title: 'Approve the merge' });
    expect(sent()).toHaveLength(1);
  });

  it('never notifies the person who caused it', async () => {
    await subscribe(member);
    await raise({ addresseeUserId: member.id }, { kind: 'user', id: member.id });
    expect(send).not.toHaveBeenCalled();
  });

  it('routes platform bugs, deploy approvals and runner alerts to their categories', async () => {
    await subscribe(owner);
    await raise({ kind: 'alert', blocking: false, pinned: false, subkind: 'platform_bug', title: 'A bug' });
    await raise({ kind: 'approval', subkind: 'platform_deploy_approval', title: 'Deploy 1.2' });
    await raise({
      kind: 'alert',
      blocking: false,
      pinned: false,
      subkind: 'claude_auth_expired',
      addresseeUserId: owner.id,
      title: 'Login expired',
      data: { key: 'ws1' },
    });
    expect(sent().map((s) => s.payload.tag.split(':')[0])).toEqual([
      'platform_bugs',
      'platform_deploys',
      'runner_alerts',
    ]);
    // each category has its own switch
    send.mockClear();
    await t.req('PUT', '/api/push/preferences', {
      cookie: owner.cookie,
      body: { categories: { platform_bugs: false } },
    });
    await raise({
      kind: 'alert',
      blocking: false,
      pinned: false,
      subkind: 'platform_bug',
      title: 'Another bug',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('tells the Owner when a project budget is used up, once per month', async () => {
    await subscribe(owner);
    const proj = await t.req('POST', '/api/projects', {
      cookie: owner.cookie,
      body: { key: 'PUSH', name: 'Push' },
    });
    const projectId = proj.body.project.id as string;
    const reach = async () => {
      await ctx().store.append([
        {
          streamId: streamId.project(projectId),
          event: {
            type: 'ProjectBudgetThresholdReached',
            payload: { projectId, month: '2026-10', level: 'paused', spendMicros: 10, budgetMicros: 10 },
          },
          actor: { kind: 'system', id: null },
          scope: { orgId: owner.id, projectId, audience: 'project' },
        },
      ]);
      await ctx().services.push?.flush();
    };
    await reach();
    await reach();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]?.payload.title).toBe('Budget used up');
    expect(sent()[0]?.payload.url).toBe('/p/PUSH/board');
  });

  it('announces a runner that stays offline once, and again after it reconnected', async () => {
    await subscribe(owner);
    const wsId = randomUUID();
    await q(
      `INSERT INTO workstations (id, user_id, name, token_hash, status, paired_at, connected) VALUES ($1,$2,'Laptop',$3,'active',now(),false)`,
      [wsId, owner.id, randomUUID()],
    );
    const flip = async (type: 'WorkstationDisconnected' | 'WorkstationConnected') => {
      await ctx().store.append([
        {
          streamId: streamId.workstation(wsId),
          event: { type, payload: { workstationId: wsId } } as never,
          actor: { kind: 'system', id: null },
          scope: { orgId: owner.id, projectId: null, audience: 'org' },
        },
      ]);
      await ctx().services.push?.flush();
    };
    await flip('WorkstationDisconnected');
    await flip('WorkstationDisconnected');
    expect(sent()).toHaveLength(1);
    expect(sent()[0]?.payload.url).toBe('/workstations');
    await flip('WorkstationConnected');
    await flip('WorkstationDisconnected');
    expect(sent()).toHaveLength(2);
  });
});

describe('once per subject and quiet hours', () => {
  const notice = (over: Record<string, unknown> = {}) => ({
    category: 'desk_blocking' as const,
    subject: 'S1',
    state: 'open',
    title: 'T',
    body: 'B',
    url: '/desk',
    priority: 'normal' as const,
    orgId: owner.id,
    ...over,
  });

  it('sends the same subject and state once in 24 hours, again when the state changes or the window passed', async () => {
    await subscribe(member);
    expect(await notifyUsers(ctx(), [member.id], notice())).toEqual([member.id]);
    expect(await notifyUsers(ctx(), [member.id], notice())).toEqual([]);
    expect(await notifyUsers(ctx(), [member.id], notice({ state: 'changed' }))).toEqual([member.id]);
    expect(await notifyUsers(ctx(), [member.id], notice({ state: 'changed' }))).toEqual([]);
    t.clock.advance(25 * 3600_000);
    expect(await notifyUsers(ctx(), [member.id], notice({ state: 'changed' }))).toEqual([member.id]);
    expect(send).toHaveBeenCalledTimes(3);
    // another subject is independent
    expect(await notifyUsers(ctx(), [member.id], notice({ subject: 'S2' }))).toEqual([member.id]);
  });

  it('holds back normal notices in quiet hours and lets blocking ones through', async () => {
    await subscribe(member);
    await t.req('PUT', '/api/push/preferences', {
      cookie: member.cookie,
      body: { allOrgs: true, quietHours: { enabled: true, start: '00:00', end: '23:59' } },
    });
    await q(`UPDATE users SET timezone='UTC' WHERE id=$1`, [member.id]);
    expect(await notifyUsers(ctx(), [member.id], notice({ subject: 'Q1' }))).toEqual([]);
    expect(await notifyUsers(ctx(), [member.id], notice({ subject: 'Q2', priority: 'blocking' }))).toEqual([
      member.id,
    ]);
    // a held-back notice is not marked as sent: it goes out once the quiet hours are over
    await t.req('PUT', '/api/push/preferences', {
      cookie: member.cookie,
      body: { allOrgs: true, quietHours: { enabled: false, start: '00:00', end: '23:59' } },
    });
    expect(await notifyUsers(ctx(), [member.id], notice({ subject: 'Q1' }))).toEqual([member.id]);
  });

  it('computes quiet hours in the person own time zone, across midnight', () => {
    const q2 = { enabled: true, start: '22:00', end: '07:00' };
    const at = new Date('2026-10-18T23:30:00Z');
    expect(inQuietHours(q2, at, 'UTC')).toBe(true);
    expect(inQuietHours(q2, at, 'Africa/Johannesburg')).toBe(true); // 01:30 local
    expect(localMinutes(at, 'Africa/Johannesburg')).toBe(90);
    expect(inQuietHours(q2, at, 'America/New_York')).toBe(false); // 19:30 local
    expect(inQuietHours(q2, new Date('2026-10-18T12:00:00Z'), 'UTC')).toBe(false);
    expect(inQuietHours({ ...q2, enabled: false }, at, 'UTC')).toBe(false);
    expect(inQuietHours({ enabled: true, start: '08:00', end: '08:00' }, at, 'UTC')).toBe(false);
  });

  it('writes a body of at most 140 characters without code, paths or secrets', () => {
    const b = safeBody(
      'Run ```rm -rf /``` in /home/user/secret/dir now. token=abcd1234efgh5678 ' + 'x'.repeat(300),
    );
    expect(b.length).toBeLessThanOrEqual(140);
    expect(b).not.toMatch(/rm -rf|abcd1234|\/home\/pieter\/secret/);
  });
});

describe('web assets are served as the browser expects', () => {
  let dir: string;
  let web: TestApp;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aom-web-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>app</title>');
    writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
    for (const f of ['sw.js', 'manifest.webmanifest', 'offline.html'])
      cpSync(join(__dirname, '../../web/public', f), join(dir, f));
    web = await createTestApp({ reset: false, env: { AOM_SERVE_WEB: 'true', AOM_WEB_DIST: dir } });
  });
  afterAll(async () => {
    await web.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves sw.js as javascript, never cached, allowed to control the whole origin', async () => {
    const r = await web.req('GET', '/sw.js');
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toMatch(/javascript/);
    expect(String(r.headers['cache-control'])).toMatch(/no-cache|no-store/);
    expect(r.headers['service-worker-allowed']).toBe('/');
  });

  it('serves the manifest with its own content type, without a session', async () => {
    const r = await web.req('GET', '/manifest.webmanifest');
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toMatch(/application\/manifest\+json/);
    expect(r.body.name).toBe('Guildwise');
    expect(r.body.display).toBe('standalone');
    expect(r.body.scope).toBe('/');
    const sizes = r.body.icons.map((i: any) => `${i.sizes}:${i.purpose ?? 'any'}`);
    expect(sizes).toEqual(expect.arrayContaining(['192x192:any', '512x512:any', '512x512:maskable']));
  });

  it('keeps the SPA fallback for pages and 404 for api paths', async () => {
    expect(String((await web.req('GET', '/desk')).body)).toContain('<title>app</title>');
    expect((await web.req('GET', '/api/nope')).status).toBe(404);
  });
});
