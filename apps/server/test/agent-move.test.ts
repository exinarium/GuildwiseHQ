import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { addMember } from './helpers/members.ts';
import { createWorld, markOnline, ok, pairWorkstation, type Session, type World } from './helpers/world.ts';

let w: World;
let orgId: string;
let adminS: Session & { workstationId: string };
let memberS: Session & { workstationId: string };
let outsider: Session & { workstationId: string };
let guest: Awaited<ReturnType<typeof addMember>>;
let second: string; // the owner's second workstation
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
  guest = await addMember(w, 'guest');
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
const hire = () => w.hire(`Mover${++n}`, 'builder', 'junior');
const moved = (id: string) =>
  q(`SELECT actor_kind, actor_id, payload FROM events WHERE stream_id=$1 AND type='AgentRehomed' ORDER BY seq`, [
    `agent-${id}`,
  ]);

describe('move any agent to another workstation', () => {
  it('moves an active agent whose workstation is offline, and keeps its projects', async () => {
    const a = await hire();
    await q('UPDATE workstations SET connected=false WHERE id=$1', [w.workstationId]);
    const r = await owner().post(`/api/agents/${a.id}/rehome`, body(second));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      status: 'active',
      workstationId: second,
      workstationName: 'second',
      workstationState: 'connected',
      allowedProjectIds: a.allowedProjectIds,
    });
    await markOnline(w.t, w.workstationId);
  });

  it('moves an active agent off an unpaired workstation', async () => {
    const dead = (await pairWorkstation(w.t, w.owner, 'dead')).workstationId;
    await markOnline(w.t, dead);
    const a = await hire();
    await q('UPDATE agents SET workstation_id=$2 WHERE id=$1', [a.id, dead]);
    await q(`UPDATE workstations SET status='unlinked', connected=false WHERE id=$1`, [dead]);
    const listed = (await owner().get('/api/agents')).body.agents.find((x: any) => x.id === a.id);
    expect(listed).toMatchObject({ workstationState: 'unpaired', workstationName: 'dead' });
    const r = await owner().post(`/api/agents/${a.id}/rehome`, body(w.workstationId));
    expect(r.status).toBe(200);
    expect(r.body.workstationId).toBe(w.workstationId);
  });

  it("an Owner or Admin can pick another member's workstation", async () => {
    const a = await hire();
    expect((await owner().post(`/api/agents/${a.id}/rehome`, body(memberS.workstationId))).status).toBe(200);
    expect(
      (await as(adminS.cookie).post(`/api/agents/${a.id}/rehome`, body(adminS.workstationId))).status,
    ).toBe(200);
    expect((await agentRow(a.id)).workstation_id).toBe(adminS.workstationId);
  });

  it('a needs_rehome agent leaves that status when moved', async () => {
    const a = await hire();
    await q(`UPDATE agents SET status='needs_rehome', workstation_id=NULL WHERE id=$1`, [a.id]);
    const r = await owner().post(`/api/agents/${a.id}/rehome`, body(second));
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('active');
    const ev = await moved(a.id);
    expect(ev[0]!.payload.fromWorkstationId).toBeNull();
  });

  it('a Member (also the hiring manager) gets 403, a non-member 404', async () => {
    const a = await hire();
    expect((await as(memberS.cookie).post(`/api/agents/${a.id}/rehome`, body(second))).status).toBe(403);
    await q('UPDATE agents SET manager_user_id=$2 WHERE id=$1', [a.id, memberS.id]);
    const r = await as(memberS.cookie).post(`/api/agents/${a.id}/rehome`, body(second));
    expect(r.status).toBe(403);
    expect(r.body.error?.message ?? r.body.message).toBeTruthy();
    expect((await as(outsider.cookie).post(`/api/agents/${a.id}/rehome`, body(second))).status).toBe(404);
    expect((await as(memberS.cookie).get(`/api/agents/${a.id}/move-targets`)).status).toBe(403);
    expect((await agentRow(a.id)).workstation_id).toBe(w.workstationId);
  });

  it('refuses another organization, unknown, guest, unpaired and current workstations', async () => {
    const a = await hire();
    const o = owner();
    for (const id of [outsider.workstationId, '00000000-0000-4000-8000-000000000001', guest.workstationId]) {
      const r = await o.post(`/api/agents/${a.id}/rehome`, body(id));
      expect(r.status).toBe(404);
      expect(JSON.stringify(r.body)).toContain('workstation_not_found');
    }
    await q(`UPDATE workstations SET status='unlinked' WHERE id=$1`, [memberS.workstationId]);
    let r = await o.post(`/api/agents/${a.id}/rehome`, body(memberS.workstationId));
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain('workstation_unpaired');
    await q(`UPDATE workstations SET status='active' WHERE id=$1`, [memberS.workstationId]);
    r = await o.post(`/api/agents/${a.id}/rehome`, body(w.workstationId));
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain('same_workstation');
    expect((await agentRow(a.id)).workstation_id).toBe(w.workstationId);
    expect(await moved(a.id)).toHaveLength(0);
  });

  it('refuses an agent in a running shift or holding a claim, and it stays', async () => {
    const a = await hire();
    const shiftId = crypto.randomUUID();
    await q(
      `INSERT INTO shifts (id, org_id, agent_id, workstation_id, kind, status, runtime, model, started_at)
       VALUES ($1,$2,$3,$4,'chat','starting','mock','mock',now())`,
      [shiftId, orgId, a.id, w.workstationId],
    );
    for (const status of ['starting', 'running']) {
      await q('UPDATE shifts SET status=$2 WHERE id=$1', [shiftId, status]);
      const r = await owner().post(`/api/agents/${a.id}/rehome`, body(second));
      expect(r.status).toBe(409);
      expect(JSON.stringify(r.body)).toContain('agent_busy');
      expect((await agentRow(a.id)).workstation_id).toBe(w.workstationId);
    }
    expect(await moved(a.id)).toHaveLength(0);
    await q(`UPDATE shifts SET status='ended' WHERE id=$1`, [shiftId]);
    expect((await owner().post(`/api/agents/${a.id}/rehome`, body(second))).status).toBe(200);
  });

  it('re-homes a needs_rehome agent whose shift was left open by a silent runner', async () => {
    const a = await hire();
    await q(
      `INSERT INTO shifts (id, org_id, agent_id, workstation_id, kind, status, runtime, model, started_at)
       VALUES ($1,$2,$3,$4,'chat','running','mock','mock',now())`,
      [crypto.randomUUID(), orgId, a.id, w.workstationId],
    );
    await q(`UPDATE agents SET status='needs_rehome', workstation_id=NULL WHERE id=$1`, [a.id]);
    const r = await owner().post(`/api/agents/${a.id}/rehome`, body(second));
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('active');
    expect((await agentRow(a.id)).workstation_id).toBe(second);
  });

  it('refuses built-in agents and fired agents', async () => {
    const devops = (await q(`SELECT id FROM agents WHERE org_id=$1 AND is_devops LIMIT 1`, [orgId]))[0];
    if (devops) {
      const r = await owner().post(`/api/agents/${devops.id}/rehome`, body(second));
      expect(r.status).toBe(409);
      expect(JSON.stringify(r.body)).toContain('builtin_agent');
    }
    const ceo = (await q(`SELECT id FROM agents WHERE org_id=$1 AND role_key='ceo' LIMIT 1`, [orgId]))[0];
    if (ceo) {
      const r = await owner().post(`/api/agents/${ceo.id}/rehome`, body(second));
      expect(r.status).toBe(409);
      expect(JSON.stringify(r.body)).toContain('builtin_agent');
    }
    const a = await hire();
    await q(`UPDATE agents SET status='retired' WHERE id=$1`, [a.id]);
    const r = await owner().post(`/api/agents/${a.id}/rehome`, body(second));
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain('agent_retired');
  });

  it('writes the move to the audit log with actor, agent, old and new workstation', async () => {
    const a = await hire();
    await ok(owner().post(`/api/agents/${a.id}/rehome`, body(second)));
    const ev = await moved(a.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]!).toMatchObject({ actor_kind: 'user', actor_id: w.owner.id });
    expect(ev[0]!.payload).toMatchObject({
      agentId: a.id,
      fromWorkstationId: w.workstationId,
      workstationId: second,
    });
    const exp = await owner().get('/api/org/audit/export');
    expect(exp.status).toBe(200);
    const text = typeof exp.body === 'string' ? exp.body : JSON.stringify(exp.body);
    expect(text).toContain('AgentRehomed');
    expect(text).toContain(a.id);
  });

  it('lists the move targets: org members only, own first, current excluded', async () => {
    const a = await hire();
    const r = await owner().get(`/api/agents/${a.id}/move-targets`);
    expect(r.status).toBe(200);
    const ids = r.body.workstations.map((x: any) => x.id);
    expect(ids).not.toContain(w.workstationId);
    expect(ids).not.toContain(outsider.workstationId);
    expect(ids).not.toContain(guest.workstationId);
    expect(ids).toEqual(expect.arrayContaining([second, adminS.workstationId, memberS.workstationId]));
    expect(r.body.workstations[0].mine).toBe(true);
    expect(r.body.workstations.find((x: any) => x.id === second)).toMatchObject({ connected: true });
    expect(r.body.current).toMatchObject({ id: w.workstationId, state: 'connected' });
  });
});
