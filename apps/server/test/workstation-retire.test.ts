import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, markOnline, pairWorkstation, type Session, type World } from './helpers/world.ts';

let w: World;
let orgId: string;
let adminS: Session;
let memberS: Session;
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
  adminS = a;
  const m = await w.t.userSession(uniqueEmail('mem'));
  await w.t.addOrgMember(orgId, m.id, 'member');
  memberS = m;
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const as = (cookie: string) => {
  const headers = { 'x-aom-org': orgId };
  return {
    get: (url: string) => w.t.req('GET', url, { cookie, headers }),
    post: (url: string, body: unknown = {}) => w.t.req('POST', url, { cookie, body, headers }),
  };
};
const owner = () => as(w.owner.cookie);
const agentRow = async (id: string) => (await q('SELECT * FROM agents WHERE id=$1', [id]))[0]!;
const wsRow = async (id: string) => (await q('SELECT * FROM workstations WHERE id=$1', [id]))[0]!;
const left = async (wsId: string) =>
  Number(
    (
      await q(`SELECT count(*)::int AS n FROM agents WHERE workstation_id=$1 AND status <> 'retired'`, [wsId])
    )[0]!.n,
  );
const events = (type: string, streamLike: string) =>
  q(`SELECT org_id, actor_kind, actor_id, payload FROM events WHERE type=$1 AND stream_id=$2 ORDER BY seq`, [
    type,
    streamLike,
  ]);

/** A fresh paired workstation holding `count` agents; `dead` unpairs it afterwards (the real case). */
async function station(count: number, dead = false) {
  const id = (await pairWorkstation(w.t, w.owner, `src${++n}`)).workstationId;
  await markOnline(w.t, id);
  const agents = [];
  for (let i = 0; i < count; i++) {
    const a = await w.hire(`Ret${++n}`, 'builder', 'junior');
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
const retire = (id: string, body: object = {}) => owner().post(`/api/workstations/${id}/retire`, body);

describe('retire a workstation with agent handover', () => {
  it('AC1/AC2/AC5/AC7: needs_rehome on a paired workstation: agents wait for a new home, DevOps retired, audited', async () => {
    const s = await station(3);
    await q('UPDATE agents SET paused_at=now() WHERE id=$1', [s.agents[0]!.id]);
    const r = await retire(s.id, { handover: 'needs_rehome' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ workstationId: s.id, unlinked: true, handover: 'needs_rehome' });
    expect(r.body.needsRehome).toHaveLength(3);
    for (const a of s.agents) {
      const row = await agentRow(a.id);
      expect(row.status).toBe('needs_rehome');
      expect(row.workstation_id).toBeNull();
      const ev = await events('AgentNeedsRehome', `agent-${a.id}`);
      expect(ev).toHaveLength(1);
      expect(ev[0]!.actor_id).toBe(w.owner.id);
      expect(ev[0]!.payload).toMatchObject({ fromWorkstationId: s.id, reason: 'workstation_retired' });
    }
    expect((await agentRow(s.agents[0]!.id)).paused_at).not.toBeNull();
    expect((await wsRow(s.id)).status).toBe('unlinked');
    expect(await left(s.id)).toBe(0); // the DevOps engineer is retired with it
    const audit = await events('WorkstationRetired', `workstation-${s.id}`);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ org_id: orgId, actor_id: w.owner.id });
    expect(audit[0]!.payload).toMatchObject({
      handover: 'needs_rehome',
      unlinked: true,
      targetWorkstationId: null,
    });
    expect(audit[0]!.payload.needsRehomeAgentIds.sort()).toEqual(s.agents.map((a) => a.id).sort());
    // the agent can be re-homed one by one afterwards
    const back = await owner().post(`/api/agents/${s.agents[1]!.id}/rehome`, {
      workstationId: target,
      runtime: 'mock',
      model: 'mock',
    });
    expect(back.status).toBe(200);
    expect((await agentRow(s.agents[1]!.id)).workstation_id).toBe(target);
  });

  it('AC1/AC2/AC5/AC7: move to Y on an already unpaired workstation (the real case)', async () => {
    const s = await station(3, true);
    const before = await owner().get('/api/agents/workstations');
    expect(before.body.workstations.find((h: any) => h.id === s.id)).toMatchObject({
      status: 'unlinked',
      agentCount: 3,
    });
    const r = await retire(s.id, { handover: 'move', targetWorkstationId: target });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ unlinked: false, handover: 'move' });
    expect(r.body.moved).toHaveLength(3);
    for (const a of s.agents) {
      const row = await agentRow(a.id);
      expect(row.workstation_id).toBe(target);
      expect(row.status).toBe('active');
      const ev = await events('AgentRehomed', `agent-${a.id}`);
      expect(ev.at(-1)!.payload).toMatchObject({ fromWorkstationId: s.id, workstationId: target });
    }
    expect(await left(s.id)).toBe(0);
    const audit = await events('WorkstationRetired', `workstation-${s.id}`);
    expect(audit[0]!.payload).toMatchObject({
      handover: 'move',
      targetWorkstationId: target,
      unlinked: false,
    });
    expect(audit[0]!.payload.movedAgentIds).toHaveLength(3);
    const after = await owner().get('/api/agents/workstations');
    expect(after.body.workstations.find((h: any) => h.id === s.id)?.agentCount ?? 0).toBe(0);
  });

  it('an Admin can hand over the agents of an unpaired workstation that is not theirs', async () => {
    const s = await station(2, true);
    const r = await as(adminS.cookie).post(`/api/workstations/${s.id}/retire`, { handover: 'needs_rehome' });
    expect(r.status).toBe(200);
    expect(await left(s.id)).toBe(0);
  });

  it("an Admin cannot unpair somebody else's paired workstation (403 workstation_not_yours)", async () => {
    const s = await station(1);
    const r = await as(adminS.cookie).post(`/api/workstations/${s.id}/retire`, { handover: 'needs_rehome' });
    expect(r.status).toBe(403);
    expect(r.body.error?.code ?? r.body.code).toBe('workstation_not_yours');
    expect((await wsRow(s.id)).status).toBe('active');
    expect((await agentRow(s.agents[0]!.id)).workstation_id).toBe(s.id);
  });

  it("a preview by an Admin who is not the machine's user hides other organizations' agents; the machine's user sees them", async () => {
    const s = await station(2);
    const out = await w.t.userSession(uniqueEmail('out'));
    const outOrg = (await q('SELECT org_id FROM org_members WHERE user_id=$1 LIMIT 1', [out.id]))[0]!.org_id;
    await q('UPDATE agents SET org_id=$2 WHERE id=$1', [s.agents[1]!.id, outOrg]);
    // the other organization's agent is working on the shared machine
    const shiftId = crypto.randomUUID();
    await q(
      `INSERT INTO shifts (id, org_id, agent_id, workstation_id, kind, status, runtime, model, started_at)
       VALUES ($1,$2,$3,$4,'chat','running','mock','mock',now())`,
      [shiftId, outOrg, s.agents[1]!.id, s.id],
    );
    const adminView = await as(adminS.cookie).get(`/api/workstations/${s.id}/retire-preview`);
    expect(adminView.status).toBe(200);
    expect(adminView.body.agents.map((a: any) => a.id)).toEqual([s.agents[0]!.id]);
    expect(adminView.body.working).toEqual([]);
    expect(adminView.body.canUnpair).toBe(false);
    const ownerView = await owner().get(`/api/workstations/${s.id}/retire-preview`);
    expect(ownerView.body.agents).toHaveLength(2);
    expect(ownerView.body.agents.find((a: any) => a.id === s.agents[1]!.id).otherOrg).toBe(true);
    expect(ownerView.body.working.map((a: any) => a.id)).toEqual([s.agents[1]!.id]);
    expect(ownerView.body.canUnpair).toBe(true);
    await q(`UPDATE shifts SET status='ended', ended_at=now() WHERE id=$1`, [shiftId]);
  });

  it('AC6: a Member gets 403 on the preview and on retiring', async () => {
    const s = await station(1, true);
    const m = as(memberS.cookie);
    expect((await m.get(`/api/workstations/${s.id}/retire-preview`)).status).toBe(403);
    expect((await m.post(`/api/workstations/${s.id}/retire`, { handover: 'needs_rehome' })).status).toBe(403);
    expect((await agentRow(s.agents[0]!.id)).workstation_id).toBe(s.id);
  });

  it('AC4: refused while an agent is in a running shift, naming the agent; nothing changes', async () => {
    const s = await station(2);
    await openShift(s.agents[0]!.id, s.id);
    const p = await owner().get(`/api/workstations/${s.id}/retire-preview`);
    expect(p.status).toBe(200);
    expect(p.body.working.map((x: any) => x.name)).toEqual([s.agents[0]!.name]);
    const r = await retire(s.id, { handover: 'needs_rehome' });
    expect(r.status).toBe(409);
    expect(r.body.error?.code ?? r.body.code).toBe('agents_working');
    expect(JSON.stringify(r.body)).toContain(s.agents[0]!.name);
    expect((await wsRow(s.id)).status).toBe('active');
    for (const a of s.agents) expect((await agentRow(a.id)).workstation_id).toBe(s.id);
    expect(await events('WorkstationRetired', `workstation-${s.id}`)).toHaveLength(0);
  });

  it('a workstation with agents needs a handover choice (400)', async () => {
    const s = await station(1, true);
    const r = await retire(s.id);
    expect(r.status).toBe(400);
    expect(r.body.error?.code ?? r.body.code).toBe('handover_required');
  });

  it('AC2: when one agent cannot move to Y the whole retirement is refused and nothing changes', async () => {
    const s = await station(2, true);
    const odd = (await pairWorkstation(w.t, w.owner, `odd${++n}`)).workstationId;
    await markOnline(w.t, odd);
    await q(`UPDATE workstations SET runtimes=$2::jsonb WHERE id=$1`, [
      odd,
      JSON.stringify([{ id: 'nothing-else', available: true }]),
    ]);
    const r = await retire(s.id, { handover: 'move', targetWorkstationId: odd });
    expect(r.status).toBe(409);
    expect(r.body.error?.code ?? r.body.code).toBe('handover_incomplete');
    expect(JSON.stringify(r.body)).toContain(s.agents[0]!.name);
    for (const a of s.agents) expect((await agentRow(a.id)).workstation_id).toBe(s.id);
    expect(await events('WorkstationRetired', `workstation-${s.id}`)).toHaveLength(0);
  });

  it('AC3: a retired workstation is no target for a move, a bulk move or a shift', async () => {
    const s = await station(1);
    const spare = await w.hire(`Spare${++n}`, 'builder', 'junior');
    await retire(s.id, { handover: 'needs_rehome' });
    const one = await owner().post(`/api/agents/${spare.id}/rehome`, {
      workstationId: s.id,
      runtime: 'mock',
      model: 'mock',
    });
    expect([404, 409]).toContain(one.status);
    const bulk = await owner().post(`/api/workstations/${target}/move-agents`, { targetWorkstationId: s.id });
    expect([404, 409]).toContain(bulk.status);
    const list = await owner().get(`/api/agents/${spare.id}/move-targets`);
    expect(JSON.stringify(list.body)).not.toContain(s.id);
    const mine = await owner().get('/api/workstations');
    expect(mine.body.workstations.map((x: any) => x.id)).not.toContain(s.id);
  });

  it('an empty workstation retires directly', async () => {
    const s = await station(0);
    const r = await retire(s.id);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ handover: 'none', unlinked: true });
    expect((await wsRow(s.id)).status).toBe('unlinked');
    const audit = await events('WorkstationRetired', `workstation-${s.id}`);
    expect(audit[0]!.payload).toMatchObject({ handover: 'none' });
  });

  it('open cards homed on the workstation restart anywhere', async () => {
    const s = await station(1);
    const card = await w.card();
    await q('UPDATE cards SET home_workstation_id=$2 WHERE id=$1', [card.id, s.id]);
    const p = await owner().get(`/api/workstations/${s.id}/retire-preview`);
    expect(p.body.homedCards.map((c: any) => c.ref)).toContain(card.ref);
    const r = await retire(s.id, { handover: 'needs_rehome' });
    expect(r.status).toBe(200);
    expect(r.body.rehomedCardIds).toContain(card.id);
    expect(
      (await q('SELECT home_workstation_id FROM cards WHERE id=$1', [card.id]))[0]!.home_workstation_id,
    ).toBeNull();
  });

  it('retiring an unknown workstation is a 404', async () => {
    const r = await retire(crypto.randomUUID(), {});
    expect(r.status).toBe(404);
  });
});
