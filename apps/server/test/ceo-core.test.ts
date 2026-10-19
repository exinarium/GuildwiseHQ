import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appoint } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  r = await w.connectRunner({ capabilities: ['ceo:1'] });
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });

describe('the CEO is built in, one per organization', () => {
  it('the appoint, disable and training routes are gone', async () => {
    for (const path of ['/api/ceo/appoint', '/api/ceo/disable', '/api/ceo/training'])
      expect((await owner('POST', path, { workstationId: w.workstationId })).status, path).toBe(404);
  });

  it('cannot be hired through the normal hire form', async () => {
    const res = await owner('POST', '/api/agents', {
      name: 'Boss',
      roleKey: 'ceo',
      seniority: 'senior',
      workstationId: w.workstationId,
      runtime: 'mock',
      model: 'mock',
    });
    expect(res.status).toBe(400);
  });

  it('is created with the default policy and no training period, and is free of limits', async () => {
    const agentId = await appoint(w, 'Ada Prime');
    const a = (await q(`SELECT * FROM agents WHERE id=$1`, [agentId]))[0]!;
    expect(a).toMatchObject({ role_key: 'ceo', seniority: 'senior', is_builtin: true, is_devops: false });
    const s = await ok<any>(owner('GET', '/api/ceo/status'));
    expect(s.hired).toBe(true);
    expect(s.training).toBeUndefined();
    expect(s.agent.name).toBe('Ada Prime');
    const pol = await ok<any>(owner('GET', '/api/ceo/policy'));
    expect(pol.policy.classes['agent.hire'].mode).toBe('decide');
    expect(pol.canEdit).toBe(true);
    const { orgUsage } = await import('../src/orgs/limits.ts');
    expect((await orgUsage(w.t.app.ctx.pool, w.owner.id)).agents).toBe(
      Number(
        (await q(`SELECT count(*) AS n FROM agents WHERE NOT is_builtin AND status <> 'retired'`))[0]!.n,
      ),
    );
  });

  it('a second CEO is not created, and the CEO cannot be fired', async () => {
    const { ceoProvisionEvents } = await import('../src/ceo/provision.ts');
    expect(await ceoProvisionEvents(w.t.app.ctx.pool, w.t.app.ctx, w.owner.id, w.owner.id)).toEqual([]);
    const id = (await q(`SELECT id FROM agents WHERE role_key='ceo'`))[0]!.id;
    const fire = await owner('POST', `/api/agents/${id}/fire`);
    expect(fire.status).toBe(409);
    expect(fire.body.error?.code ?? fire.body.code).toBe('builtin_agent');
    // the database holds the same rule: one live CEO per organization
    await expect(
      q(
        `INSERT INTO agents (id, org_id, hired_by_user_id, manager_user_id, name, role_key, role_version, seniority, runtime, model, status, hired_at)
         VALUES (gen_random_uuid(), $1, $1, $1, 'Second', 'ceo', 1, 'senior', 'mock', 'mock', 'active', now())`,
        [w.owner.id],
      ),
    ).rejects.toThrow();
  });

  it('Admins read but only the Owner configures', async () => {
    const admin = await w.t.userSession(`admin-${Date.now()}@example.test`);
    await q(
      `INSERT INTO org_members (org_id, user_id, role, status, joined_at) VALUES ($1,$2,'admin','active',now())`,
      [w.owner.id, admin.id],
    );
    const get = await w.t.req('GET', '/api/ceo/status', {
      cookie: admin.cookie,
      headers: { 'x-aom-org': w.owner.id },
    });
    expect(get.status).toBe(200);
    const put = await w.t.req('PUT', '/api/ceo/settings', {
      cookie: admin.cookie,
      headers: { 'x-aom-org': w.owner.id },
      body: { standingInstructions: 'x' },
    });
    expect(put.status).toBe(403);
  });
});
