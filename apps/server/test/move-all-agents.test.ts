import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { conflict } from '../src/errors.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { addMember } from './helpers/members.ts';
import { createWorld, markOnline, pairWorkstation, type Session, type World } from './helpers/world.ts';

let w: World;
let orgId: string;
let adminS: Session & { workstationId: string };
let memberS: Session & { workstationId: string };
let outsider: Session & { workstationId: string };
let guest: Awaited<ReturnType<typeof addMember>>;
let target: string; // the owner's second workstation
let n = 0;

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  orgId = (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]!.org_id;
  await markOnline(w.t, w.workstationId);
  target = (await pairWorkstation(w.t, w.owner, 'target')).workstationId;
  await markOnline(w.t, target);
  const a = await w.t.userSession(uniqueEmail('adm'));
  await w.t.addOrgMember(orgId, a.id, 'admin');
  adminS = { ...a, ...(await pairWorkstation(w.t, a, 'admin-box')) };
  const m = await w.t.userSession(uniqueEmail('mem'));
  await w.t.addOrgMember(orgId, m.id, 'member');
  memberS = { ...m, ...(await pairWorkstation(w.t, m, 'member-box')) };
  await markOnline(w.t, memberS.workstationId);
  const o = await w.t.userSession(uniqueEmail('out'));
  outsider = { ...o, ...(await pairWorkstation(w.t, o, 'outsider-box')) };
  guest = await addMember(w, 'guest');
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const as = (cookie: string) => {
  const headers = { 'x-aom-org': orgId }; // members also own a personal org: name the one under test
  return {
    get: (url: string) => w.t.req('GET', url, { cookie, headers }),
    post: (url: string, body: unknown = {}) => w.t.req('POST', url, { cookie, body, headers }),
  };
};
const owner = () => as(w.owner.cookie);
const hire = () => w.hire(`Bulk${++n}`, 'builder', 'junior');
const agentRow = async (id: string) => (await q('SELECT * FROM agents WHERE id=$1', [id]))[0]!;
const rehomed = (id: string) =>
  q(
    `SELECT actor_kind, actor_id, payload FROM events WHERE stream_id=$1 AND type='AgentRehomed' ORDER BY seq`,
    [`agent-${id}`],
  );

/** A fresh workstation holding `count` agents; `dead` unlinks it afterwards. */
async function station(count: number, dead = false) {
  const id = (await pairWorkstation(w.t, w.owner, `src${++n}`)).workstationId;
  await markOnline(w.t, id);
  const agents = [];
  for (let i = 0; i < count; i++) {
    const a = await hire();
    await q('UPDATE agents SET workstation_id=$2 WHERE id=$1', [a.id, id]);
    agents.push(a);
  }
  if (dead) await q(`UPDATE workstations SET status='unlinked', connected=false WHERE id=$1`, [id]);
  return { id, agents };
}
const openShift = (agentId: string, wsId: string) =>
  q(
    `INSERT INTO shifts (id, org_id, agent_id, workstation_id, kind, status, runtime, model, started_at)
     VALUES ($1,$2,$3,$4,'chat','running','mock','mock',now())`,
    [crypto.randomUUID(), orgId, agentId, wsId],
  );
const moveAll = (src: string, to = target, extra: object = {}) =>
  owner().post(`/api/workstations/${src}/move-agents`, { targetWorkstationId: to, ...extra });

describe('move all agents from one workstation to another', () => {
  it('AC1/AC2/AC3/AC6: moves every agent of an unlinked workstation, keeps pause, one audit entry each', async () => {
    const s = await station(3, true);
    await q('UPDATE agents SET paused_at=now() WHERE id=$1', [s.agents[0]!.id]);
    const retired = await hire();
    await q(`UPDATE agents SET workstation_id=$2, status='retired' WHERE id=$1`, [retired.id, s.id]);
    const r = await moveAll(s.id);
    expect(r.status).toBe(200);
    expect(r.body.dryRun).toBe(false);
    expect(r.body.source).toMatchObject({ id: s.id, status: 'unlinked' });
    expect(r.body.target).toMatchObject({ id: target, name: 'target' });
    expect(r.body.moved.map((x: any) => x.agentId).sort()).toEqual(s.agents.map((a) => a.id).sort());
    // only the source's DevOps engineer stays, blocked by the one-DevOps-per-workstation rule
    expect(r.body.blocked).toHaveLength(1);
    expect(r.body.blocked[0]).toMatchObject({ reason: 'one_devops', code: 'one_devops_per_workstation' });
    for (const a of s.agents) {
      const row = await agentRow(a.id);
      expect(row.workstation_id).toBe(target);
      const ev = await rehomed(a.id);
      expect(ev).toHaveLength(1);
      expect(ev[0]!.actor_id).toBe(w.owner.id);
      expect(ev[0]!.payload).toMatchObject({ fromWorkstationId: s.id, workstationId: target });
    }
    expect((await agentRow(s.agents[0]!.id)).paused_at).not.toBeNull();
    expect((await agentRow(retired.id)).workstation_id).toBe(s.id);
    expect(await rehomed(retired.id)).toHaveLength(0);
  });

  it('AC2/AC3: an agent in a running shift is blocked with the reason, the rest move', async () => {
    const s = await station(3);
    await openShift(s.agents[1]!.id, s.id);
    const r = await moveAll(s.id);
    expect(r.status).toBe(200);
    expect(r.body.moved).toHaveLength(2);
    const shiftSkips = r.body.blocked.filter((x: any) => x.reason === 'running_shift');
    expect(shiftSkips).toHaveLength(1); // the source's DevOps engineer is blocked too, as one_devops
    expect(shiftSkips[0]).toMatchObject({
      agentId: s.agents[1]!.id,
      name: s.agents[1]!.name,
      reason: 'running_shift',
      code: 'agent_busy',
    });
    expect(shiftSkips[0].message).toContain('running shift');
    expect((await agentRow(s.agents[1]!.id)).workstation_id).toBe(s.id);
    expect(await rehomed(s.agents[1]!.id)).toHaveLength(0);
    expect((await agentRow(s.agents[0]!.id)).workstation_id).toBe(target);
  });

  it('blocks the DevOps engineer of the source as one_devops and leaves it there', async () => {
    const dev = (
      await q(`SELECT id FROM agents WHERE is_devops AND status='active' AND workstation_id=$1`, [
        w.workstationId,
      ])
    )[0]!;
    const a = await hire(); // hired onto the world's workstation, next to its DevOps engineer
    const r = await moveAll(w.workstationId);
    expect(r.status).toBe(200);
    expect(r.body.blocked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: dev.id, reason: 'one_devops', code: 'devops_stays' }),
      ]),
    );
    expect(r.body.moved.map((x: any) => x.agentId)).toContain(a.id);
    expect((await agentRow(dev.id)).workstation_id).toBe(w.workstationId);
    expect(await rehomed(dev.id)).toHaveLength(0);
  });

  it('preview reports the same plan and writes nothing', async () => {
    const s = await station(2);
    await openShift(s.agents[0]!.id, s.id);
    const r = await owner().get(
      `/api/workstations/${s.id}/move-agents/preview?targetWorkstationId=${target}`,
    );
    expect(r.status).toBe(200);
    expect(r.body.dryRun).toBe(true);
    expect(r.body.moved.map((x: any) => x.agentId)).toEqual([s.agents[1]!.id]);
    expect(r.body.blocked.map((x: any) => x.reason)).toContain('running_shift');
    for (const a of s.agents) {
      expect((await agentRow(a.id)).workstation_id).toBe(s.id);
      expect(await rehomed(a.id)).toHaveLength(0);
    }
  });

  it('AC4: refuses the same workstation, an unknown one, another organization and unrelated sources', async () => {
    const s = await station(1);
    const same = await moveAll(s.id, s.id);
    expect(same.status).toBe(400);
    expect(JSON.stringify(same.body)).toContain('same_workstation');
    const unknown = '00000000-0000-4000-8000-000000000001';
    for (const [src, to] of [
      [s.id, unknown],
      [unknown, target],
      [s.id, outsider.workstationId],
      [outsider.workstationId, target],
      [s.id, guest.workstationId],
    ] as const) {
      const r = await moveAll(src, to);
      expect(r.status).toBe(404);
      expect(JSON.stringify(r.body)).toContain('workstation_not_found');
    }
    expect((await agentRow(s.agents[0]!.id)).workstation_id).toBe(s.id);
  });

  it('AC4: an unpaired member workstation as target is 409 workstation_unpaired', async () => {
    const s = await station(1);
    const gone = (await pairWorkstation(w.t, w.owner, `gone${++n}`)).workstationId;
    await q(`UPDATE workstations SET status='unlinked' WHERE id=$1`, [gone]);
    const r = await moveAll(s.id, gone);
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain('workstation_unpaired');
    expect((await agentRow(s.agents[0]!.id)).workstation_id).toBe(s.id);
  });

  it('a Member with no agents there gets 403 on the bulk routes, an Admin is allowed', async () => {
    const s = await station(1);
    const m = as(memberS.cookie);
    expect(
      (await m.post(`/api/workstations/${s.id}/move-agents`, { targetWorkstationId: target })).status,
    ).toBe(403);
    expect(
      (await m.get(`/api/workstations/${s.id}/move-agents/preview?targetWorkstationId=${target}`)).status,
    ).toBe(403);
    expect((await m.get(`/api/workstations/${s.id}/move-targets`)).status).toBe(403);
    const homes = await m.get('/api/agents/workstations');
    expect(homes.status).toBe(200);
    expect(homes.body.workstations).toEqual([]);
    expect((await agentRow(s.agents[0]!.id)).workstation_id).toBe(s.id);
    const r = await as(adminS.cookie).post(`/api/workstations/${s.id}/move-agents`, {
      targetWorkstationId: target,
    });
    expect(r.status).toBe(200);
    expect(r.body.scope).toBe('all');
    expect(r.body.moved).toHaveLength(1);
  });

  it('partial success: an agent whose runtime the target lacks fails, the others move', async () => {
    const s = await station(2);
    await q(`UPDATE agents SET runtime='ghost' WHERE id=$1`, [s.agents[0]!.id]);
    await q(`UPDATE workstations SET runtimes=$2::jsonb WHERE id=$1`, [
      target,
      JSON.stringify([{ id: 'mock', version: '1', available: true, capabilities: ['shell'] }]),
    ]);
    const r = await moveAll(s.id);
    expect(r.status).toBe(200);
    expect(r.body.moved.map((x: any) => x.agentId)).toEqual([s.agents[1]!.id]);
    expect(r.body.blocked.find((x: any) => x.agentId === s.agents[0]!.id)).toMatchObject({
      reason: 'runtime_missing',
      code: 'runtime_missing',
    });
    expect((await agentRow(s.agents[0]!.id)).workstation_id).toBe(s.id);
    expect((await agentRow(s.agents[1]!.id)).workstation_id).toBe(target);
  });

  it('an unsandboxed target needs the acknowledgement, flagged in the response', async () => {
    const s = await station(1);
    await q(`UPDATE workstations SET runtimes=$2::jsonb WHERE id=$1`, [
      target,
      JSON.stringify([
        { id: 'mock', version: '1', available: true, capabilities: ['shell'], sandbox: 'unsandboxed' },
      ]),
    ]);
    const r = await moveAll(s.id);
    expect(r.body.needsUnsandboxedAck).toBe(true);
    expect(r.body.blocked.find((x: any) => x.agentId === s.agents[0]!.id)).toMatchObject({
      reason: 'sandbox_gate',
      code: 'unsandboxed_ack_required',
    });
    expect((await agentRow(s.agents[0]!.id)).workstation_id).toBe(s.id);
    const ok = await moveAll(s.id, target, { acknowledgeUnsandboxed: true });
    expect(ok.body.moved).toHaveLength(1);
    await q(`UPDATE workstations SET runtimes='[]'::jsonb WHERE id=$1`, [target]);
  });

  it('serves the homes list and the source-keyed target list', async () => {
    const s = await station(2, true);
    const homes = await owner().get('/api/agents/workstations');
    expect(homes.status).toBe(200);
    expect(homes.body.workstations.find((h: any) => h.id === s.id)).toMatchObject({
      status: 'unlinked',
      agentCount: 2,
      runningCount: 0,
      mine: true,
    });
    const t = await owner().get(`/api/workstations/${s.id}/move-targets`);
    expect(t.status).toBe(200);
    expect(t.body.current).toMatchObject({ id: s.id, state: 'unpaired' });
    expect(t.body.workstations.map((x: any) => x.id)).toContain(target);
    expect(t.body.workstations.map((x: any) => x.id)).not.toContain(s.id);
    expect((await owner().get(`/api/workstations/${outsider.workstationId}/move-targets`)).status).toBe(404);
  });

  it('AC3: a claim is released in the move, with one AgentRehomed and one ClaimReleased', async () => {
    const s = await station(2);
    const a = s.agents[0]!;
    const card = await w.card();
    await q(
      `UPDATE cards SET claim_id=$2, claimed_by_agent_id=$3, claim_workstation_id=$4, claim_shift_id=gen_random_uuid(),
              claimed_at=now(), lease_expires_at=now() + interval '1 hour', status='claimed' WHERE id=$1`,
      [card.id, crypto.randomUUID(), a.id, s.id],
    );
    const prev = await owner().get(
      `/api/workstations/${s.id}/move-agents/preview?targetWorkstationId=${target}`,
    );
    expect(prev.body.moved.find((x: any) => x.agentId === a.id).releasedClaims).toEqual([card.ref]);
    expect((await agentRow(a.id)).workstation_id).toBe(s.id);
    const r = await moveAll(s.id);
    expect(r.body.moved.find((x: any) => x.agentId === a.id).releasedClaims).toEqual([card.ref]);
    expect((await agentRow(a.id)).workstation_id).toBe(target);
    expect(await rehomed(a.id)).toHaveLength(1);
    const c = (await q('SELECT * FROM cards WHERE id=$1', [card.id]))[0]!;
    expect(c.claimed_by_agent_id).toBeNull();
    const rel = await q(`SELECT payload FROM events WHERE stream_id=$1 AND type='ClaimReleased'`, [
      `card-${card.id}`,
    ]);
    expect(rel.map((e: any) => e.payload.reason)).toContain('agent_moved');
  });

  it('AC8: a hiring manager moves and previews only the agents they hired', async () => {
    const s = await station(1);
    const mine = (await w.t.req('POST', '/api/agents', {
      cookie: memberS.cookie,
      headers: { 'x-aom-org': orgId },
      body: { name: `Mine${++n}`, roleKey: 'builder', seniority: 'junior', workstationId: s.id },
    })) as any;
    if (mine.status !== 201 && mine.status !== 200) {
      await q(`UPDATE agents SET manager_user_id=$2 WHERE id=$1`, [s.agents[0]!.id, memberS.id]);
    } else {
      await q('UPDATE agents SET workstation_id=$2 WHERE id=$1', [mine.body.id, s.id]);
      await q(`UPDATE agents SET manager_user_id=$2 WHERE id=$1`, [mine.body.id, memberS.id]);
    }
    const hired = await q(
      `SELECT id FROM agents WHERE workstation_id=$1 AND manager_user_id=$2 AND NOT is_builtin`,
      [s.id, memberS.id],
    );
    expect(hired.length).toBeGreaterThan(0);
    const m = as(memberS.cookie);
    const prev = await m.get(`/api/workstations/${s.id}/move-agents/preview?targetWorkstationId=${target}`);
    expect(prev.status).toBe(200);
    expect(prev.body.scope).toBe('own');
    const listed = [...prev.body.moved, ...prev.body.blocked].map((x: any) => x.agentId);
    expect(listed.sort()).toEqual(hired.map((x: any) => x.id).sort());
    const run = await m.post(`/api/workstations/${s.id}/move-agents`, { targetWorkstationId: target });
    expect(run.status).toBe(200);
    expect((await agentRow(s.agents[0]!.id)).workstation_id).toBe(
      hired.some((x: any) => x.id === s.agents[0]!.id) ? target : s.id,
    );
    const homes = await m.get('/api/agents/workstations');
    expect(homes.body.workstations.find((h: any) => h.id === s.id)).toBeUndefined();
  });

  it('AC5: a target over the workstation limit blocks the agents that do not fit, nothing moves', async () => {
    const s = await station(2);
    await openShift(s.agents[0]!.id, s.id); // the source keeps an agent, so it does not empty
    const fresh = (await pairWorkstation(w.t, w.owner, `limit${++n}`)).workstationId;
    await markOnline(w.t, fresh);
    const planLimits = w.t.app.ctx.ext.planLimits;
    const orig = planLimits.assertWithin;
    planLimits.assertWithin = async (_tx: any, _org: any, kind: string) => {
      if (kind === 'workstations') throw conflict('limit_reached', 'workstation limit reached');
    };
    try {
      const r = await moveAll(s.id, fresh);
      expect(r.status).toBe(200);
      const lim = r.body.blocked.find((x: any) => x.agentId === s.agents[1]!.id);
      expect(lim?.reason).toBe('workstation_limit');
      expect((await agentRow(s.agents[1]!.id)).workstation_id).toBe(s.id);
    } finally {
      planLimits.assertWithin = orig;
    }
  });
});
