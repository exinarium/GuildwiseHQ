import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, pairWorkstation, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const dispatcher = () => w.t.app.ctx.services.dispatcher;
const reaper = () => w.t.app.ctx.services.reaper;
const get = <T = any>(url: string) => ok<T>(w.t.req('GET', url, { cookie: w.owner.cookie }));
const post = <T = any>(url: string, body: unknown = {}, status = 200) =>
  ok<T>(w.t.req('POST', url, { cookie: w.owner.cookie, body }), status);
const request = (summary: string, extra: Record<string, unknown> = {}) =>
  post('/api/devops/requests', { workstationId: w.workstationId, summary, ...extra }, 201);
const statusOf = async (id: string) =>
  (await q('SELECT status FROM devops_requests WHERE id=$1', [id]))[0]?.status as string;

/** Dispatches and returns the next devops shift.start the runner receives. */
async function nextDevopsShift(from: number) {
  await dispatcher().run();
  return r.waitFor('shift.start', (f) => f.kind === 'devops', 5000, from);
}
async function accept(start: { shiftId: string }) {
  r.accepted(start.shiftId);
  r.started(start.shiftId);
  await until(
    async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'running']))[0],
    3000,
    'devops shift running',
  );
}
async function report(shiftId: string, rep: Record<string, unknown>) {
  const { reportId } = r.report(shiftId, rep);
  return r.waitFor('shift.report.result', (f) => f.reportId === reportId);
}
const done = (summary: string, commands: string[] = []) => ({
  kind: 'outcome',
  outcomeId: 'devops_done',
  note: summary,
  data: { summary, commands },
});

describe('DevOps engineer per workstation', () => {
  it('pairing auto-hires exactly one DevOps engineer for the user and workstation', async () => {
    const agents = (await get('/api/agents')).agents.filter((a: any) => a.isDevops);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      roleKey: 'devops',
      seniority: 'senior',
      status: 'active',
      workstationId: w.workstationId,
      projectId: null,
      capacity: 1,
    });
    expect(agents[0].name).toBe('Atlas');
    // a second workstation gets its own, with a different name
    const second = await pairWorkstation(w.t, w.owner, 'Laptop');
    const all = (await get('/api/agents')).agents.filter((a: any) => a.isDevops);
    expect(all).toHaveLength(2);
    expect(new Set(all.map((a: any) => a.name)).size).toBe(2);
    expect(all.map((a: any) => a.workstationId).sort()).toEqual(
      [w.workstationId, second.workstationId].sort(),
    );
    const counted = await q(
      `SELECT count(*)::int AS n FROM agents WHERE is_devops AND status='active' AND workstation_id=$1`,
      [w.workstationId],
    );
    expect(counted[0]?.n).toBe(1);
  });

  it('the first hello points the DevOps runtime at one the workstation has', async () => {
    const a = (await get('/api/agents')).agents.find(
      (x: any) => x.isDevops && x.workstationId === w.workstationId,
    );
    expect(a.runtime).toBe('mock');
  });

  it('cannot be fired, only reset: the sandbox is wiped and the engineer stays', async () => {
    const a = (await get('/api/agents')).agents.find(
      (x: any) => x.isDevops && x.workstationId === w.workstationId,
    );
    const fired = await w.t.req('POST', `/api/agents/${a.id}/fire`, { cookie: w.owner.cookie });
    expect(fired.status).toBe(409);
    expect(fired.body.error.code).toBe('devops_cannot_be_fired');
    const reset = await post(`/api/agents/${a.id}/reset`);
    expect(reset).toMatchObject({ id: a.id, status: 'active' });
    const wipe = await r.waitFor('command', (f) => f.command === 'agent.wipe' && f.payload.agentId === a.id);
    expect(wipe).toBeTruthy();
    const ev = await q(`SELECT type FROM events WHERE stream_id=$1 AND type='AgentReset'`, [`agent-${a.id}`]);
    expect(ev).toHaveLength(1);
    // other roles cannot be reset
    const builder = await w.hire('Bea', 'builder', 'junior');
    const bad = await w.t.req('POST', `/api/agents/${builder.id}/reset`, { cookie: w.owner.cookie });
    expect(bad.status).toBe(409);
    // role, seniority and capacity are fixed
    const patch = await w.t.req('PATCH', `/api/agents/${a.id}`, {
      cookie: w.owner.cookie,
      body: { roleKey: 'builder' },
    });
    expect(patch.status).toBe(400);
  });

  it('keeps the DevOps agent out of the card dispatcher', async () => {
    await w.card({ title: 'Plain card' });
    await dispatcher().run();
    const devopsShifts = await q(
      `SELECT 1 FROM shifts s JOIN agents a ON a.id = s.agent_id WHERE a.is_devops AND s.kind='card'`,
    );
    expect(devopsShifts).toHaveLength(0);
  });
});

describe('DevOps request queue', () => {
  it('a manager request runs a DevOps shift and ends with EnvironmentChanged on the thread', async () => {
    const from = r.received.length;
    const created = await request('start the app');
    expect(created.request).toMatchObject({
      status: 'queued',
      summary: 'start the app',
      requestedBy: { kind: 'user' },
    });
    const start = await nextDevopsShift(from);
    expect(start.agent.isDevops).toBe(true);
    expect(start.worktree).toBeNull();
    expect(start.devops).toMatchObject({
      requestId: created.request.id,
      summary: 'start the app',
      workstationName: 'Desk',
      access: { allowInstall: false, allowDocker: false, sudo: false },
    });
    expect(start.brief.shift.outcomes.map((o) => o.id)).toEqual(['devops_done', 'devops_approval']);
    expect(await statusOf(created.request.id)).toBe('running');
    await accept(start);

    const res = await report(start.shiftId, done('started the app on :3000', ['npm start']));
    expect(res.accepted).toBe(true);
    // a second terminal report is refused
    expect((await report(start.shiftId, done('again'))).accepted).toBe(false);
    r.ended(start.shiftId, 'reported');
    await until(
      async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'ended']))[0],
    );

    const d = await get(`/api/devops/requests/${created.request.id}`);
    expect(d.request).toMatchObject({ status: 'done', resultSummary: 'started the app on :3000' });
    expect(d.changes).toHaveLength(1);
    expect(d.changes[0]).toMatchObject({ summary: 'started the app on :3000', commands: ['npm start'] });
    expect(d.messages.map((m: any) => m.kind)).toEqual(['comment', 'handoff']);
    const events = await q(
      `SELECT type FROM events WHERE stream_id=$1 OR type='EnvironmentChanged' ORDER BY seq`,
      [`thread-${created.request.id}`],
    );
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining([
        'DevOpsRequested',
        'DevOpsShiftDispatched',
        'EnvironmentChanged',
        'DevOpsRequestCompleted',
      ]),
    );
    const list = await get('/api/devops/requests');
    expect(list.requests.map((x: any) => x.id)).toContain(created.request.id);
  });

  it('a builder running `aom devops` opens a request thread linked to its card, FIFO with capacity one', async () => {
    const builder = (await get('/api/agents')).agents.find((a: any) => a.name === 'Bea');
    // Bea was dispatched to 'Plain card' (TOY-1) by the previous describe block.
    const start = r.of('shift.start').find((f) => f.agent.name === 'Bea');
    if (!start) throw new Error('Bea has no shift');
    r.accepted(start.shiftId);
    r.started(start.shiftId, {
      path: '/work/x',
      branchName: start.worktree?.branchName ?? 'x',
      baseBranch: 'main',
      created: true,
      headSha: 'abc',
    });
    const rpc = async (text: string) => {
      const rpcId = `rpc-${Math.random()}`;
      r.send('rpc.request', { rpcId, shiftId: start.shiftId, method: 'devops.request', params: { text } });
      return r.waitFor('rpc.response', (f) => f.rpcId === rpcId);
    };
    const first = await rpc('start the app');
    expect(first.ok).toBe(true);
    const second = await rpc('open port 8080');
    expect(second.ok).toBe(true);
    const id1 = (first.result as any).requestId as string;
    const id2 = (second.result as any).requestId as string;
    const row = (await q('SELECT * FROM devops_requests WHERE id=$1', [id1]))[0]!;
    expect(row).toMatchObject({
      requested_by_kind: 'agent',
      requested_by_id: builder.id,
      requested_by_name: 'Bea',
    });
    expect(row.card_id).toBeTruthy();
    const thread = (await q('SELECT kind, card_id FROM threads WHERE id=$1', [row.thread_id]))[0]!;
    expect(thread.kind).toBe('devops');

    // capacity one: the second waits for the first
    const mark = r.received.length;
    const s1 = await nextDevopsShift(mark);
    expect(s1.devops?.requestId).toBe(id1);
    expect(s1.devops?.card?.ref).toBe('TOY-1');
    await dispatcher().run();
    expect(
      r.received.slice(mark).filter((f) => f.type === 'shift.start' && f.kind === 'devops'),
    ).toHaveLength(1);
    expect(await statusOf(id2)).toBe('queued');
    await accept(s1);
    await report(s1.shiftId, done('app running'));
    r.ended(s1.shiftId, 'reported');
    await until(
      async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [s1.shiftId, 'ended']))[0],
    );
    const mark2 = r.received.length;
    const s2 = await nextDevopsShift(mark2);
    expect(s2.devops?.requestId).toBe(id2);
    await accept(s2);
    await report(s2.shiftId, done('port open'));
    r.ended(s2.shiftId, 'reported');
    // the builder shift is unaffected by the non-terminal request
    expect((await q('SELECT status FROM cards WHERE ref=$1', ['TOY-1']))[0]!.status).toBe('claimed');
    r.ended(start.shiftId, 'stopped');
  });

  it('a request outside the granted access ends in DevOpsApprovalNeeded and resumes after approval', async () => {
    const from = r.received.length;
    const created = await request('install docker');
    const start = await nextDevopsShift(from);
    await accept(start);
    const ask = await report(start.shiftId, {
      kind: 'outcome',
      outcomeId: 'devops_approval',
      note: 'needs docker',
      data: {
        action: 'install docker engine',
        reason: 'the tester needs Docker',
        commands: ['apt install docker.io'],
      },
    });
    expect(ask.accepted).toBe(true);
    r.ended(start.shiftId, 'reported');
    await until(async () => (await statusOf(created.request.id)) === 'needs_approval');
    const d = await get(`/api/devops/requests/${created.request.id}`);
    expect(d.request.approval).toMatchObject({
      action: 'install docker engine',
      reason: 'the tester needs Docker',
      commands: ['apt install docker.io'],
      resolution: null,
    });
    const events = await q(
      `SELECT payload FROM events WHERE type='DevOpsApprovalNeeded' AND payload->>'requestId'=$1`,
      [created.request.id],
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.deskItemId).toBe(d.request.approval.deskItemId);

    // while waiting for the manager nothing is dispatched
    const mark = r.received.length;
    await dispatcher().run();
    expect(
      r.received.slice(mark).filter((f) => f.type === 'shift.start' && f.kind === 'devops'),
    ).toHaveLength(0);

    // only the workstation owner can answer; answering twice is refused
    const other = await w.t.userSession(uniqueEmail('stranger'));
    const nope = await w.t.req('POST', `/api/devops/requests/${created.request.id}/resolve`, {
      cookie: other.cookie,
      body: { resolution: 'approved' },
    });
    expect(nope.status).toBe(404);
    const approved = await post(`/api/devops/requests/${created.request.id}/resolve`, {
      resolution: 'approved',
      note: 'go ahead',
    });
    expect(approved.request.approval.resolution).toBe('approved');
    expect(approved.messages.at(-1)).toMatchObject({ kind: 'answer', authorKind: 'user' });
    const again = await w.t.req('POST', `/api/devops/requests/${created.request.id}/resolve`, {
      cookie: w.owner.cookie,
      body: { resolution: 'approved' },
    });
    expect(again.status).toBe(409);

    const resumed = await nextDevopsShift(mark);
    expect(resumed.devops?.requestId).toBe(created.request.id);
    expect(resumed.devops?.approval).toMatchObject({ action: 'install docker engine', note: 'go ahead' });
    await accept(resumed);
    await report(resumed.shiftId, done('docker installed', ['apt install docker.io']));
    r.ended(resumed.shiftId, 'reported');
    await until(async () => (await statusOf(created.request.id)) === 'done');
  });

  it('a rejected approval fails the request', async () => {
    const from = r.received.length;
    const created = await request('delete the old build output');
    const start = await nextDevopsShift(from);
    await accept(start);
    await report(start.shiftId, {
      kind: 'outcome',
      outcomeId: 'devops_approval',
      note: 'destructive',
      data: { action: 'rm -rf build/', reason: 'destructive', commands: ['rm -rf build/'] },
    });
    r.ended(start.shiftId, 'reported');
    await until(async () => (await statusOf(created.request.id)) === 'needs_approval');
    const rej = await post(`/api/devops/requests/${created.request.id}/resolve`, {
      resolution: 'rejected',
      note: 'no',
    });
    expect(rej.request).toMatchObject({ status: 'failed', resultSummary: 'Approval rejected: no' });
  });

  it('granted access is passed to the DevOps shift and can be changed by the workstation owner only', async () => {
    const patched = await ok<any>(
      w.t.req('PATCH', `/api/workstations/${w.workstationId}/devops-access`, {
        cookie: w.owner.cookie,
        body: { allowInstall: true, allowedPaths: ['/srv/apps'] },
      }),
    );
    expect(patched.devopsAccess).toEqual({
      allowInstall: true,
      allowDocker: false,
      allowedPaths: ['/srv/apps'],
      sudo: false,
    });
    const other = await w.t.userSession(uniqueEmail('stranger2'));
    const nope = await w.t.req('PATCH', `/api/workstations/${w.workstationId}/devops-access`, {
      cookie: other.cookie,
      body: { sudo: true },
    });
    expect(nope.status).toBe(404);
    const from = r.received.length;
    const created = await request('install jq');
    const start = await nextDevopsShift(from);
    expect(start.devops?.access).toEqual({
      allowInstall: true,
      allowDocker: false,
      allowedPaths: ['/srv/apps'],
      sudo: false,
    });
    await accept(start);
    await report(start.shiftId, done('installed jq', ['apt install jq']));
    r.ended(start.shiftId, 'reported');
    await until(async () => (await statusOf(created.request.id)) === 'done');
  });

  it('requeues a request when the runner rejects or never accepts the shift, and fails it when the shift crashes', async () => {
    // rejected by the runner
    const from = r.received.length;
    const a = await request('check disk space');
    const s1 = await nextDevopsShift(from);
    r.rejected(s1.shiftId, 'busy');
    await until(async () => (await statusOf(a.request.id)) === 'queued');
    expect((await q('SELECT status, outcome FROM shifts WHERE id=$1', [s1.shiftId]))[0]).toMatchObject({
      status: 'ended',
      outcome: 'rejected',
    });
    // never accepted within 30 s
    dispatcher().cooldown.clear();
    const s2 = await nextDevopsShift(r.received.length);
    expect(s2.devops?.requestId).toBe(a.request.id);
    w.t.clock.advance(31_000);
    r.heartbeat();
    await reaper().run();
    await until(async () => (await statusOf(a.request.id)) === 'queued');
    // crashed after starting: the request fails with the runner's last text
    dispatcher().cooldown.clear();
    const s3 = await nextDevopsShift(r.received.length);
    await accept(s3);
    r.ended(s3.shiftId, 'crashed', { finalText: 'segfault' });
    await until(async () => (await statusOf(a.request.id)) === 'failed');
    const d = await get(`/api/devops/requests/${a.request.id}`);
    expect(d.request.resultSummary).toContain('segfault');
    expect(d.messages.at(-1)).toMatchObject({ kind: 'system' });
  });

  it('only the workstation owner sees requests and threads', async () => {
    const created = await request('private request');
    const other = await w.t.userSession(uniqueEmail('stranger3'));
    const list = await ok<any>(w.t.req('GET', '/api/devops/requests', { cookie: other.cookie }));
    expect(list.requests).toEqual([]);
    const one = await w.t.req('GET', `/api/devops/requests/${created.request.id}`, { cookie: other.cookie });
    expect(one.status).toBe(404);
    const make = await w.t.req('POST', '/api/devops/requests', {
      cookie: other.cookie,
      body: { workstationId: w.workstationId, summary: 'sneaky' },
    });
    expect(make.status).toBe(404);
  });
});
