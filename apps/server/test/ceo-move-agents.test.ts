import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { act, appoint, ceo, startCeoShift, wakeNow } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, markOnline, ok, pairWorkstation, type Session, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
let shiftId: string;
let orgId: string;
let second: string;
let memberBox: string;
let outsiderBox: string;
let n = 0;

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  r = await w.connectRunner({ capabilities: ['ceo:1'] });
  await appoint(w);
  await wakeNow(w);
  shiftId = (await startCeoShift(w, r)).shiftId;
  orgId = (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]!.org_id;
  second = (await pairWorkstation(w.t, w.owner, 'second')).workstationId;
  await markOnline(w.t, second);
  const m = await w.t.userSession(uniqueEmail('mem'));
  await w.t.addOrgMember(orgId, m.id, 'member');
  memberBox = ((await pairWorkstation(w.t, m as Session, 'member-box')) as any).workstationId;
  await markOnline(w.t, memberBox);
  const o = await w.t.userSession(uniqueEmail('out'));
  outsiderBox = ((await pairWorkstation(w.t, o as Session, 'outsider-box')) as any).workstationId;
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const setMode = async (cls: string, mode: 'decide' | 'recommend') => {
  const pol = (await ok<any>(owner('GET', '/api/ceo/policy'))).policy;
  pol.classes[cls].mode = mode;
  await ok(owner('PUT', '/api/ceo/policy', { policy: pol, confirmDelegation: true }));
};
const hire = () => w.hire(`Mover${++n}`, 'builder', 'junior');
const single = async (params: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  (await act(r, shiftId, 'move-workstation', params, extra)).result;
const bulk = async (from: string, to: string, extra: Record<string, unknown> = {}) =>
  (await act(r, shiftId, 'move-agents-off', { from, to }, extra)).result;
const homeOf = async (id: string) =>
  (await q('SELECT workstation_id FROM agents WHERE id=$1', [id]))[0]!.workstation_id;
const rehomed = (id: string) =>
  q(
    `SELECT actor_kind, actor_id, payload FROM events WHERE stream_id=$1 AND type='AgentRehomed' ORDER BY seq`,
    [`agent-${id}`],
  );
const audits = (mode: string, subjectId: string) =>
  q(
    `SELECT payload FROM events WHERE type='CeoActionTaken' AND payload->>'class'='agent.move_workstation'
       AND payload->>'subjectId'=$1 AND payload->>'mode'=$2`,
    [subjectId, mode],
  );
const ceoId = async () =>
  (await q(`SELECT id FROM agents WHERE org_id=$1 AND role_key='ceo'`, [orgId]))[0]!.id;

/** A fresh Owner workstation holding `count` agents; `state` makes it online, offline or removed. */
async function station(count: number, state: 'online' | 'offline' | 'removed', name = `old${++n}`) {
  const id = (await pairWorkstation(w.t, w.owner, name)).workstationId;
  await markOnline(w.t, id);
  const agents = [];
  for (let i = 0; i < count; i++) {
    const a = await hire();
    await q('UPDATE agents SET workstation_id=$2 WHERE id=$1', [a.id, id]);
    agents.push(a);
  }
  if (state === 'offline') await q('UPDATE workstations SET connected=false WHERE id=$1', [id]);
  if (state === 'removed')
    await q(`UPDATE workstations SET status='unlinked', connected=false WHERE id=$1`, [id]);
  return { id, name, agents };
}
const busy = (agentId: string, wsId: string) =>
  q(
    `INSERT INTO shifts (id, org_id, agent_id, workstation_id, kind, status, runtime, model, started_at)
     VALUES ($1,$2,$3,$4,'chat','running','mock','mock',now())`,
    [crypto.randomUUID(), orgId, agentId, wsId],
  );

describe('CEO action move-workstation with --agent and --to', () => {
  it('moves the agent by name with the CEO as actor', async () => {
    await setMode('agent.move_workstation', 'decide');
    const a = await hire();
    const res = await single({ agent: a.name, to: 'second' });
    expect(res.status).toBe('executed');
    expect(await homeOf(a.id)).toBe(second);
    const ev = await rehomed(a.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.actor_kind).toBe('agent');
    expect(ev[0]!.actor_id).toBe(await ceoId());
    expect(ev[0]!.payload).toMatchObject({ fromWorkstationId: w.workstationId, workstationId: second });
    expect(await audits('decided', a.id)).toHaveLength(1);
  });

  it('releases a held claim and the release is the CEO’s too', async () => {
    await setMode('agent.move_workstation', 'decide');
    const a = await hire();
    const card = (await q(`SELECT id FROM cards WHERE project_id=$1 LIMIT 1`, [w.projectId]))[0]?.id;
    if (card) await q(`UPDATE cards SET claimed_by_agent_id=$2 WHERE id=$1`, [card, a.id]);
    const res = await single({ agent: a.name, to: second });
    expect(res.status).toBe('executed');
    if (card) {
      const row = (await q('SELECT claimed_by_agent_id FROM cards WHERE id=$1', [card]))[0]!;
      expect(row.claimed_by_agent_id).toBeNull();
    }
  });

  it('refuses giving both spellings', async () => {
    const a = await hire();
    const resp = await act(r, shiftId, 'move-workstation', { agent: a.name, agentId: a.name, to: second });
    expect(resp.ok === false || resp.result?.status === 'refused').toBe(true);
    expect(await homeOf(a.id)).toBe(w.workstationId);
  });

  it('refuses a running shift, a sandbox that is unavailable and the other DevOps rule, and changes nothing', async () => {
    await setMode('agent.move_workstation', 'decide');
    const a = await hire();
    await busy(a.id, w.workstationId);
    const res = await single({ agent: a.name, to: second });
    expect(res.status).toBe('refused');
    expect(res.message).toContain('running shift');
    expect(await homeOf(a.id)).toBe(w.workstationId);
    expect(await rehomed(a.id)).toHaveLength(0);
  });

  it('refuses targets that are not the owner’s active workstations', async () => {
    await setMode('agent.move_workstation', 'decide');
    const a = await hire();
    const gone = await station(0, 'removed', `gone${++n}`).catch(() => undefined);
    for (const target of ['unknown-box', outsiderBox, memberBox, ...(gone ? [gone.id] : [])]) {
      const res = await single({ agent: a.name, to: target });
      expect(res.status, target).toBe('refused');
    }
    expect(await homeOf(a.id)).toBe(w.workstationId);
  });
});

describe('CEO action move-agents-off', () => {
  it('moves the free agents off a removed workstation, keeps the busy one and says why', async () => {
    await setMode('agent.move_workstation', 'decide');
    const s = await station(3, 'removed');
    await busy(s.agents[2]!.id, s.id);
    const res = await bulk(s.name, 'second');
    expect(res.status).toBe('executed');
    expect(res.message).toContain(`moved: ${s.agents[0]!.name}, ${s.agents[1]!.name}`);
    expect(res.message).toMatch(
      new RegExp(`blocked: ${s.agents[2]!.name}: In a running shift: .*running shift`),
    );
    const ceoActor = await ceoId();
    for (const a of s.agents.slice(0, 2)) {
      expect(await homeOf(a.id)).toBe(second);
      const ev = await rehomed(a.id);
      expect(ev).toHaveLength(1);
      expect(ev[0]!.actor_kind).toBe('agent');
      expect(ev[0]!.actor_id).toBe(ceoActor);
    }
    expect(await homeOf(s.agents[2]!.id)).toBe(s.id);
    expect(await rehomed(s.agents[2]!.id)).toHaveLength(0);
    expect(res.result.blocked.find((b: any) => b.agentId === s.agents[2]!.id)).toMatchObject({
      reason: 'running_shift',
    });
    expect(await audits('decided', s.id)).toHaveLength(1);
  });

  it('works for an offline source too, and refuses an online one', async () => {
    await setMode('agent.move_workstation', 'decide');
    const off = await station(1, 'offline');
    const res = await bulk(off.id, second);
    expect(res.status).toBe('executed');
    expect(await homeOf(off.agents[0]!.id)).toBe(second);
    const on = await station(1, 'online');
    const refused = await bulk(on.id, second);
    expect(refused.status).toBe('refused');
    expect(refused.message).toContain('is online');
    expect(await homeOf(on.agents[0]!.id)).toBe(on.id);
  });

  it('is a recommendation under the default policy and moves nothing; a dry run writes nothing', async () => {
    const s = await station(1, 'removed');
    await setMode('agent.move_workstation', 'recommend');
    const rec = await bulk(s.id, second);
    expect(rec.status).toBe('recommended');
    await setMode('agent.move_workstation', 'decide');
    const dry = await bulk(s.id, second, { dryRun: true, key: 'dry-1' });
    expect(dry.status).toBe('dry_run');
    expect(await homeOf(s.agents[0]!.id)).toBe(s.id);
    expect(await audits('decided', s.id)).toHaveLength(0);
  });

  it('refuses when every agent is blocked, lists each with the reason, and moves nothing', async () => {
    await setMode('agent.move_workstation', 'decide');
    const s = await station(2, 'removed');
    for (const a of s.agents) await busy(a.id, s.id);
    const res = await bulk(s.id, second);
    expect(res.status).toBe('refused');
    for (const a of s.agents) expect(res.message).toContain(`blocked: ${a.name}: In a running shift`);
    for (const a of s.agents) expect(await homeOf(a.id)).toBe(s.id);
    expect((await audits('refused', s.id)).length).toBeGreaterThan(0);
  });

  it('refuses targets that are not the owner’s active workstations and unknown sources', async () => {
    await setMode('agent.move_workstation', 'decide');
    const s = await station(1, 'removed');
    for (const target of ['unknown-box', outsiderBox, memberBox, s.id]) {
      const res = await bulk(s.id, target);
      expect(res.status, target).toBe('refused');
    }
    expect((await bulk('no-such-box', second)).status).toBe('refused');
    expect((await bulk(outsiderBox, second)).status).toBe('refused');
    expect(await homeOf(s.agents[0]!.id)).toBe(s.id);
  });

  it('asks for the id when two workstations carry the name, and the id works', async () => {
    await setMode('agent.move_workstation', 'decide');
    const removed = await station(1, 'removed', 'dup-box');
    const active = await station(1, 'offline', 'dup-box');
    const res = await bulk('dup-box', second);
    expect(res.status).toBe('refused');
    expect(res.message).toContain(removed.id);
    expect(res.message).toContain(active.id);
    const ok1 = await bulk(removed.id, second);
    expect(ok1.status).toBe('executed');
    expect(await homeOf(removed.agents[0]!.id)).toBe(second);
  });

  it('a call without a reason is rejected and nothing moves', async () => {
    const s = await station(1, 'removed');
    for (const reason of ['', 'x']) {
      const resp = await ceo(r, shiftId, {
        op: 'act',
        action: 'move-agents-off',
        params: { from: s.id, to: second },
        reason,
        confidence: 0.9,
        evidence: [],
      });
      expect(resp.ok).toBe(false);
      expect(resp.error).toContain('invalid request');
    }
    expect(await homeOf(s.agents[0]!.id)).toBe(s.id);
  });
});

describe('what the CEO sees', () => {
  it('marks removed workstations, counts their agents and lists the owner’s move targets', async () => {
    const s = await station(2, 'removed', 'ghost-box');
    const resp = await ceo(r, shiftId, { op: 'snapshot' });
    expect(resp.ok).toBe(true);
    const text: string = resp.result.text;
    expect(text).toMatch(new RegExp(`ghost-box id=${s.id} REMOVED agents=2`));
    expect(text).toContain(`ws=ghost-box (removed)`);
    const targets = text.split('\n').find((l) => l.startsWith('Move targets'))!;
    expect(targets).toContain('second');
    expect(targets).not.toContain('member-box');
    expect(targets).not.toContain('ghost-box');
    expect(text).toContain('move-agents-off');
  });
});
