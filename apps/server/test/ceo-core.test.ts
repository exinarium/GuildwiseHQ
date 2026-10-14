import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

describe('the CEO is appointed once per organization', () => {
  it('has no CEO at first and the status says so', async () => {
    const s = await ok<any>(owner('GET', '/api/ceo/status'));
    expect(s).toMatchObject({ hired: false, state: 'none', isOwner: true });
    expect(s.workstations.map((x: any) => x.id)).toContain(w.workstationId);
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

  it('appoint creates the agent, the default policy and a training period', async () => {
    const res = await ok<any>(
      owner('POST', '/api/ceo/appoint', { workstationId: w.workstationId, name: 'Ada Prime' }),
      201,
    );
    const a = (await q(`SELECT * FROM agents WHERE id=$1`, [res.agentId]))[0]!;
    expect(a.role_key).toBe('ceo');
    expect(a.seniority).toBe('senior');
    const s = await ok<any>(owner('GET', '/api/ceo/status'));
    expect(s.hired).toBe(true);
    expect(s.training.on).toBe(true);
    expect(s.training.daysLeft).toBe(14);
    expect(s.agent.name).toBe('Ada Prime');
    const pol = await ok<any>(owner('GET', '/api/ceo/policy'));
    expect(pol.policy.classes['agent.hire'].mode).toBe('decide');
    expect(pol.canEdit).toBe(true);
  });

  it('a second CEO is refused, and the CEO cannot be fired', async () => {
    expect((await owner('POST', '/api/ceo/appoint', { workstationId: w.workstationId })).status).toBe(409);
    const id = (await q(`SELECT id FROM agents WHERE role_key='ceo'`))[0]!.id;
    const fire = await owner('POST', `/api/agents/${id}/fire`);
    expect(fire.status).toBe(409);
    expect(fire.body.error?.code ?? fire.body.code).toBe('ceo_cannot_be_fired');
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
