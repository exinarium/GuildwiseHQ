import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { devopsLane, devopsQueuePosition } from '../src/dispatcher/devops.ts';
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
      hiredForProjectId: null,
      allowedProjectIds: null,
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
    // the approval is a pinned, open item on the owner's desk (and only theirs)
    const desk = await q(
      `SELECT kind, subkind, status, pinned, project_id, card_id, org_id FROM desk_items WHERE id=$1`,
      [d.request.approval.deskItemId],
    );
    expect(desk).toEqual([
      expect.objectContaining({
        kind: 'approval',
        subkind: 'devops',
        status: 'open',
        pinned: true,
        project_id: null,
        card_id: null,
        org_id: w.owner.id,
      }),
    ]);

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
    // resolving on the DevOps page closes the desk item too
    expect(
      (await q(`SELECT status FROM desk_items WHERE id=$1`, [d.request.approval.deskItemId]))[0]!.status,
    ).toBe('answered');
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

  it('a rejection on the desk fails the request; a stranger cannot resolve the item', async () => {
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
    const deskItemId = (await get(`/api/devops/requests/${created.request.id}`)).request.approval.deskItemId;
    const other = await w.t.userSession(uniqueEmail('stranger'));
    expect(
      (
        await w.t.req('POST', `/api/desk/${deskItemId}/resolve`, {
          cookie: other.cookie,
          body: { resolution: 'rejected' },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await w.t.req('POST', `/api/desk/${deskItemId}/resolve`, {
          cookie: w.owner.cookie,
          body: { resolution: 'acknowledged' },
        })
      ).status,
    ).toBe(400);
    const res = await w.t.req('POST', `/api/desk/${deskItemId}/resolve`, {
      cookie: w.owner.cookie,
      body: { resolution: 'rejected', note: 'no' },
    });
    expect(res.status).toBe(200);
    expect((await get(`/api/devops/requests/${created.request.id}`)).request).toMatchObject({
      status: 'failed',
      resultSummary: 'Approval rejected: no',
    });
    expect((await q(`SELECT status FROM desk_items WHERE id=$1`, [deskItemId]))[0]!.status).toBe('answered');
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
    // a partial patch keeps what was granted before (no defaults leak back in)
    const more = await ok<any>(
      w.t.req('PATCH', `/api/workstations/${w.workstationId}/devops-access`, {
        cookie: w.owner.cookie,
        body: { allowDocker: true },
      }),
    );
    expect(more.devopsAccess).toEqual({
      allowInstall: true,
      allowDocker: true,
      allowedPaths: ['/srv/apps'],
      sudo: false,
    });
    await ok<any>(
      w.t.req('PATCH', `/api/workstations/${w.workstationId}/devops-access`, {
        cookie: w.owner.cookie,
        body: { allowDocker: false },
      }),
    );
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

describe('DevOps queue: waited-on first, plus an express slot', () => {
  const min = 60_000;
  const at = (agoMs: number) => new Date(w.t.clock.now().getTime() - agoMs);

  it('devopsLane: one slot at the head; a second only for a waited-on request of another card behind a 5-minute run', () => {
    const now = new Date('2026-11-14T12:00:00Z');
    const ago = (ms: number) => new Date(now.getTime() - ms);
    expect(devopsLane([], { cardId: null, waited: false }, now)).toBe('normal');
    const long = [{ startedAt: ago(6 * min), cardId: 'card-a' }];
    expect(devopsLane(long, { cardId: 'card-b', waited: true }, now)).toBe('express');
    expect(devopsLane(long, { cardId: 'card-b', waited: false }, now)).toBeNull();
    expect(devopsLane(long, { cardId: 'card-a', waited: true }, now)).toBeNull();
    expect(devopsLane(long, { cardId: null, waited: true }, now)).toBeNull();
    expect(
      devopsLane([{ startedAt: ago(1 * min), cardId: 'card-a' }], { cardId: 'card-b', waited: true }, now),
    ).toBeNull();
    const two = [...long, { startedAt: ago(10 * min), cardId: 'card-c' }];
    expect(devopsLane(two, { cardId: 'card-b', waited: true }, now)).toBeNull();
  });

  it('with a long request running, a waited-on request of another card starts before an older one nobody waits for', async () => {
    // A clean queue for this engineer.
    await q(
      `UPDATE devops_requests SET status='failed' WHERE status IN ('queued','running','needs_approval')`,
    );
    await q(`UPDATE shifts SET status='ended' WHERE kind='devops' AND status <> 'ended'`);
    // Card Y: a builder holds a shift on it.
    await w.hire('Cid', 'builder', 'junior');
    const cardY = await w.card({ title: 'Needs a port' });
    const mark0 = r.received.length;
    let start: any;
    await until(
      async () => {
        await dispatcher().run();
        start = r.received
          .slice(mark0)
          .find((f: any) => f.type === 'shift.start' && f.kind === 'card' && f.brief.card.id === cardY.id);
        return Boolean(start);
      },
      10_000,
      'a card shift on card Y',
    );
    r.accepted(start.shiftId);
    r.started(start.shiftId, {
      path: '/work/y',
      branchName: start.worktree?.branchName ?? 'y',
      baseBranch: 'main',
      created: true,
      headSha: 'abc',
    });
    await until(
      async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'running']))[0],
      3000,
      'card shift running',
    );

    // A: a long request runs.
    const a = await request('migrate the whole database');
    const sA = await nextDevopsShift(r.received.length);
    expect(sA.devops?.requestId).toBe(a.request.id);
    await accept(sA);
    await q('UPDATE shifts SET started_at=$2 WHERE id=$1', [sA.shiftId, at(1 * min)]);
    // B: nobody waits for it. C: card Y's builder asks during its shift and waits.
    const b = await request('tidy the scratch folder');
    const rpcId = `rpc-${Math.random()}`;
    r.send('rpc.request', {
      rpcId,
      shiftId: start.shiftId,
      method: 'devops.request',
      params: { text: 'open port 8080' },
    });
    const c = await r.waitFor('rpc.response', (f) => f.rpcId === rpcId);
    expect(c.ok).toBe(true);
    const idC = (c.result as any).requestId as string;
    expect(await devopsQueuePosition(w.t.app.ctx.pool, idC, { now: w.t.clock.now() })).toEqual({
      state: 'queued',
      position: 1,
      of: 2,
    });
    expect(await devopsQueuePosition(w.t.app.ctx.pool, b.request.id, { now: w.t.clock.now() })).toEqual({
      state: 'queued',
      position: 2,
      of: 2,
    });
    expect(await devopsQueuePosition(w.t.app.ctx.pool, a.request.id, { now: w.t.clock.now() })).toEqual({
      state: 'running',
    });

    // A has run for a minute: capacity one still holds.
    const mark1 = r.received.length;
    await dispatcher().run();
    await r.barrier();
    expect(
      r.received.slice(mark1).filter((f) => f.type === 'shift.start' && f.kind === 'devops'),
    ).toHaveLength(0);

    // A has run for six minutes: the express slot takes C (the old FIFO, capacity one, would have started nothing).
    await q('UPDATE shifts SET started_at=$2 WHERE id=$1', [sA.shiftId, at(6 * min)]);
    const sC = await nextDevopsShift(r.received.length);
    expect(sC.devops?.requestId).toBe(idC);
    await dispatcher().run();
    await r.barrier();
    expect(await statusOf(b.request.id)).toBe('queued');
    const open = await q(
      `SELECT 1 FROM shifts s JOIN agents ag ON ag.id = s.agent_id WHERE ag.is_devops AND s.kind='devops' AND s.status <> 'ended'`,
    );
    expect(open).toHaveLength(2);
    expect(
      r.received.slice(mark1).filter((f) => f.type === 'shift.start' && f.kind === 'devops'),
    ).toHaveLength(1);

    for (const s of [sA, sC]) {
      if (s === sC) await accept(sC);
      await report(s.shiftId, done('finished'));
      r.ended(s.shiftId, 'reported');
    }
    r.ended(start.shiftId, 'stopped');
  });
  it('a request nobody waits for joins the waited-on tier after 30 minutes; a Test deploy environment request is waited on', async () => {
    await q(
      `UPDATE devops_requests SET status='failed' WHERE status IN ('queued','running','needs_approval')`,
    );
    await q(`UPDATE shifts SET status='ended' WHERE kind='devops' AND status <> 'ended'`);
    const now = () => w.t.clock.now();
    const pos = async (id: string) => devopsQueuePosition(w.t.app.ctx.pool, id, { now: now() });
    const old = (await request('nobody waits for this')).request.id as string;
    const parked = (await request('a card is parked on this')).request.id as string;
    const card = await w.card({ title: 'Parked on DevOps' });
    await q(`UPDATE cards SET status='waiting', parked_request_id=$2 WHERE id=$1`, [card.id, parked]);
    expect(await pos(parked)).toEqual({ state: 'queued', position: 1, of: 2 });
    expect(await pos(old)).toEqual({ state: 'queued', position: 2, of: 2 });
    // 29 minutes old: still behind; 31 minutes old: in the waited-on tier, and the older of the two
    await q('UPDATE devops_requests SET created_at=$2 WHERE id=$1', [
      old,
      new Date(now().getTime() - 29 * 60_000),
    ]);
    expect(await pos(old)).toEqual({ state: 'queued', position: 2, of: 2 });
    await q('UPDATE devops_requests SET created_at=$2 WHERE id=$1', [
      old,
      new Date(now().getTime() - 31 * 60_000),
    ]);
    expect(await pos(old)).toEqual({ state: 'queued', position: 1, of: 2 });
    expect(await pos(parked)).toEqual({ state: 'queued', position: 2, of: 2 });
    // the dispatcher uses the same order: the aged request starts first
    const s1 = await nextDevopsShift(r.received.length);
    expect(s1.devops?.requestId).toBe(old);
    await accept(s1);
    await report(s1.shiftId, done('done'));
    r.ended(s1.shiftId, 'reported');
    await until(
      async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [s1.shiftId, 'ended']))[0],
    );

    // The server's environment request for a card held at Test deploy counts as waited on from the start.
    const plain = (await request('another one nobody waits for')).request.id as string;
    const envReq = (await request('make the app run for the integration tests')).request.id as string;
    const row = (await q('SELECT org_id FROM devops_requests WHERE id=$1', [envReq]))[0]!;
    await q(
      `INSERT INTO run_environments (id, org_id, project_id, workstation_id, purpose, card_id, state, devops_request_id,
          branch_key, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'test',$5,'requested',$6,'k',$7,$7)`,
      [randomUUID(), row.org_id, w.projectId, w.workstationId, card.id, envReq, now()],
    );
    expect(await pos(envReq)).toEqual({ state: 'queued', position: 2, of: 3 });
    expect(await pos(plain)).toEqual({ state: 'queued', position: 3, of: 3 });
    for (const id of [parked, plain, envReq])
      await q(`UPDATE devops_requests SET status='failed' WHERE id=$1`, [id]);
    await q(`UPDATE cards SET status='queued', parked_request_id=NULL WHERE id=$1`, [card.id]);
  });
  it('the express slot is only for requests an agent or a parked card waits on: aged and Test deploy requests wait for slot 1', async () => {
    await q(
      `UPDATE devops_requests SET status='failed' WHERE status IN ('queued','running','needs_approval')`,
    );
    await q(`UPDATE shifts SET status='ended' WHERE kind='devops' AND status <> 'ended'`);
    const now = () => w.t.clock.now();
    // A long request runs (6 minutes: the express window is open).
    const a = await request('a long migration');
    const sA = await nextDevopsShift(r.received.length);
    await accept(sA);
    await q('UPDATE shifts SET started_at=$2 WHERE id=$1', [
      sA.shiftId,
      new Date(now().getTime() - 6 * 60_000),
    ]);
    // An aged request of card P, and the Test deploy environment request of card Q: both in the waited-on tier.
    const p = await w.card({ title: 'Aged card' });
    const qc = await w.card({ title: 'Held at Test deploy' });
    const aged = (await request('nobody waits, but it is old')).request.id as string;
    await q('UPDATE devops_requests SET card_id=$2, created_at=$3 WHERE id=$1', [
      aged,
      p.id,
      new Date(now().getTime() - 31 * 60_000),
    ]);
    const envReq = (await request('make the app run for the integration tests')).request.id as string;
    await q('UPDATE devops_requests SET card_id=$2 WHERE id=$1', [envReq, qc.id]);
    const row = (await q('SELECT org_id FROM devops_requests WHERE id=$1', [envReq]))[0]!;
    await q(
      `INSERT INTO run_environments (id, org_id, project_id, workstation_id, purpose, card_id, state, devops_request_id,
          branch_key, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'test',$5,'requested',$6,'k2',$7,$7)`,
      [randomUUID(), row.org_id, w.projectId, w.workstationId, qc.id, envReq, now()],
    );
    expect(await devopsQueuePosition(w.t.app.ctx.pool, aged, { now: now() })).toEqual({
      state: 'queued',
      position: 1,
      of: 2,
    });
    const mark = r.received.length;
    await dispatcher().run();
    await r.barrier();
    expect(
      r.received.slice(mark).filter((f) => f.type === 'shift.start' && f.kind === 'devops'),
    ).toHaveLength(0);
    expect(await statusOf(aged)).toBe('queued');
    // Never dispatched (the later test-environment pass of the same run may fail it: its environment row is a stub).
    expect((await q('SELECT shift_id FROM devops_requests WHERE id=$1', [envReq]))[0]!.shift_id).toBeNull();
    // A card parked on the aged request: now an agent's card waits on it, and the express slot takes it.
    await q(`UPDATE cards SET status='waiting', parked_request_id=$2 WHERE id=$1`, [p.id, aged]);
    const sX = await nextDevopsShift(mark);
    expect(sX.devops?.requestId).toBe(aged);
    for (const s of [sA, sX]) {
      if (s === sX) await accept(sX);
      await report(s.shiftId, done('finished'));
      r.ended(s.shiftId, 'reported');
    }
    await q(`UPDATE devops_requests SET status='failed' WHERE id=$1`, [envReq]);
    await q(`UPDATE cards SET status='queued', parked_request_id=NULL WHERE id=$1`, [p.id]);
    expect(a.request.id).toBeTruthy();
  });
});
