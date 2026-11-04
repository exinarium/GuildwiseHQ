import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkAgentMove } from '../src/commands/sharing.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, markOnline, pairWorkstation, type World } from './helpers/world.ts';

let w: World;
let orgId: string;
let second: string;
let n = 0;

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  orgId = (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]!.org_id;
  await markOnline(w.t, w.workstationId);
  second = (await pairWorkstation(w.t, w.owner, 'second')).workstationId;
  await markOnline(w.t, second);
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const req = (workstationId: string) => ({
  workstationId,
  runtime: 'mock',
  model: 'mock',
  acknowledgeUnsandboxed: false,
});
const check = async (agentId: string, workstationId: string) => {
  const a = (await q('SELECT * FROM agents WHERE id=$1', [agentId]))[0]!;
  return checkAgentMove(w.t.app.ctx, w.t.app.ctx.pool, { userId: w.owner.id }, a, req(workstationId));
};
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e: any) {
    return e.code ?? e.message;
  }
};
const eventCount = async () => Number((await q('SELECT count(*)::int AS c FROM events'))[0]!.c);

describe('checkAgentMove', () => {
  it('returns the target for a valid move and writes nothing', async () => {
    const a = await w.hire(`Check${++n}`, 'builder', 'junior');
    const before = await eventCount();
    const plan = await check(a.id, second);
    expect(plan.w.id).toBe(second);
    expect(await eventCount()).toBe(before);
  });

  it('throws the same codes as the move for each rule', async () => {
    const a = await w.hire(`Check${++n}`, 'builder', 'junior');
    expect(await code(check(a.id, w.workstationId))).toBe('same_workstation');
    expect(await code(check(a.id, '00000000-0000-4000-8000-000000000001'))).toBe('workstation_not_found');
    await q(
      `INSERT INTO shifts (id, org_id, agent_id, workstation_id, kind, status, runtime, model, started_at)
       VALUES ($1,$2,$3,$4,'chat','running','mock','mock',now())`,
      [crypto.randomUUID(), orgId, a.id, w.workstationId],
    );
    expect(await code(check(a.id, second))).toBe('agent_busy');
    await q(`UPDATE agents SET status='retired' WHERE id=$1`, [a.id]);
    expect(await code(check(a.id, second))).toBe('agent_retired');
  });
});
