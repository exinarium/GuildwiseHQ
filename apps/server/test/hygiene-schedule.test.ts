import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

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

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const ctx = () => w.t.app.ctx;
const setNow = (at: Date) => ctx().clock.setOffset(at.getTime() - Date.now());
const hygieneRequests = () =>
  q(`SELECT * FROM devops_requests WHERE hygiene IS NOT NULL ORDER BY created_at, id`);
const wsRow = async () => (await q('SELECT * FROM workstations WHERE id=$1', [w.workstationId]))[0]!;
const reporter = () => ctx().services.signals;

describe('scheduled hygiene', () => {
  it('is daily by default and one request is created when the day is up, not before', async () => {
    const ws = await wsRow();
    expect(ws.hygiene_interval_hours).toBe(24);
    const base = new Date(ws.paired_at).getTime();
    setNow(new Date(base + 23 * 3600_000));
    expect(await ctx().services.scheduler.runHygiene()).toEqual([]);
    setNow(new Date(base + 25 * 3600_000));
    const created = await ctx().services.scheduler.runHygiene();
    expect(created).toHaveLength(1);
    const [req] = await hygieneRequests();
    expect(req).toMatchObject({ id: created[0], requested_by_kind: 'system', status: 'queued' });
    expect(req?.hygiene.trigger).toBe('schedule');
    expect(req?.hygiene.repos[0].repoId).toBe(w.repoId);
    expect(req?.summary).toContain('NOT CONFIRMED');
    // the runner is told to sweep stale worktrees as well
    expect((await r.waitFor('command', (f) => f.command === 'worktrees.sweep')).payload.requestId).toBe(
      created[0],
    );
    // it does not pile up while one is open
    setNow(new Date(base + 60 * 3600_000));
    expect(await ctx().services.scheduler.runHygiene()).toEqual([]);
    expect(await hygieneRequests()).toHaveLength(1);
    // the next one is due a day after the last request
    await q(`UPDATE devops_requests SET status='done' WHERE id=$1`, [created[0]]);
    const last = new Date((await wsRow()).hygiene_last_at).getTime();
    setNow(new Date(last + 23 * 3600_000));
    expect(await ctx().services.scheduler.runHygiene()).toEqual([]);
    setNow(new Date(last + 25 * 3600_000));
    expect(await ctx().services.scheduler.runHygiene()).toHaveLength(1);
    ctx().clock.setOffset(0);
  });

  it('the cadence is set per workstation: off creates nothing, an hour is accepted, 7 hours is not', async () => {
    const put = (intervalHours: number) =>
      owner('PUT', `/api/workstations/${w.workstationId}/hygiene`, { intervalHours });
    expect((await put(7)).status).toBe(400);
    const off = await put(0);
    expect(off.status).toBe(200);
    expect(off.body.hygiene).toMatchObject({ intervalHours: 0, nextRunAt: null });
    await q(`UPDATE devops_requests SET status='done' WHERE hygiene IS NOT NULL`);
    await q(`UPDATE workstations SET hygiene_last_at = now() - interval '400 hours' WHERE id=$1`, [
      w.workstationId,
    ]);
    expect(await ctx().services.scheduler.runHygiene()).toEqual([]);
    const hourly = await put(1);
    expect(hourly.body.hygiene.intervalHours).toBe(1);
    expect(hourly.body.hygiene.nextRunAt).toBeTruthy();
    expect(await ctx().services.scheduler.runHygiene()).toHaveLength(1);
    const ev = await q(`SELECT payload FROM events WHERE type='WorkstationHygieneChanged' ORDER BY seq`);
    expect(ev.map((e) => e.payload.intervalHours)).toEqual([0, 1]);
  });

  it('only the owner of the workstation can change it or run it; a workstation with no clone has nothing to tidy', async () => {
    const stranger = await w.t.userSession(`stranger-${Date.now()}@example.test`);
    const put = await w.t.req('PUT', `/api/workstations/${w.workstationId}/hygiene`, {
      cookie: stranger.cookie,
      body: { intervalHours: 6 },
    });
    expect(put.status).toBe(404);
    const run = await w.t.req('POST', `/api/workstations/${w.workstationId}/hygiene/run`, {
      cookie: stranger.cookie,
    });
    expect(run.status).toBe(404);
    await q(`DELETE FROM workstation_repos WHERE workstation_id=$1`, [w.workstationId]);
    await q(`UPDATE devops_requests SET status='done' WHERE hygiene IS NOT NULL`);
    const none = await owner('POST', `/api/workstations/${w.workstationId}/hygiene/run`);
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe('no_repositories');
  });

  it('the workstation DTO carries the schedule and the last run', async () => {
    const list = await ok<any>(owner('GET', '/api/workstations'));
    const me = list.workstations.find((x: any) => x.id === w.workstationId);
    expect(me.hygiene).toMatchObject({ intervalHours: 1, openFindings: 0 });
    expect(me.hygiene.lastRequestId).toBeTruthy();
  });
});

describe('what hygiene cannot resolve becomes a reporter signal', () => {
  async function report(hygiene: unknown) {
    await q(`UPDATE devops_requests SET status='done' WHERE hygiene IS NOT NULL AND status <> 'running'`);
    await q(
      `INSERT INTO workstation_repos (workstation_id, project_repo_id, local_path, reported_at)
       VALUES ($1,$2,'/tmp/toy',now()) ON CONFLICT DO NOTHING`,
      [w.workstationId, w.repoId],
    );
    const from = r.received.length;
    await ok(owner('POST', `/api/workstations/${w.workstationId}/hygiene/run`), 201);
    await ctx().services.dispatcher.run();
    const start = await r.waitFor('shift.start', (f) => f.kind === 'devops', 5000, from);
    r.accepted(start.shiftId);
    r.started(start.shiftId);
    await until(
      async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'running']))[0],
      3000,
      'shift running',
    );
    const { reportId } = r.report(start.shiftId, {
      kind: 'outcome',
      outcomeId: 'devops_done',
      note: 'done',
      data: { summary: 'done', commands: [], hygiene },
    });
    await r.waitFor('shift.report.result', (f) => f.reportId === reportId);
    r.ended(start.shiftId);
    await until(
      async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'ended']))[0],
      5000,
      'shift ended',
    );
  }
  const repoResult = (over: Record<string, unknown> = {}) => ({
    repoId: w.repoId,
    actions: [],
    problem: null,
    branches: [],
    uncommitted: [],
    pushed: false,
    removedBranches: [],
    cleaned: [],
    ...over,
  });

  it('a conflict opens a finding and a normal-urgency signal; a later clean run resolves both', async () => {
    await report({
      repos: [
        repoResult({ problem: { kind: 'conflict', detail: 'main and origin/main could not be combined' } }),
      ],
    });
    const findings = await q(`SELECT * FROM hygiene_findings WHERE status='open'`);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'conflict', subject: w.repoId, subject_name: 'toy' });
    await reporter().run();
    const open = await q(`SELECT * FROM ba_signals WHERE kind='repo_hygiene' AND status <> 'resolved'`);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ urgency: 'normal' });
    expect(open[0]?.subject.title).toContain('Conflict while updating: toy');
    // the same problem again does not add a second finding
    await report({ repos: [repoResult({ problem: { kind: 'conflict', detail: 'still' } })] });
    expect(await q(`SELECT 1 FROM hygiene_findings WHERE status='open'`)).toHaveLength(1);
    // another kind replaces it
    await report({ repos: [repoResult({ problem: { kind: 'auth_failed', detail: 'bad token' } })] });
    const now = await q(`SELECT kind FROM hygiene_findings WHERE status='open'`);
    expect(now.map((f) => f.kind)).toEqual(['auth_failed']);
    // in order: everything resolves
    await report({ repos: [repoResult()] });
    expect(await q(`SELECT 1 FROM hygiene_findings WHERE status='open'`)).toHaveLength(0);
    await reporter().run();
    expect(
      await q(`SELECT 1 FROM ba_signals WHERE kind='repo_hygiene' AND status <> 'resolved'`),
    ).toHaveLength(0);
  });

  it('a dead card worktree with uncommitted changes (the runner sweep) is a finding until it is gone', async () => {
    const dirty = [
      { path: '/home/u/.aom-runner/worktrees/TOY-1a2b3c4d/TOY-9', branch: 'aom/toy-9', files: ['a.ts'] },
    ];
    r.send('command.result', { commandId: 'x', ok: true });
    // answer a real sweep command: queue one by running hygiene
    await q(`UPDATE devops_requests SET status='done' WHERE hygiene IS NOT NULL`);
    const from = r.received.length;
    await ok(owner('POST', `/api/workstations/${w.workstationId}/hygiene/run`), 201);
    const cmd = await r.waitFor('command', (f) => f.command === 'worktrees.sweep', 5000, from);
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: { scanned: 3, kept: 1, removed: ['/x/a', '/x/b'], dirty, emptyDirsRemoved: [], pruned: 1 },
    });
    await until(
      async () =>
        (await q(`SELECT 1 FROM hygiene_findings WHERE kind='dirty_worktree' AND status='open'`))[0],
      5000,
      'dirty worktree finding',
    );
    // the thread note is written right after the finding: wait for it instead of racing it
    const noteQuery = () =>
      q(
        `SELECT body FROM thread_messages WHERE body LIKE 'Worktree sweep:%' ORDER BY created_at DESC LIMIT 1`,
      );
    await until(async () => (await noteQuery())[0], 5000, 'worktree sweep note');
    const note = await noteQuery();
    expect(note[0]?.body).toContain('2 stale worktrees removed');
    expect(note[0]?.body).toContain('TOY-9');
    await reporter().run();
    const sig = await q(`SELECT subject FROM ba_signals WHERE kind='repo_hygiene' AND status <> 'resolved'`);
    expect(sig[0]?.subject.title).toContain('Leftover worktree');
    // the next sweep finds it gone
    await q(`UPDATE devops_requests SET status='done' WHERE hygiene IS NOT NULL`);
    const from2 = r.received.length;
    await ok(owner('POST', `/api/workstations/${w.workstationId}/hygiene/run`), 201);
    const cmd2 = await r.waitFor('command', (f) => f.command === 'worktrees.sweep', 5000, from2);
    r.send('command.result', {
      commandId: cmd2.commandId,
      ok: true,
      result: { scanned: 1, kept: 1, removed: [], dirty: [], emptyDirsRemoved: [], pruned: 1 },
    });
    await until(
      async () =>
        !(await q(`SELECT 1 FROM hygiene_findings WHERE kind='dirty_worktree' AND status='open'`))[0],
      5000,
      'finding resolved',
    );
  });
});
