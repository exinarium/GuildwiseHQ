import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RELAY_ROLE_TTL_MS } from '../src/webhook-relay/hub.ts';
import { PASSWORD, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { FakeRunner } from './helpers/fake-runner.ts';
import { autoReply, createIntegration, type Made, makeBusiness, serve } from './helpers/relay.ts';
import {
  createWorld,
  MOCK_RUNTIME,
  ok,
  pairWorkstation,
  REPO_SSH,
  until,
  type World,
} from './helpers/world.ts';

const lines: string[] = [];
const logStream = { write: (line: string) => void lines.push(line) };

let w: World;
beforeAll(async () => {
  w = await createWorld({
    env: {
      AOM_FIRST_RUN_HIRE_CAP: 'false',
      LOG_LEVEL: 'info',
      AOM_RELAY_RATE_BURST: '100',
      AOM_RELAY_RATE_PER_MINUTE: '6000',
    },
    logStream,
  });
  await makeBusiness(w);
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});
beforeEach(async () => {
  await q('TRUNCATE relay_requests, relay_presence, relay_integrations CASCADE');
  lines.length = 0;
});

const ORG = () => w.owner.id;
const hub = () => w.t.app.ctx.services.webhookRelay;
const post = (path: string, payload: string) => w.t.app.inject({ method: 'POST', url: path, payload });
const asOwner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, headers: { 'x-aom-org': ORG() }, body });

interface Admin {
  id: string;
  cookie: string;
  runner: FakeRunner;
  seen: any[];
  workstationId: string;
}

/** An org admin with their own workstation, whose runner serves `m`. */
async function adminServing(m: Made): Promise<Admin> {
  const s = await w.t.userSession(uniqueEmail('adm'));
  await w.t.addOrgMember(ORG(), s.id, 'admin');
  const ws = await pairWorkstation(w.t, s, 'adm-box');
  const runner = await FakeRunner.connect(w.baseUrl, ws.runnerToken);
  runner.hello({
    repos: [{ remoteUrl: REPO_SSH, localPath: '/tmp/toy-adm', headBranch: 'main' }],
    runtimes: MOCK_RUNTIME,
  });
  await runner.waitFor('welcome');
  await w.t.app.ctx.notifier.flush();
  const seen = autoReply(runner, () => ({ status: 200, body: 'ok' }));
  const res = await serve(runner, [{ integrationId: m.integration.id, kind: m.integration.kind }]);
  expect(res.accepted).toEqual([m.integration.id]);
  return { ...s, runner, seen, workstationId: ws.workstationId };
}

const setRole = (a: Admin, role: string) =>
  q(`UPDATE org_members SET role=$3 WHERE org_id=$1 AND user_id=$2`, [ORG(), a.id, role]);
const asMember = (a: Admin, method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: a.cookie, headers: { 'x-aom-org': ORG() }, body });

describe('dropServers', () => {
  it('drops only the named user: the other admin keeps serving and receiving', async () => {
    const m = await createIntegration(w);
    const a = await adminServing(m);
    const b = await adminServing(m);
    expect(hub().isServed(m.integration.id)).toBe(2);
    await hub().dropServers(ORG(), a.id, 'role_changed');
    expect(hub().isServed(m.integration.id)).toBe(1);
    for (let i = 0; i < 3; i++) expect((await post(m.path, 'x')).statusCode).toBe(200);
    expect(a.seen).toHaveLength(0);
    expect(b.seen).toHaveLength(3);
    a.runner.close();
    b.runner.close();
  });

  it('the only server: in-flight requests end as offline at once, the integration is offline, the socket stays open', async () => {
    const m = await createIntegration(w);
    const a = await adminServing(m);
    a.seen.length = 0;
    a.runner.ws.removeAllListeners('message'); // holds its answer
    const held = post(m.path, 'x');
    await until(async () => hub().inFlight === 1);
    await hub().dropServers(ORG(), a.id, 'member_removed');
    expect((await held).statusCode).toBe(503);
    expect(hub().inFlight).toBe(0);
    expect(hub().isServed(m.integration.id)).toBe(0);
    expect(a.runner.ws.readyState).toBe(1);
    a.runner.close();
  });

  it('logs org, user, runner and reason, and nothing of the request', async () => {
    const m = await createIntegration(w);
    const a = await adminServing(m);
    await hub().dropServers(ORG(), a.id, 'member_left');
    const entry = lines.map((l) => JSON.parse(l)).find((l) => l.msg === 'relay server dropped');
    expect(entry.relayDrop).toMatchObject({
      orgId: ORG(),
      userId: a.id,
      workstationId: a.workstationId,
      reason: 'member_left',
    });
    expect(Object.keys(entry.relayDrop).sort()).toEqual(
      ['integrationIds', 'orgId', 'reason', 'userId', 'workstationId'].sort(),
    );
    a.runner.close();
  });
});

describe('membership events', () => {
  it('removing the admin through the API stops relay to them without a reconnect', async () => {
    const m = await createIntegration(w);
    const a = await adminServing(m);
    await ok(asOwner('DELETE', `/api/org/members/${a.id}`));
    await w.t.app.ctx.notifier.flush();
    expect(hub().isServed(m.integration.id)).toBe(0);
    expect((await post(m.path, 'x')).statusCode).toBe(503);
    expect(a.seen).toHaveLength(0);
    expect(a.runner.ws.readyState).toBe(1);
    expect(lines.some((l) => l.includes('relay server dropped') && l.includes('member_removed'))).toBe(true);
    a.runner.close();
  });

  it('demoting the admin to member drops them; promoting back lets relay.serve be accepted again', async () => {
    const m = await createIntegration(w);
    const a = await adminServing(m);
    await ok(asOwner('PATCH', `/api/org/members/${a.id}`, { role: 'member' }));
    await w.t.app.ctx.notifier.flush();
    expect(hub().isServed(m.integration.id)).toBe(0);
    const refused = await serve(a.runner, [{ integrationId: m.integration.id, kind: m.integration.kind }]);
    expect(refused.refused[0]?.reason).toBe('not_allowed');
    await ok(asOwner('PATCH', `/api/org/members/${a.id}`, { role: 'admin' }));
    await w.t.app.ctx.notifier.flush();
    const again = await serve(a.runner, [{ integrationId: m.integration.id, kind: m.integration.kind }]);
    expect(again.accepted).toEqual([m.integration.id]);
    expect((await post(m.path, 'x')).statusCode).toBe(200);
    a.runner.close();
  });

  it('leaving the org drops the runner', async () => {
    const m = await createIntegration(w);
    const a = await adminServing(m);
    await ok(asMember(a, 'DELETE', '/api/org/members/me'));
    await w.t.app.ctx.notifier.flush();
    expect(hub().isServed(m.integration.id)).toBe(0);
    expect(lines.some((l) => l.includes('relay server dropped') && l.includes('member_left'))).toBe(true);
    a.runner.close();
  });

  it('ownership transfer: the old owner stays admin and keeps serving', async () => {
    const m = await createIntegration(w);
    const a = await adminServing(m);
    await ok(asOwner('POST', '/api/org/transfer-ownership', { userId: a.id, password: PASSWORD }));
    await w.t.app.ctx.notifier.flush();
    expect(hub().isServed(m.integration.id)).toBe(1);
    expect((await post(m.path, 'x')).statusCode).toBe(200);
    // hand ownership back so the other tests keep their owner
    await ok(asMember(a, 'POST', '/api/org/transfer-ownership', { userId: w.owner.id, password: PASSWORD }));
    await w.t.app.ctx.notifier.flush();
    expect(hub().isServed(m.integration.id)).toBe(1);
    a.runner.close();
  });

  it('a control event for another member leaves the serving runner alone', async () => {
    const m = await createIntegration(w);
    const a = await adminServing(m);
    const other = await w.t.userSession(uniqueEmail('oth'));
    await w.t.addOrgMember(ORG(), other.id, 'member');
    await ok(asOwner('PATCH', `/api/org/members/${other.id}`, { role: 'admin' }));
    await ok(asOwner('DELETE', `/api/org/members/${other.id}`));
    await w.t.app.ctx.notifier.flush();
    expect(hub().isServed(m.integration.id)).toBe(1);
    expect((await post(m.path, 'x')).statusCode).toBe(200);
    a.runner.close();
  });

  it('a platform admin deactivating the user drops the runner', async () => {
    const m = await createIntegration(w);
    const a = await adminServing(m);
    const root = await w.t.superAdminSession();
    await ok(
      w.t.req('POST', `/api/platform/orgs/${a.id}/suspend`, {
        cookie: root.cookie,
        body: { reason: 'leaving' },
      }),
    );
    await ok(
      w.t.req('PATCH', `/api/platform/users/${a.id}`, {
        cookie: root.cookie,
        body: { status: 'deactivated' },
      }),
    );
    await w.t.app.ctx.notifier.flush();
    expect(hub().isServed(m.integration.id)).toBe(0);
    expect(lines.some((l) => l.includes('relay server dropped') && l.includes('user_disabled'))).toBe(true);
    a.runner.close();
  });
});

describe('forward-time guard', () => {
  it('a role changed straight in the database is caught once the cache window ends, and the user is dropped', async () => {
    const m = await createIntegration(w);
    const a = await adminServing(m);
    expect((await post(m.path, 'x')).statusCode).toBe(200); // fills the cache
    await setRole(a, 'member'); // no event
    expect((await post(m.path, 'x')).statusCode).toBe(200); // within the window
    w.t.clock.advance(RELAY_ROLE_TTL_MS);
    expect((await post(m.path, 'x')).statusCode).toBe(503);
    expect(a.seen).toHaveLength(2);
    expect(hub().isServed(m.integration.id)).toBe(0);
    expect(lines.some((l) => l.includes('relay server dropped') && l.includes('forward_check_failed'))).toBe(
      true,
    );
    a.runner.close();
  });

  it('an event clears the cache: the very next request is refused without advancing the clock', async () => {
    const m = await createIntegration(w);
    const a = await adminServing(m);
    expect((await post(m.path, 'x')).statusCode).toBe(200);
    await ok(asOwner('PATCH', `/api/org/members/${a.id}`, { role: 'member' }));
    await w.t.app.ctx.notifier.flush();
    expect((await post(m.path, 'x')).statusCode).toBe(503);
    expect(a.seen).toHaveLength(1);
    a.runner.close();
  });

  it('a burst on a cold cache makes one role lookup per user', async () => {
    const m = await createIntegration(w);
    const a = await adminServing(m);
    w.t.clock.advance(RELAY_ROLE_TTL_MS);
    const pool = w.t.app.ctx.pool;
    const orig = pool.query.bind(pool);
    let lookups = 0;
    (pool as any).query = (text: any, ...rest: any[]) => {
      if (typeof text === 'string' && text.includes('FROM org_members') && text.includes('role')) lookups++;
      return (orig as any)(text, ...rest);
    };
    try {
      const rs = await Promise.all(Array.from({ length: 10 }, () => post(m.path, 'x')));
      expect(rs.map((r) => r.statusCode).filter((s) => s === 200).length).toBeGreaterThan(0);
      expect(lookups).toBe(1);
    } finally {
      (pool as any).query = orig;
    }
    a.runner.close();
  });
});
