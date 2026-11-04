import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkAgentMove } from '../src/commands/sharing.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, markOnline, ok, pairWorkstation, type Session, type World } from './helpers/world.ts';

let w: World;
let orgId: string;
let adminS: Session & { workstationId: string };
let memberS: Session & { workstationId: string };
let outsider: Session & { workstationId: string };
let second: string;
let n = 0;

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  orgId = (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]!.org_id;
  await markOnline(w.t, w.workstationId);
  second = (await pairWorkstation(w.t, w.owner, 'second')).workstationId;
  await markOnline(w.t, second);
  const a = await w.t.userSession(uniqueEmail('adm'));
  await w.t.addOrgMember(orgId, a.id, 'admin');
  adminS = { ...a, ...(await pairWorkstation(w.t, a, 'admin-box')) };
  await markOnline(w.t, adminS.workstationId);
  const m = await w.t.userSession(uniqueEmail('mem'));
  await w.t.addOrgMember(orgId, m.id, 'member');
  memberS = { ...m, ...(await pairWorkstation(w.t, m, 'member-box')) };
  await markOnline(w.t, memberS.workstationId);
  const o = await w.t.userSession(uniqueEmail('out'));
  outsider = { ...o, ...(await pairWorkstation(w.t, o, 'outsider-box')) };
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const as = (cookie: string) => ({
  get: (url: string) => w.t.req('GET', url, { cookie }),
  post: (url: string, body: unknown = {}) => w.t.req('POST', url, { cookie, body }),
});
const owner = () => as(w.owner.cookie);
const body = (workstationId: string) => ({ workstationId, runtime: 'mock', model: 'mock' });
const agentRow = async (id: string) => (await q('SELECT * FROM agents WHERE id=$1', [id]))[0]!;
const hire = () => w.hire(`Active${++n}`, 'builder', 'junior');
const events = async (id: string, type?: string) =>
  q(
    `SELECT type, jsonb_build_object('kind', actor_kind, 'id', actor_id) AS actor, payload FROM events WHERE stream_id=$1 ${type ? 'AND type=$2' : ''} ORDER BY seq`,
    [`agent-${id}`, ...(type ? [type] : [])],
  );
const unchanged = async (id: string, before: number) => {
  expect((await agentRow(id)).workstation_id).toBe(w.workstationId);
  expect(await events(id)).toHaveLength(before);
};
const devopsOf = async (ws: string) =>
  (
    await q(`SELECT * FROM agents WHERE org_id=$1 AND workstation_id=$2 AND is_devops AND status='active'`, [
      orgId,
      ws,
    ])
  )[0]!;

describe('move an active agent (hiring manager, claims, DevOps)', () => {
  it('the hiring manager moves their active agent; runtime and model stay, one AgentRehomed', async () => {
    const a = await hire();
    await q('UPDATE agents SET manager_user_id=$2 WHERE id=$1', [a.id, memberS.id]);
    const before = await agentRow(a.id);
    const r = await as(memberS.cookie).post(`/api/agents/${a.id}/rehome`, {
      workstationId: second,
      runtime: before.runtime,
      model: before.model,
    });
    expect(r.status).toBe(200);
    const after = await agentRow(a.id);
    expect(after).toMatchObject({ workstation_id: second, runtime: before.runtime, model: before.model });
    const ev = await events(a.id, 'AgentRehomed');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.actor).toMatchObject({ kind: 'user', id: memberS.id });
    expect(ev[0]!.payload).toMatchObject({ fromWorkstationId: w.workstationId, workstationId: second });
  });

  it('Owner and Admin still move; a plain Member gets 403, an outsider 404', async () => {
    const a = await hire();
    expect((await owner().post(`/api/agents/${a.id}/rehome`, body(second))).status).toBe(200);
    expect((await as(adminS.cookie).post(`/api/agents/${a.id}/rehome`, body(w.workstationId))).status).toBe(
      200,
    );
    const b = await hire();
    expect((await as(memberS.cookie).post(`/api/agents/${b.id}/rehome`, body(second))).status).toBe(403);
    expect((await as(memberS.cookie).get(`/api/agents/${b.id}/move-targets`)).status).toBe(403);
    expect((await as(outsider.cookie).post(`/api/agents/${b.id}/rehome`, body(second))).status).toBe(404);
    await unchanged(b.id, (await events(b.id)).length);
  });

  it('a hiring manager cannot move a DevOps engineer', async () => {
    const d = await devopsOf(w.workstationId);
    expect(d).toBeTruthy();
    await q('UPDATE agents SET manager_user_id=$2 WHERE id=$1', [d.id, memberS.id]);
    try {
      expect((await as(memberS.cookie).post(`/api/agents/${d.id}/rehome`, body(second))).status).toBe(403);
    } finally {
      await q('UPDATE agents SET manager_user_id=$2 WHERE id=$1', [d.id, d.manager_user_id]);
    }
  });

  it('releases a claim held without a shift and a running BA task, in the same move', async () => {
    const a = await hire();
    const card = await w.card();
    const claimId = crypto.randomUUID();
    await q(
      `UPDATE cards SET claim_id=$2, claimed_by_agent_id=$3, claim_workstation_id=$4, claim_shift_id=gen_random_uuid(),
              claimed_at=now(), lease_expires_at=now() + interval '1 hour', status='claimed' WHERE id=$1`,
      [card.id, claimId, a.id, w.workstationId],
    );
    const taskId = crypto.randomUUID();
    await q(
      `INSERT INTO ba_tasks (id, org_id, project_id, kind, status, agent_id, attempts, created_at, updated_at)
       VALUES ($1,$2,$3,'phase_report','running',$4,0,now(),now())`,
      [taskId, orgId, w.projectId, a.id],
    );
    const r = await owner().post(`/api/agents/${a.id}/rehome`, body(second));
    expect(r.status).toBe(200);
    const c = (await q('SELECT * FROM cards WHERE id=$1', [card.id]))[0]!;
    expect(c).toMatchObject({ claim_id: null, claimed_by_agent_id: null, status: 'queued' });
    const rel = await q(`SELECT payload FROM events WHERE stream_id=$1 AND type='ClaimReleased'`, [
      `card-${card.id}`,
    ]);
    expect(rel.map((e) => e.payload.reason)).toContain('agent_moved');
    const t = (await q('SELECT * FROM ba_tasks WHERE id=$1', [taskId]))[0]!;
    expect(t).toMatchObject({ status: 'queued', agent_id: null, attempts: 0 });
    expect(await events(a.id, 'AgentRehomed')).toHaveLength(1);
    expect((await agentRow(a.id)).workstation_id).toBe(second);
  });

  it('refuses a running shift with agent_busy and changes nothing', async () => {
    const a = await hire();
    const before = (await events(a.id)).length;
    const shiftId = crypto.randomUUID();
    await q(
      `INSERT INTO shifts (id, org_id, agent_id, workstation_id, kind, status, runtime, model, started_at)
       VALUES ($1,$2,$3,$4,'chat','running','mock','mock',now())`,
      [shiftId, orgId, a.id, w.workstationId],
    );
    const r = await owner().post(`/api/agents/${a.id}/rehome`, body(second));
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain('agent_busy');
    await unchanged(a.id, before);
    await q(`UPDATE shifts SET status='ended' WHERE id=$1`, [shiftId]);
  });

  it('refuses a target that is over the workstation limit', async () => {
    const fresh = (await pairWorkstation(w.t, w.owner, 'limit-box')).workstationId;
    await markOnline(w.t, fresh);
    const a = await hire();
    const before = (await events(a.id)).length;
    const planLimits = w.t.app.ctx.ext.planLimits;
    const orig = planLimits.assertWithin;
    const calls: string[] = [];
    planLimits.assertWithin = async (_tx, _org, kind) => {
      calls.push(kind);
      if (kind === 'workstations')
        throw Object.assign(new Error('workstation limit reached'), { statusCode: 409 });
    };
    try {
      const r = await owner().post(`/api/agents/${a.id}/rehome`, body(fresh));
      expect(r.status).toBe(409);
      await unchanged(a.id, before);
      expect(calls).toContain('workstations');
    } finally {
      planLimits.assertWithin = orig;
    }
  });

  it('a DevOps engineer of a still-paired workstation stays (devops_stays)', async () => {
    const d = await devopsOf(w.workstationId);
    const before = (await events(d.id)).length;
    const r = await owner().post(`/api/agents/${d.id}/rehome`, body(second));
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain('devops_stays');
    await unchanged(d.id, before);
  });

  it('a DevOps engineer of an unpaired workstation: refused where one exists, moves where none does', async () => {
    const dead = (await pairWorkstation(w.t, w.owner, 'dead-devops')).workstationId;
    await markOnline(w.t, dead);
    // Pairing hires the workstation's DevOps engineer; unpairing leaves it pointing at a dead machine.
    const d = await devopsOf(dead);
    expect(d).toBeTruthy();
    await q(`UPDATE workstations SET status='unlinked', connected=false WHERE id=$1`, [dead]);
    const there = await devopsOf(second);
    // GET move-targets names the DevOps engineer already on each target.
    const list = await owner().get(`/api/agents/${d.id}/move-targets`);
    expect(list.status).toBe(200);
    if (there) {
      expect(list.body.workstations.find((x: any) => x.id === second).devops).toMatchObject({
        agentId: there.id,
        name: there.name,
      });
      const r = await owner().post(`/api/agents/${d.id}/rehome`, body(second));
      expect(r.status).toBe(409);
      expect(JSON.stringify(r.body)).toContain('one_devops_per_workstation');
      expect(JSON.stringify(r.body)).toContain('agents_one_devops');
      expect(JSON.stringify(r.body)).toContain(there.name);
      expect((await agentRow(d.id)).workstation_id).toBe(dead);
      await q(`UPDATE agents SET status='retired' WHERE id=$1`, [there.id]);
    }
    const ok2 = await owner().post(`/api/agents/${d.id}/rehome`, body(second));
    expect(ok2.status).toBe(200);
    expect((await agentRow(d.id)).workstation_id).toBe(second);
  });

  it('the CEO still cannot be moved here', async () => {
    const ceo = (await q(`SELECT id FROM agents WHERE org_id=$1 AND role_key='ceo' LIMIT 1`, [orgId]))[0];
    if (!ceo) return;
    const r = await owner().post(`/api/agents/${ceo.id}/rehome`, body(second));
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain('builtin_agent');
  });

  it('the org chart marks an agent on an unpaired workstation', async () => {
    const dead = (await pairWorkstation(w.t, w.owner, 'dead-chart')).workstationId;
    const a = await hire();
    await q('UPDATE agents SET workstation_id=$2 WHERE id=$1', [a.id, dead]);
    await q(`UPDATE workstations SET status='unlinked', connected=false WHERE id=$1`, [dead]);
    const chart = await ok<any>(owner().get('/api/org-chart'));
    expect(chart.agents.find((x: any) => x.id === a.id).workstation.unpaired).toBe(true);
    expect(
      chart.agents.find((x: any) => x.workstation && x.workstation.id === w.workstationId).workstation
        .unpaired,
    ).toBe(false);
  });
});

describe('held claims on the paths that release nothing', () => {
  const holdClaim = async (agentId: string, wsId: string) => {
    const card = await w.card();
    await q(
      `UPDATE cards SET claim_id=$2, claimed_by_agent_id=$3, claim_workstation_id=$4, claim_shift_id=gen_random_uuid(),
              claimed_at=now(), lease_expires_at=now() + interval '1 hour', status='claimed' WHERE id=$1`,
      [card.id, crypto.randomUUID(), agentId, wsId],
    );
    return card;
  };

  it("M1: a bulk move releases a claim-holding agent's claim and moves it", async () => {
    const src = (await pairWorkstation(w.t, w.owner, 'bulk-src')).workstationId;
    await markOnline(w.t, src);
    const a = await hire();
    await q('UPDATE agents SET workstation_id=$2 WHERE id=$1', [a.id, src]);
    const card = await holdClaim(a.id, src);
    const r = await owner().post(`/api/workstations/${src}/move-agents`, { targetWorkstationId: second });
    expect(r.status).toBe(200);
    expect(r.body.moved).toEqual(
      expect.arrayContaining([expect.objectContaining({ agentId: a.id, releasedClaims: [card.ref] })]),
    );
    expect(r.body.blocked ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ agentId: a.id })]),
    );
    expect((await agentRow(a.id)).workstation_id).toBe(second);
    expect((await q('SELECT * FROM cards WHERE id=$1', [card.id]))[0]!.claimed_by_agent_id).toBeNull();
    expect(await events(a.id, 'AgentRehomed')).toHaveLength(1);
    expect(
      await q(`SELECT 1 FROM events WHERE stream_id=$1 AND type='ClaimReleased'`, [`card-${card.id}`]),
    ).toHaveLength(1);
  });

  it('M2: checkAgentMove refuses a held claim by default and passes with releaseHeldClaims', async () => {
    const a = await hire();
    const card = await holdClaim(a.id, w.workstationId);
    const row = await agentRow(a.id);
    const rq = { workstationId: second, runtime: 'mock', model: 'mock', acknowledgeUnsandboxed: false };
    const ctx = w.t.app.ctx;
    await expect(checkAgentMove(ctx, ctx.pool, { userId: w.owner.id }, row, rq)).rejects.toMatchObject({
      code: 'agent_busy',
    });
    await expect(
      checkAgentMove(ctx, ctx.pool, { userId: w.owner.id }, row, rq, { releaseHeldClaims: true }),
    ).resolves.toBeTruthy();
    await q(`UPDATE cards SET claim_id=NULL, claimed_by_agent_id=NULL, status='queued' WHERE id=$1`, [
      card.id,
    ]);
  });
});
