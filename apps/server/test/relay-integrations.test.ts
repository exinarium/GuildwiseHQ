import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { FakeRunner } from './helpers/fake-runner.ts';
import { createIntegration, makeBusiness, serve } from './helpers/relay.ts';
import { createWorld, ok, pairWorkstation, until, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  await makeBusiness(w);
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});
beforeEach(async () => {
  await q('TRUNCATE relay_requests, relay_presence, relay_integrations CASCADE');
  await q(`DELETE FROM events WHERE false`);
});

const hit = (path: string) => w.t.app.inject({ method: 'GET', url: path });
const memberSession = async (role: 'member' | 'admin') => {
  const email = uniqueEmail('m');
  const id = await w.t.createUser(email, 'member');
  await w.t.addOrgMember(w.owner.id, id, role);
  const cookie = await w.t.login(email);
  return { id, cookie };
};

describe('relay integrations API', () => {
  it('creates an integration and returns the URL once; only the hash is stored', async () => {
    const m = await createIntegration(w, 'whatsapp_cloud', 'WhatsApp shop');
    expect(m.integration).toMatchObject({ kind: 'whatsapp_cloud', label: 'WhatsApp shop', status: 'active' });
    expect(m.url).toMatch(/^http:\/\/aom\.test\/relay\/in\/rly_[A-Za-z0-9_-]{32}$/);
    const token = m.path.replace('/relay/in/', '');
    const [row] = await q('SELECT * FROM relay_integrations WHERE id=$1', [m.integration.id]);
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(token);
    const events = await q(`SELECT payload FROM events WHERE stream_id=$1`, [`relay-${m.integration.id}`]);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(token);
    // the list never carries a URL
    const list = await ok<any>(w.t.req('GET', '/api/relay/integrations', { cookie: w.owner.cookie }));
    expect(list.integrations).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(token);
    expect(JSON.stringify(list)).not.toContain('/relay/in/');
  });

  it('gives every integration its own unguessable token', async () => {
    const a = await createIntegration(w);
    const b = await createIntegration(w);
    expect(a.path).not.toBe(b.path);
  });

  it('refuses a provider secret in the body, an unknown kind and an empty label', async () => {
    for (const body of [
      { kind: 'whatsapp_cloud', label: 'x', appSecret: 's' },
      { kind: 'whatsapp_cloud', label: 'x', verifyToken: 's' },
      { kind: 'sms', label: 'x' },
      { kind: 'generic', label: '  ' },
    ]) {
      const r = await w.t.req('POST', '/api/relay/integrations', { cookie: w.owner.cookie, body });
      expect(r.status).toBe(400);
    }
    expect(await q('SELECT 1 FROM relay_integrations')).toHaveLength(0);
  });

  it('refuses a plain member and lets an admin manage; any member reads', async () => {
    const member = await memberSession('member');
    const admin = await memberSession('admin');
    const org = { 'x-aom-org': w.owner.id };
    const denied = await w.t.req('POST', '/api/relay/integrations', {
      cookie: member.cookie,
      headers: org,
      body: { kind: 'generic', label: 'x' },
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('org_role_required');
    const made = await ok<any>(
      w.t.req('POST', '/api/relay/integrations', {
        cookie: admin.cookie,
        headers: org,
        body: { kind: 'generic', label: 'by admin' },
      }),
      201,
    );
    for (const path of ['/api/relay/integrations', '/api/relay/integrations/status'])
      expect((await w.t.req('GET', path, { cookie: member.cookie, headers: org })).status).toBe(200);
    for (const action of ['rotate', 'revoke'])
      expect(
        (
          await w.t.req('POST', `/api/relay/integrations/${made.integration.id}/${action}`, {
            cookie: member.cookie,
            headers: org,
          })
        ).status,
      ).toBe(403);
  });

  it('refuses an organization that is not in Business mode', async () => {
    const email = uniqueEmail('dev');
    await w.t.createUser(email, 'member');
    const cookie = await w.t.login(email);
    const r = await w.t.req('POST', '/api/relay/integrations', {
      cookie,
      body: { kind: 'generic', label: 'x' },
    });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('business_mode_required');
    for (const path of ['/api/relay/integrations', '/api/relay/integrations/status'])
      expect((await w.t.req('GET', path, { cookie })).body.error.code).toBe('business_mode_required');
  });

  it('answers 404 for another organization or an unknown integration id', async () => {
    const other = await w.t.userSession(uniqueEmail('o'));
    const m = await createIntegration(w);
    for (const action of ['rotate', 'revoke']) {
      const r = await w.t.req('POST', `/api/relay/integrations/${m.integration.id}/${action}`, {
        cookie: other.cookie,
      });
      expect([403, 404]).toContain(r.status);
    }
    // an admin of the business org, with an id that is not there
    const r = await w.t.req('POST', '/api/relay/integrations/0198f2a0-0000-7000-8000-000000000009/rotate', {
      cookie: w.owner.cookie,
    });
    expect(r.status).toBe(404);
    expect(
      (await q('SELECT status FROM relay_integrations WHERE id=$1', [m.integration.id]))[0]?.status,
    ).toBe('active');
  });

  it('rotate returns a new URL and the old one answers 404 with an empty body', async () => {
    const m = await createIntegration(w);
    const rot = await ok<any>(
      w.t.req('POST', `/api/relay/integrations/${m.integration.id}/rotate`, { cookie: w.owner.cookie }),
    );
    const next = new URL(rot.url).pathname;
    expect(next).not.toBe(m.path);
    expect(rot.integration.rotatedAt).not.toBeNull();
    const old = await hit(m.path);
    expect(old.statusCode).toBe(404);
    expect(old.body).toBe('');
    // the new one is known: with no runner it is a 503, not a 404
    expect((await hit(next)).statusCode).toBe(503);
  });

  it('revoke makes the URL answer 404, and a revoked integration cannot be rotated or revoked again', async () => {
    const m = await createIntegration(w);
    const rev = await ok<any>(
      w.t.req('POST', `/api/relay/integrations/${m.integration.id}/revoke`, { cookie: w.owner.cookie }),
    );
    expect(rev.integration.status).toBe('revoked');
    expect(rev.integration.revokedAt).not.toBeNull();
    const res = await hit(m.path);
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe('');
    const [row] = await q('SELECT token_hash FROM relay_integrations WHERE id=$1', [m.integration.id]);
    expect(row?.token_hash).toBeNull();
    for (const action of ['rotate', 'revoke']) {
      const r = await w.t.req('POST', `/api/relay/integrations/${m.integration.id}/${action}`, {
        cookie: w.owner.cookie,
      });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('revoked');
    }
  });

  it('a replay of the events gives the same integrations and keeps the presence rows', async () => {
    const m = await createIntegration(w);
    const r = await w.connectRunner();
    await serve(r, [{ integrationId: m.integration.id, kind: 'generic' }]);
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    await makeBusiness(w); // the mode was set straight in the table, so a replay gives the default back
    const [row] = await q('SELECT status, kind FROM relay_integrations WHERE id=$1', [m.integration.id]);
    expect(row).toMatchObject({ status: 'active', kind: 'generic' });
    expect(await q('SELECT 1 FROM relay_presence WHERE integration_id=$1', [m.integration.id])).toHaveLength(
      1,
    );
    expect((await hit(m.path)).statusCode).not.toBe(404);
    r.ws.close();
  });
});

describe('relay announcements (relay.serve)', () => {
  it('welcome announces the relay feature', async () => {
    const r = await w.connectRunner();
    const welcome = await r.waitFor('welcome');
    expect(welcome.features).toContain('relay:1');
    r.ws.close();
  });

  it('accepts an integration of an owner or admin, refuses unknown, revoked and mismatched kinds', async () => {
    const good = await createIntegration(w, 'generic');
    const gone = await createIntegration(w, 'generic');
    await ok(
      w.t.req('POST', `/api/relay/integrations/${gone.integration.id}/revoke`, { cookie: w.owner.cookie }),
    );
    const wrong = await createIntegration(w, 'generic');
    const r = await w.connectRunner();
    const res = await serve(r, [
      { integrationId: good.integration.id, kind: 'generic' },
      { integrationId: gone.integration.id, kind: 'generic' },
      { integrationId: '0198f2a0-0000-7000-8000-000000000009', kind: 'generic' },
      { integrationId: wrong.integration.id, kind: 'webhook_in' },
    ]);
    expect(res.accepted).toEqual([good.integration.id]);
    expect(res.refused.map((x) => x.reason).sort()).toEqual(['kind_mismatch', 'revoked', 'unknown']);
    r.ws.close();
  });

  it('refuses a runner of a user who is only a member of the organization', async () => {
    const m = await createIntegration(w);
    const member = await w.t.userSession(uniqueEmail('rm'));
    await w.t.addOrgMember(w.owner.id, member.id, 'member');
    const { runnerToken } = await pairWorkstation(w.t, member, 'Other');
    const r = await FakeRunner.connect(w.baseUrl, runnerToken);
    r.hello();
    await r.waitFor('welcome');
    const res = await serve(r, [{ integrationId: m.integration.id, kind: 'generic' }]);
    expect(res.accepted).toEqual([]);
    expect(res.refused).toEqual([{ integrationId: m.integration.id, reason: 'not_allowed' }]);
    r.ws.close();
  });
});

describe('integration status API', () => {
  const statusOf = async (id: string) =>
    (
      await ok<any>(w.t.req('GET', '/api/relay/integrations/status', { cookie: w.owner.cookie }))
    ).statuses.find((s: any) => s.integrationId === id);

  it('shows connected, then offline since, the refused count and time, and clears on reconnect', async () => {
    const m = await createIntegration(w);
    expect(await statusOf(m.integration.id)).toMatchObject({
      connected: false,
      everServed: false,
      offlineSince: null,
      refusedSinceOffline: { count: 0, lastAt: null },
    });

    const r = await w.connectRunner();
    await serve(r, [{ integrationId: m.integration.id, kind: 'generic' }]);
    expect(await statusOf(m.integration.id)).toMatchObject({
      connected: true,
      servingWorkstations: 1,
      everServed: true,
      offlineSince: null,
    });

    r.ws.close();
    await until(async () => (await statusOf(m.integration.id))?.connected === false || null);
    await until(async () => (await statusOf(m.integration.id))?.offlineSince || null);
    expect((await hit(m.path)).statusCode).toBe(503);
    expect((await hit(m.path)).statusCode).toBe(503);
    const off = await statusOf(m.integration.id);
    expect(off.connected).toBe(false);
    expect(off.refusedSinceOffline.count).toBe(2);
    expect(off.refusedSinceOffline.lastAt).not.toBeNull();

    const r2 = await w.connectRunner();
    await serve(r2, [{ integrationId: m.integration.id, kind: 'generic' }]);
    expect(await statusOf(m.integration.id)).toMatchObject({ connected: true, offlineSince: null });
    r2.ws.close();
  });

  it('does not list revoked integrations', async () => {
    const m = await createIntegration(w);
    await ok(
      w.t.req('POST', `/api/relay/integrations/${m.integration.id}/revoke`, { cookie: w.owner.cookie }),
    );
    expect(await statusOf(m.integration.id)).toBeUndefined();
  });
});
