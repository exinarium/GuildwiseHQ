import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expireRuns } from '../src/commands/runs.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q as rawQ } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

// Run a branch, phase 2 (backlog #58): plan replay with DevOps fallback, stale plans, Restart / Update & restart and the
// run worktree sweep query. The runner here announces `runs:2` (the older runs.test.ts runner only has `runs:1`).

const q = async (sql: string, params?: unknown[]): Promise<any[]> => (await rawQ(sql, params)) as any[];

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ capabilities: ['runs:1', 'runs:2'] });
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const call = (method: string, url: string, body?: unknown, status = 200, cookie = w.owner.cookie) =>
  ok<any>(w.t.req(method, url, { cookie, ...(body !== undefined ? { body } : {}) }), status);
const start = (body: Record<string, unknown> = {}, status = 201) =>
  call('POST', '/api/runs', { projectId: w.projectId, workstationId: w.workstationId, ...body }, status);
const envRow = async (id: string) => (await q('SELECT * FROM run_environments WHERE id=$1', [id]))[0];
const commandsOf = (type: string, envId?: string) =>
  q(
    `SELECT * FROM runner_commands WHERE type=$1 ${envId ? `AND payload->>'envId'='${envId}'` : ''} ORDER BY created_at`,
    [type],
  );
const status = async (envId: string, state: string, extra: Record<string, unknown> = {}) => {
  r.send('run.status', { envId, state, services: [], ...extra });
  await r.barrier();
};
const plans = () => q('SELECT * FROM run_plans WHERE project_id=$1 ORDER BY version', [w.projectId]);
const activePlan = async () => (await plans()).find((p: any) => p.status !== 'superseded');

const PLAN = (notes = 'plan') => ({
  version: 1,
  repos: [{ repoId: w.repoId }],
  setup: [
    { name: 'npm ci', repoId: w.repoId, cwd: '.', cmd: ['npm', 'ci'], timeoutSec: 1200, when: 'always' },
  ],
  services: [
    {
      name: 'web',
      repoId: w.repoId,
      cwd: '.',
      cmd: ['npm', 'run', 'dev'],
      env: {},
      ports: [{ name: 'http', default: 5173, envVar: 'PORT' }],
      health: { kind: 'none', graceSec: 3 },
      startTimeoutSec: 300,
      after: [],
      docker: false,
    },
  ],
  notes,
});

/** The DevOps flow once: a first start (no plan), the engineer saves the plan, the environment is stopped. */
async function seedPlan(buildHash = 'build-1'): Promise<void> {
  const { environment: env } = await start();
  r.send('run.plan.saved', { envId: env.id, plan: PLAN(), buildHash });
  await r.barrier();
  await status(env.id, 'stopped', { endReason: 'stopped' });
}

beforeEach(async () => {
  await q(
    `UPDATE run_environments SET state='stopped', stopped_at=now(), stop_reason='failed' WHERE state NOT IN ('stopped','failed')`,
  );
  await q(`UPDATE run_plans SET status='superseded' WHERE project_id=$1`, [w.projectId]);
  await q(`UPDATE devops_requests SET status='done' WHERE status IN ('queued','running')`);
  await q(`UPDATE shifts SET status='ended' WHERE kind='devops' AND status <> 'ended'`);
  await q(`UPDATE workstation_capabilities SET capabilities='{runs:1,runs:2}' WHERE workstation_id=$1`, [
    w.workstationId,
  ]);
  await call('PUT', `/api/projects/${w.projectId}/run-settings`, {
    runInstructions: '',
    repoInstructions: [],
    settings: { ttlHours: 8, allowDocker: false, services: [] },
  });
});

describe('plan replay on start', () => {
  it('the first start goes through DevOps; the next one replays the saved plan with no DevOps request', async () => {
    const first = (await start()).environment;
    expect(first.replayed).toBe(false);
    expect(first.devopsRequestId).not.toBeNull();
    const startCmd = (await commandsOf('run.start', first.id))[0];
    expect(startCmd.payload.replay).toBeUndefined();

    r.send('run.plan.saved', { envId: first.id, plan: PLAN(), buildHash: 'build-1' });
    await r.barrier();
    const plan = await activePlan();
    expect(plan).toMatchObject({ status: 'active', build_hash: 'build-1' });
    expect(plan.settings_hash).toMatch(/^[0-9a-f]{64}$/);
    await status(first.id, 'stopped', { endReason: 'stopped' });

    const requests = (await q('SELECT count(*)::int AS n FROM devops_requests'))[0].n;
    const second = (await start()).environment;
    expect(second).toMatchObject({ replayed: true, devopsRequestId: null, planVersion: plan.version });
    expect((await q('SELECT count(*)::int AS n FROM devops_requests'))[0].n).toBe(requests); // no model run
    const cmd = (await commandsOf('run.start', second.id))[0];
    expect(cmd.payload).toMatchObject({ requestId: null });
    expect(cmd.payload.replay).toMatchObject({
      planId: plan.id,
      version: plan.version,
      buildHash: 'build-1',
      plan: { services: [{ name: 'web' }], setup: [{ name: 'npm ci', when: 'always' }] },
    });
    const ev = (
      await q(`SELECT payload FROM events WHERE type='RunEnvironmentRequested' AND payload->>'envId'=$1`, [
        second.id,
      ])
    )[0];
    expect(ev.payload.requestId).toBeNull();
    await status(second.id, 'healthy', {
      services: [{ name: 'web', state: 'healthy', ports: [], urls: ['http://localhost:5173/'] }],
    });
    expect((await envRow(second.id)).state).toBe('healthy');
  });

  it('a change to the run instructions or the declared services marks the plan stale, and the next start goes through DevOps', async () => {
    await seedPlan();
    const before = await activePlan();
    await call('PUT', `/api/projects/${w.projectId}/run-settings`, {
      runInstructions: 'Run the API with the in-memory database.',
      repoInstructions: [],
      settings: { ttlHours: 8, allowDocker: false, services: [] },
    });
    expect((await activePlan()).status).toBe('stale');
    const ev = await q(
      `SELECT payload FROM events WHERE type='RunPlanMarkedStale' AND payload->>'planId'=$1`,
      [before.id],
    );
    expect(ev).toHaveLength(1);
    expect(ev[0].payload.reason).toBe('settings');
    const settings = await call('GET', `/api/projects/${w.projectId}/run-settings`);
    expect(settings.plans[0].status).toBe('stale');

    const env = (await start()).environment;
    expect(env.replayed).toBe(false);
    expect(env.devopsRequestId).not.toBeNull();
    expect((await commandsOf('run.start', env.id))[0].payload.replay).toBeUndefined();
    // the engineer repairs it: the new version is active (and current) again
    r.send('run.plan.saved', { envId: env.id, plan: PLAN('repaired'), buildHash: 'build-1' });
    await r.barrier();
    expect((await activePlan()).status).toBe('active');
    await status(env.id, 'stopped', { endReason: 'stopped' });
    expect((await start()).environment.replayed).toBe(true);
  });

  it('a start that finds the settings changed (no tick in between) marks the plan stale itself', async () => {
    await seedPlan();
    await q(`UPDATE projects SET run_instructions='sneaky edit' WHERE id=$1`, [w.projectId]);
    const env = (await start()).environment;
    expect(env.replayed).toBe(false);
    expect((await activePlan()).status).toBe('stale');
  });

  it('plans saved before replay existed, a runner without runs:2, a plan that does not cover the start: DevOps', async () => {
    await seedPlan();
    await q(`UPDATE run_plans SET settings_hash=NULL, build_hash=NULL WHERE project_id=$1`, [w.projectId]);
    expect((await start()).environment.replayed).toBe(false);
    expect((await activePlan()).status).toBe('active'); // not stale: just not replayable

    await beforeEachReset();
    await seedPlan();
    await q(`UPDATE workstation_capabilities SET capabilities='{runs:1}' WHERE workstation_id=$1`, [
      w.workstationId,
    ]);
    expect((await start()).environment.replayed).toBe(false);

    await beforeEachReset();
    await seedPlan();
    // a service the plan does not have
    expect((await start({ services: ['ghost'] })).environment.replayed).toBe(false);
  });
});

/** Same clean slate as the hook, for tests that seed more than once. */
async function beforeEachReset(): Promise<void> {
  await q(
    `UPDATE run_environments SET state='stopped', stopped_at=now(), stop_reason='failed' WHERE state NOT IN ('stopped','failed')`,
  );
  await q(`UPDATE run_plans SET status='superseded' WHERE project_id=$1`, [w.projectId]);
  await q(`UPDATE devops_requests SET status='done' WHERE status IN ('queued','running')`);
  await q(`UPDATE shifts SET status='ended' WHERE kind='devops' AND status <> 'ended'`);
  await q(`UPDATE workstation_capabilities SET capabilities='{runs:1,runs:2}' WHERE workstation_id=$1`, [
    w.workstationId,
  ]);
}

describe('replay failure falls back to DevOps', () => {
  it('files a run request with the failure and its log tail, once, and the shift brief carries it', async () => {
    await seedPlan();
    // the first start's own DevOps request is over (the engineer saved the plan)
    await q(`UPDATE devops_requests SET status='done' WHERE status IN ('queued','running')`);
    await q(`UPDATE shifts SET status='ended' WHERE kind='devops' AND status <> 'ended'`);
    const env = (await start()).environment;
    expect(env.replayed).toBe(true);
    await status(env.id, 'starting', { activity: 'replaying the saved plan (version 1)' });
    r.send('run.replay.failed', {
      envId: env.id,
      reason: 'service "web" failed: exited with code 1',
      logTail: 'Error: Cannot find module express',
      stale: false,
    });
    await r.barrier();
    const row = await envRow(env.id);
    expect(row.devops_request_id).not.toBeNull();
    expect(row.state).toBe('starting');
    expect(row.last_error).toMatch(/service "web" failed/);
    const req = (await q('SELECT * FROM devops_requests WHERE id=$1', [row.devops_request_id]))[0];
    expect(req.status).toBe('queued');
    expect(req.summary).toMatch(/saved run plan failed/);
    expect(req.context).toMatchObject({ requestKind: 'run', envId: env.id });
    expect(req.context.replayFailure).toContain('Cannot find module express');
    expect((await activePlan()).status).toBe('active'); // a failure alone does not make a plan stale

    // a repeated report does not file a second request while the first is open
    r.send('run.replay.failed', { envId: env.id, reason: 'again', logTail: '', stale: false });
    await r.barrier();
    expect((await envRow(env.id)).devops_request_id).toBe(row.devops_request_id);

    const from = r.received.length;
    await w.t.app.ctx.services.dispatcher.run();
    const shift = await r.waitFor(
      'shift.start',
      (f) => f.kind === 'devops' && f.devops?.run?.envId === env.id,
      5000,
      from,
    );
    expect(shift.devops?.run?.replayFailure).toContain('Cannot find module express');
    expect(shift.devops?.run?.currentPlan).toMatchObject({ services: [{ name: 'web' }] });
    await call('POST', `/api/runs/${env.id}/stop`, undefined, 202);
  });

  it('a stale report (BUILD.md changed) marks the plan stale with an event', async () => {
    await seedPlan();
    const env = (await start()).environment;
    const plan = await activePlan();
    r.send('run.replay.failed', {
      envId: env.id,
      reason: 'BUILD.md has changed since the plan was saved.',
      logTail: '',
      stale: true,
    });
    await r.barrier();
    expect((await activePlan()).status).toBe('stale');
    const ev = await q(
      `SELECT payload FROM events WHERE type='RunPlanMarkedStale' AND payload->>'planId'=$1`,
      [plan.id],
    );
    expect(ev[0].payload.reason).toBe('build_doc');
    expect((await envRow(env.id)).devops_request_id).not.toBeNull();
    await call('POST', `/api/runs/${env.id}/stop`, undefined, 202);
  });

  it('ignores a failure report of an environment that is stopping or of another workstation', async () => {
    await seedPlan();
    const env = (await start()).environment;
    await call('POST', `/api/runs/${env.id}/stop`, undefined, 202);
    r.send('run.replay.failed', { envId: env.id, reason: 'x', logTail: '', stale: false });
    r.send('run.replay.failed', { envId: randomUUID(), reason: 'x', logTail: '', stale: false });
    await r.barrier();
    expect((await envRow(env.id)).devops_request_id).toBeNull();
  });

  it('a replay nobody reports on is given up after half an hour', async () => {
    await seedPlan();
    const env = (await start()).environment;
    await status(env.id, 'starting');
    expect((await expireRuns(w.t.app.ctx)).stopped).not.toContain(env.id);
    await q('UPDATE run_environments SET updated_at=$2 WHERE id=$1', [
      env.id,
      new Date(w.t.clock.now().getTime() - 31 * 60_000),
    ]);
    expect((await expireRuns(w.t.app.ctx)).stopped).toContain(env.id);
    expect((await envRow(env.id)).last_error).toMatch(/saved plan did not finish starting/);
  });
});

describe('Restart and Update & restart', () => {
  async function healthy(): Promise<string> {
    await seedPlan();
    const env = (await start()).environment;
    await status(env.id, 'healthy', {
      services: [{ name: 'web', state: 'healthy', ports: [], urls: [] }],
    });
    return env.id;
  }

  it('a healthy environment restarts: the runner is told, no DevOps request, the expiry moves', async () => {
    const id = await healthy();
    const dto = (await call('GET', `/api/runs/${id}`)).environment;
    expect(dto.canRestart).toBe(true);
    const before = (await envRow(id)).expires_at;
    const res = await call('POST', `/api/runs/${id}/restart`, {}, 202);
    expect(res.environment).toMatchObject({ state: 'starting', replayed: true, devopsRequestId: null });
    const cmd = (await commandsOf('run.restart', id)).at(-1);
    expect(cmd.payload).toMatchObject({ envId: id, update: false, revive: false });
    expect(new Date((await envRow(id)).expires_at).getTime()).toBeGreaterThanOrEqual(
      new Date(before).getTime(),
    );
    const ev = await q(
      `SELECT payload FROM events WHERE type='RunEnvironmentRestarted' AND payload->>'envId'=$1`,
      [id],
    );
    expect(ev[0].payload).toMatchObject({ by: w.owner.id, update: false, revived: false });
    // the runner reports back: starting, then healthy again
    await status(id, 'healthy', { services: [{ name: 'web', state: 'healthy', ports: [], urls: [] }] });
    expect((await envRow(id)).state).toBe('healthy');
  });

  it('Update & restart asks for the fast-forward', async () => {
    const id = await healthy();
    await call('POST', `/api/runs/${id}/restart`, { update: true }, 202);
    expect((await commandsOf('run.restart', id)).at(-1).payload).toMatchObject({ update: true });
  });

  it('a refusal by the runner (rewritten branch) is shown on the environment and nothing else changes', async () => {
    const id = await healthy();
    await call('POST', `/api/runs/${id}/restart`, { update: true }, 202);
    const frame = await r.waitFor('command', (f) => f.command === 'run.restart' && f.payload.envId === id);
    r.send('command.result', {
      commandId: frame.commandId,
      ok: true,
      result: { ok: false, error: 'branch "main" of toy was rewritten (it is not a fast-forward)' },
    });
    await until(
      async () => /rewritten/.test((await envRow(id)).last_error ?? ''),
      5000,
      'the refusal to show',
    );
    // the runner is still running it: its next report brings the state back, and healthy clears the message
    await status(id, 'healthy', { services: [{ name: 'web', state: 'healthy', ports: [], urls: [] }] });
    expect((await envRow(id)).state).toBe('healthy');
    expect((await envRow(id)).last_error).toBeNull();
  });

  it('only a ready environment restarts; a starting one and a stranger are refused', async () => {
    await seedPlan();
    const env = (await start()).environment;
    await call('POST', `/api/runs/${env.id}/restart`, {}, 409);
    const stranger = await w.t.userSession(uniqueEmail('stranger'));
    await call('POST', `/api/runs/${env.id}/restart`, {}, 404, stranger.cookie);
    await call('POST', `/api/runs/${env.id}/stop`, undefined, 202);
  });

  it('a runner without runs:2 cannot restart', async () => {
    const id = await healthy();
    await q(`UPDATE workstation_capabilities SET capabilities='{runs:1}' WHERE workstation_id=$1`, [
      w.workstationId,
    ]);
    expect((await call('GET', `/api/runs/${id}`)).environment.canRestart).toBe(false);
    expect(JSON.stringify(await call('POST', `/api/runs/${id}/restart`, {}, 409))).toMatch(/too old/);
  });

  it('a stopped manual environment is revived within a day, not after, not while the branch runs again; a refusal puts it back', async () => {
    const id = await healthy();
    await status(id, 'stopped', { endReason: 'stopped' });
    expect((await envRow(id)).state).toBe('stopped');
    expect((await call('GET', `/api/runs/${id}`)).environment.canRestart).toBe(true);
    const res = await call('POST', `/api/runs/${id}/restart`, {}, 202);
    expect(res.environment.state).toBe('starting');
    const cmd = (await commandsOf('run.restart', id)).at(-1);
    expect(cmd.payload.revive).toBe(true);
    // the runner no longer has the worktrees: the environment goes back to stopped, with the reason
    const frame = await r.waitFor('command', (f) => f.command === 'run.restart' && f.payload.envId === id);
    r.send('command.result', {
      commandId: frame.commandId,
      ok: true,
      result: { ok: false, error: 'the run worktrees were removed: start the branch again' },
    });
    await until(
      async () => (await envRow(id)).state === 'stopped',
      5000,
      'the environment to be stopped again',
    );
    expect((await envRow(id)).last_error).toMatch(/worktrees were removed/);

    // a day later it is over
    await q('UPDATE run_environments SET stopped_at=$2 WHERE id=$1', [
      id,
      new Date(w.t.clock.now().getTime() - 25 * 3600_000),
    ]);
    expect((await call('GET', `/api/runs/${id}`)).environment.canRestart).toBe(false);
    await call('POST', `/api/runs/${id}/restart`, {}, 409);

    // the same branch running again blocks the revival
    await q('UPDATE run_environments SET stopped_at=now() WHERE id=$1', [id]);
    const again = (await start()).environment;
    expect(again.id).not.toBe(id);
    const conflict = await call('POST', `/api/runs/${id}/restart`, {}, 409);
    expect(JSON.stringify(conflict)).toMatch(/already running/);
    await call('POST', `/api/runs/${again.id}/stop`, undefined, 202);
  });

  it('a failed or test environment is not revived', async () => {
    const id = await healthy();
    await q(
      `UPDATE run_environments SET state='stopped', stop_reason='failed', stopped_at=now() WHERE id=$1`,
      [id],
    );
    await call('POST', `/api/runs/${id}/restart`, {}, 409);
    await q(`UPDATE run_environments SET stop_reason='stopped', purpose='test' WHERE id=$1`, [id]);
    await call('POST', `/api/runs/${id}/restart`, {}, 409);
    await q(`UPDATE run_environments SET purpose='manual' WHERE id=$1`, [id]);
  });
});

describe('the run worktree sweep question (worktrees.query)', () => {
  it('run folders are live while the environment runs and for a day after a stop; unknown, failed, old and test ones are not', async () => {
    const mk = async (over: {
      state: string;
      purpose?: string;
      reason?: string | null;
      ageH?: number;
      plan?: boolean;
    }) => {
      const id = randomUUID();
      const stoppedAt = new Date(w.t.clock.now().getTime() - (over.ageH ?? 0) * 3600_000);
      await q(
        `INSERT INTO run_environments (id, org_id, project_id, workstation_id, purpose, sources, services, state,
            branch_key, created_at, updated_at, stopped_at, stop_reason, plan_version)
         SELECT $1, p.org_id, p.id, $2, $3, '[]', '{}', $4, $5, now(), now(), $6, $7, $8 FROM projects p WHERE p.id=$9`,
        [
          id,
          w.workstationId,
          over.purpose ?? 'manual',
          over.state,
          `k-${id}`,
          over.state === 'stopped' || over.state === 'failed' ? stoppedAt : null,
          over.reason === undefined ? (over.state === 'stopped' ? 'stopped' : null) : over.reason,
          over.plan === false ? null : 1,
          w.projectId,
        ],
      );
      return `/home/x/.aom-runner/worktrees/TOY-${w.projectId.slice(0, 8)}/run-${id.slice(0, 8)}`;
    };
    const running = await mk({ state: 'healthy' });
    const justStopped = await mk({ state: 'stopped', ageH: 2 });
    const ttlStopped = await mk({ state: 'stopped', reason: 'ttl', ageH: 10 });
    const old = await mk({ state: 'stopped', ageH: 30 });
    const failed = await mk({ state: 'failed', reason: 'failed', ageH: 1 });
    const testEnv = await mk({ state: 'stopped', purpose: 'test', reason: 'verdict', ageH: 1 });
    const noPlan = await mk({ state: 'stopped', ageH: 1, plan: false });
    const unknown = `/home/x/.aom-runner/worktrees/TOY-${w.projectId.slice(0, 8)}/run-deadbeef`;
    const cardPath = '/home/x/.aom-runner/worktrees/TOY-aaaaaaaa/TOY-1';
    const queryId = randomUUID();
    const paths = [running, justStopped, ttlStopped, old, failed, testEnv, noPlan, unknown, cardPath];
    const from = r.received.length;
    r.send('worktrees.query', { queryId, paths });
    const answer = await r.waitFor('worktrees.live', (f) => f.queryId === queryId, 5000, from);
    expect([...answer.live].sort()).toEqual([running, justStopped, ttlStopped].sort());
  });
});
