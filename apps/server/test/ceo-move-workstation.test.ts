import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { act, appoint, startCeoShift, wakeNow } from './helpers/ceo.ts';
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
const hire = () => w.hire(`Walker${++n}`, 'builder', 'junior');
const move = async (agent: string, target: string, extra: Record<string, unknown> = {}) =>
  (await act(r, shiftId, 'move-workstation', { agentId: agent, targetWorkstationId: target }, extra)).result;
const homeOf = async (id: string) =>
  (await q('SELECT workstation_id FROM agents WHERE id=$1', [id]))[0]!.workstation_id;
const audit = (agentId: string, mode: string) =>
  q(
    `SELECT payload, actor FROM events WHERE type='CeoActionTaken' AND payload->>'class'='agent.move_workstation'
       AND payload->>'subjectId'=$1 AND payload->>'mode'=$2 ORDER BY seq`,
    [agentId, mode],
  );

describe('CEO action move-workstation', () => {
  it('under the default policy it is recommended and nothing moves', async () => {
    await setMode('agent.move_workstation', 'recommend');
    const a = await hire();
    const res = await move(a.name, 'second');
    expect(res.status).toBe('recommended');
    expect(await homeOf(a.id)).toBe(w.workstationId);
  });

  it('a dry run moves and writes nothing', async () => {
    await setMode('agent.move_workstation', 'decide');
    const a = await hire();
    const res = await move(a.name, 'second', { dryRun: true });
    expect(res.status).toBe('dry_run');
    expect(await homeOf(a.id)).toBe(w.workstationId);
    expect(await audit(a.id, 'decided')).toHaveLength(0);
  });

  it('moves the agent as the owner move does, with the CEO as actor', async () => {
    await setMode('agent.move_workstation', 'decide');
    const a = await hire();
    const res = await move(a.name, second);
    expect(res.status).toBe('executed');
    expect(await homeOf(a.id)).toBe(second);
    const ev = await q(`SELECT actor, payload FROM events WHERE stream_id=$1 AND type='AgentRehomed'`, [
      `agent-${a.id}`,
    ]);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.actor.kind).toBe('agent');
    expect(ev[0]!.payload).toMatchObject({ fromWorkstationId: w.workstationId, workstationId: second });
    expect(await audit(a.id, 'decided')).toHaveLength(1);
  });

  it('refuses invalid targets with the reason, audits the refusal and leaves the agent', async () => {
    await setMode('agent.move_workstation', 'decide');
    const a = await hire();
    const cases: Array<[string, string]> = [
      ['unknown-box', 'workstation not found'],
      [outsiderBox, 'workstation not found'],
      [w.workstationId, 'already works on'],
      [memberBox, 'belongs to another member'],
    ];
    for (const [target, text] of cases) {
      const res = await move(a.name, target);
      expect(res.status, target).toBe('refused');
      expect(res.message).toContain(text);
    }
    expect(await homeOf(a.id)).toBe(w.workstationId);
    expect((await audit(a.id, 'refused')).length).toBe(cases.length);
  });

  it('refuses an agent in a running shift, and the retry after it ends is not a duplicate', async () => {
    await setMode('agent.move_workstation', 'decide');
    const a = await hire();
    const sid = crypto.randomUUID();
    await q(
      `INSERT INTO shifts (id, org_id, agent_id, workstation_id, kind, status, runtime, model, started_at)
       VALUES ($1,$2,$3,$4,'chat','running','mock','mock',now())`,
      [sid, orgId, a.id, w.workstationId],
    );
    const refused = await move(a.name, second, { key: 'same-key' });
    expect(refused.status).toBe('refused');
    expect(refused.message).toContain('running shift');
    expect(await homeOf(a.id)).toBe(w.workstationId);
    await q(`UPDATE shifts SET status='ended' WHERE id=$1`, [sid]);
    const again = await move(a.name, second, { key: 'same-key' });
    expect(again.status).toBe('executed');
    expect(await homeOf(a.id)).toBe(second);
  });

  it('refuses the CEO and the DevOps agent', async () => {
    await setMode('agent.move_workstation', 'decide');
    for (const sel of [`role_key='ceo'`, 'is_devops']) {
      const row = (await q(`SELECT id FROM agents WHERE org_id=$1 AND ${sel} LIMIT 1`, [orgId]))[0];
      if (!row) continue;
      const res = await move(row.id, second);
      expect(res.status).toBe('refused');
    }
  });

  it('agent.allow_list (allow) still only changes projects', async () => {
    const a = await hire();
    const res = (await act(r, shiftId, 'allow', { agent: a.name, projects: 'TOY' })).result;
    expect(res.status).toBe('executed');
    expect(await homeOf(a.id)).toBe(w.workstationId);
  });
});
