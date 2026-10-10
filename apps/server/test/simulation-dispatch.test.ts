import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, markOnline, ok, pairWorkstation, type World } from './helpers/world.ts';

/** In a simulation organization real workstations receive no work; only its simulated workstation does. */
let w: World;
let root: { id: string; email: string; cookie: string };

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  root = await w.t.superAdminSession();
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('real workstations in a simulation organization', () => {
  it('receive no work, and the simulated workstation does', async () => {
    const orgId = w.owner.id;
    const real = await w.hire('Bea', 'builder', 'junior');
    await w.hire('Rex', 'reviewer', 'senior');
    await w.hire('Tess', 'tester', 'junior');
    await markOnline(w.t, w.workstationId, { repoIds: [w.repoId] });

    // before: a real organization dispatches to its real workstation
    const card = await w.card({ title: 'Real first' });
    const before = await w.t.app.ctx.services.dispatcher.runPass();
    expect(before.map((c) => c.cardId)).toContain(card.id);

    // finish that shift's claim so the next card is free to move
    await q(
      `UPDATE cards SET claim_id=NULL, claimed_by_agent_id=NULL, claim_shift_id=NULL, claim_workstation_id=NULL, home_workstation_id=NULL, status='queued' WHERE id=$1`,
      [card.id],
    );

    const on = await w.t.req('PUT', `/api/platform/orgs/${orgId}/simulation`, {
      cookie: root.cookie,
      body: { enabled: true },
    });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    const after = await w.t.app.ctx.services.dispatcher.runPass();
    expect(after.map((c) => c.agentId)).not.toContain(real.agent?.id ?? real.id);
    expect(after).toEqual([]);
    expect((await q('SELECT status FROM cards WHERE id=$1', [card.id]))[0]!.status).toBe('queued');

    // a simulated workstation of this organization is dispatched to
    const sim = await pairWorkstation(w.t, w.owner, 'Sim');
    await q('UPDATE workstations SET simulation_org_id=$2 WHERE id=$1', [sim.workstationId, orgId]);
    await markOnline(w.t, sim.workstationId, { repoIds: [w.repoId] });
    const simBuilder = await ok<any>(
      w.t.req('POST', '/api/agents', {
        cookie: w.owner.cookie,
        body: {
          name: 'Simon',
          roleKey: 'builder',
          seniority: 'junior',
          workstationId: sim.workstationId,
          runtime: 'mock',
          model: 'mock',
        },
      }),
      201,
    );
    const made = await w.t.app.ctx.services.dispatcher.runPass();
    expect(made.map((c) => c.cardId)).toContain(card.id);
    expect(made[0]?.workstationId).toBe(sim.workstationId);
    expect(simBuilder).toBeTruthy();
  });

  it('a simulated workstation never serves another organization', async () => {
    const other = await w.t.userSession(`o-${Math.random().toString(36).slice(2, 8)}@example.test`);
    const ws = await pairWorkstation(w.t, w.owner, 'Other sim');
    await q('UPDATE workstations SET simulation_org_id=$2 WHERE id=$1', [ws.workstationId, w.owner.id]);
    await markOnline(w.t, ws.workstationId);
    const hire = await w.t.req('POST', '/api/agents', {
      cookie: other.cookie,
      body: {
        name: 'Nope',
        roleKey: 'builder',
        seniority: 'junior',
        workstationId: ws.workstationId,
        runtime: 'mock',
        model: 'mock',
      },
    });
    // not a member of the simulation organization: it is simply not their workstation to use
    expect(hire.status).toBe(404);
  });
});
