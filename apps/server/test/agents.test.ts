import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, pairWorkstation, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ listen: false });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const hire = (body: Record<string, unknown>, cookie = w.owner.cookie) =>
  w.t.req('POST', '/api/agents', {
    cookie,
    body: { workstationId: w.workstationId, runtime: 'mock', model: 'mock', ...body },
  });

describe('hiring', () => {
  it('hires an agent with the role defaults', async () => {
    const r = await hire({ name: 'Ada', roleKey: 'builder', seniority: 'junior' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      name: 'Ada',
      roleKey: 'builder',
      roleVersion: 1,
      seniority: 'junior',
      status: 'active',
      capacity: 1,
      workstationId: w.workstationId,
      projectId: null,
      isDevops: false,
      runtime: 'mock',
    });
    expect(r.body.permissions.mayCommit).toBe(true);
    expect(r.body.activeCards).toEqual([]);
    const list = await ok<any>(w.t.req('GET', '/api/agents', { cookie: w.owner.cookie }));
    // The workstation's auto-hired DevOps engineer is listed too (M3).
    expect(list.agents.filter((a: any) => !a.isDevops).map((a: any) => a.name)).toEqual(['Ada']);
    expect(list.agents.filter((a: any) => a.isDevops)).toHaveLength(1);
  });

  it('validates role, seniority, devops and workstation ownership', async () => {
    expect((await hire({ name: 'X1', roleKey: 'nope', seniority: 'junior' })).body.error.code).toBe(
      'unknown_role',
    );
    expect((await hire({ name: 'X2', roleKey: 'reviewer', seniority: 'junior' })).body.error.code).toBe(
      'invalid_seniority',
    );
    expect((await hire({ name: 'X3', roleKey: 'devops', seniority: 'junior' })).status).toBe(400);
    const other = await w.t.userSession(uniqueEmail('o'));
    const theirs = await pairWorkstation(w.t, other);
    expect(
      (
        await hire({
          name: 'X4',
          roleKey: 'builder',
          seniority: 'junior',
          workstationId: theirs.workstationId,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await w.t.req('POST', '/api/agents', {
          cookie: other.cookie,
          body: { name: 'X5', roleKey: 'builder', seniority: 'junior', workstationId: w.workstationId },
        })
      ).status,
    ).toBe(404);
  });

  it('keeps names unique per org (case-insensitive) including retired agents', async () => {
    expect((await hire({ name: 'ada', roleKey: 'builder', seniority: 'junior' })).status).toBe(409);
    const b = await hire({ name: 'Grace', roleKey: 'builder', seniority: 'senior' });
    expect(b.status).toBe(201);
    const fired = await w.t.req('POST', `/api/agents/${b.body.id}/fire`, { cookie: w.owner.cookie });
    expect(fired.status).toBe(200);
    expect(fired.body.agent.status).toBe('retired');
    const again = await hire({ name: 'Grace', roleKey: 'builder', seniority: 'senior' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('name_taken');
  });

  it('suggests names that skip used and retired names', async () => {
    const r = await ok<any>(
      w.t.req('GET', '/api/agents/name-suggestions?count=6', { cookie: w.owner.cookie }),
    );
    expect(r.names).toHaveLength(6);
    expect(r.names).not.toContain('Ada');
    expect(r.names).not.toContain('Grace');
    const birds = await ok<any>(
      w.t.req('GET', '/api/agents/name-suggestions?theme=birds&count=3', { cookie: w.owner.cookie }),
    );
    expect(birds.names).toEqual(['Heron', 'Kestrel', 'Wren']);
  });

  it('enforces the first-run cap: 2 builders, 1 of each other role (retired do not count)', async () => {
    // Ada is active, Grace retired: one more builder is fine, the next is capped.
    expect((await hire({ name: 'Linus', roleKey: 'builder', seniority: 'junior' })).status).toBe(201);
    const third = await hire({ name: 'Barbara', roleKey: 'builder', seniority: 'junior' });
    expect(third.status).toBe(409);
    expect(third.body.error.code).toBe('hire_cap_reached');
    expect((await hire({ name: 'Rev1', roleKey: 'reviewer', seniority: 'senior' })).status).toBe(201);
    expect((await hire({ name: 'Rev2', roleKey: 'reviewer', seniority: 'senior' })).status).toBe(409);
    expect((await hire({ name: 'Tess', roleKey: 'tester', seniority: 'junior' })).status).toBe(201);
    expect((await hire({ name: 'Tess2', roleKey: 'tester', seniority: 'junior' })).status).toBe(409);
  });

  it('patches an agent and refuses changes by strangers', async () => {
    const list = await ok<any>(w.t.req('GET', '/api/agents', { cookie: w.owner.cookie }));
    const ada = list.agents.find((a: any) => a.name === 'Ada');
    const p = await w.t.req('PATCH', `/api/agents/${ada.id}`, {
      cookie: w.owner.cookie,
      body: { model: 'other', capacity: 2 },
    });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ model: 'other', capacity: 2 });
    const stranger = await w.t.userSession(uniqueEmail('s'));
    expect(
      (await w.t.req('PATCH', `/api/agents/${ada.id}`, { cookie: stranger.cookie, body: { model: 'x' } }))
        .status,
    ).toBe(404);
    expect((await w.t.req('POST', `/api/agents/${ada.id}/fire`, { cookie: stranger.cookie })).status).toBe(
      404,
    );
    expect((await w.t.req('GET', '/api/agents', { cookie: stranger.cookie })).body.agents).toEqual([]);
  });

  it('queues agent.wipe for the workstation when firing', async () => {
    const rows = await q(`SELECT type, payload FROM runner_commands WHERE type='agent.wipe'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.agentId).toBeTruthy();
  });
});

describe('without the first-run cap', () => {
  it('allows more builders', async () => {
    await w.t.close();
    const t2 = await createTestApp({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' }, reset: true });
    try {
      const s = await t2.userSession(uniqueEmail('capless'));
      const { workstationId } = await pairWorkstation(t2, s);
      for (const n of ['A1', 'A2', 'A3']) {
        const r = await t2.req('POST', '/api/agents', {
          cookie: s.cookie,
          body: { name: n, roleKey: 'builder', seniority: 'junior', workstationId },
        });
        expect(r.status).toBe(201);
      }
    } finally {
      await t2.close();
    }
    w = await createWorld({ listen: false });
  });
});
