import { randomUUID } from 'node:crypto';
import { branchName, DEFAULT_RUN_TTL_HOURS } from '@aom/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expireRuns } from '../src/commands/runs.ts';
import { PROJECTION_TABLES } from '../src/projections/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { uniqueEmail } from './helpers/app.ts';
import { Browser } from './helpers/browser.ts';
import { closeAdminPool, q as rawQ } from './helpers/db.ts';

// rows as loose records (the tests read columns by name)
const q = async (sql: string, params?: unknown[]): Promise<any[]> => (await rawQ(sql, params)) as any[];

import { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, MOCK_RUNTIME, ok, pairWorkstation, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ capabilities: ['runs:1'] });
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
const commandsOf = (type: string) =>
  q('SELECT * FROM runner_commands WHERE type=$1 ORDER BY created_at', [type]);
const envRow = async (id: string) => (await q('SELECT * FROM run_environments WHERE id=$1', [id]))[0];

/** The runner answers like the real one: `run.status` for an environment of this workstation. */
const status = async (envId: string, state: string, extra: Record<string, unknown> = {}) => {
  r.send('run.status', { envId, state, services: [], ...extra });
  await r.barrier();
};

beforeEach(async () => {
  // a clean slate: every environment of earlier tests is over
  await q(
    `UPDATE run_environments SET state='stopped', stopped_at=now() WHERE state NOT IN ('stopped','failed')`,
  );
  await q(`DELETE FROM runner_commands WHERE type IN ('run.start','run.stop','run.extend')`);
  // and no DevOps request of an earlier test waits for the dispatcher
  await q(`UPDATE devops_requests SET status='done' WHERE status IN ('queued','running')`);
});

describe('start a branch', () => {
  it('creates the environment, asks the runner to prepare it and files a DevOps run request', async () => {
    const { environment: env } = await start();
    expect(env).toMatchObject({
      projectKey: 'TOY',
      workstationName: 'Desk',
      purpose: 'manual',
      state: 'requested',
      canStop: true,
      canExtend: true,
    });
    expect(env.sources).toEqual([{ repoId: w.repoId, repoName: 'toy', branch: 'main', commit: null }]);
    expect(new Date(env.expiresAt).getTime() - w.t.clock.now().getTime()).toBeCloseTo(
      DEFAULT_RUN_TTL_HOURS * 3_600_000,
      -4,
    );

    const cmd = (await commandsOf('run.start')).at(-1)!;
    expect(cmd.payload).toMatchObject({
      envId: env.id,
      projectKey: 'TOY',
      purpose: 'manual',
      sources: [{ repoId: w.repoId, name: 'toy', branch: 'main' }],
      portRange: { from: 20000, to: 29999 },
      allowDocker: false,
    });
    const frame = await r.waitFor('command', (f) => f.command === 'run.start' && f.payload.envId === env.id);
    expect(frame.payload.requestId).toBe(env.devopsRequestId);

    const req = (await q('SELECT * FROM devops_requests WHERE id=$1', [env.devopsRequestId]))[0];
    expect(req.context).toMatchObject({ requestKind: 'run', envId: env.id, projectId: w.projectId });
    expect(req.summary).toMatch(/^Run toy@main of Toy/);
    expect(
      (
        await q(`SELECT 1 FROM events WHERE type='RunEnvironmentRequested' AND payload->>'envId'=$1`, [
          env.id,
        ])
      ).length,
    ).toBe(1);
  });

  it('briefs the DevOps shift with the run instructions, declared services and the saved plan', async () => {
    await call('PUT', `/api/projects/${w.projectId}/run-settings`, {
      runInstructions: 'Use the docker-free path.',
      repoInstructions: [{ repoId: w.repoId, runInstructions: 'cd web first' }],
      settings: {
        ttlHours: 4,
        allowDocker: false,
        services: [
          {
            name: 'web',
            repoId: w.repoId,
            cwd: 'web',
            cmd: ['npm', 'run', 'dev'],
            ports: [{ name: 'http', default: 5173, envVar: 'PORT' }],
            after: [],
          },
        ],
      },
    });
    const { environment: env } = await start();
    expect(new Date(env.expiresAt).getTime() - w.t.clock.now().getTime()).toBeCloseTo(4 * 3_600_000, -4);
    const from = r.received.length;
    await w.t.app.ctx.services.dispatcher.run();
    const shift = await r.waitFor(
      'shift.start',
      (f) => f.kind === 'devops' && f.devops?.run?.envId === env.id,
      5000,
      from,
    );
    expect(shift.devops?.requestId).toBe(env.devopsRequestId);
    expect(shift.devops?.run).toMatchObject({
      envId: env.id,
      projectKey: 'TOY',
      runInstructions: 'Use the docker-free path.',
      repoInstructions: [{ repoId: w.repoId, name: 'toy', text: 'cd web first' }],
      sources: [{ repoId: w.repoId, name: 'toy', branch: 'main' }],
      declared: [{ name: 'web', cwd: 'web', cmd: ['npm', 'run', 'dev'] }],
      currentPlan: null,
      allowDocker: false,
      portRange: { from: 20000, to: 29999 },
    });
    // reset for the next tests
    await call('PUT', `/api/projects/${w.projectId}/run-settings`, {
      runInstructions: '',
      repoInstructions: [],
      settings: { ttlHours: 8, allowDocker: false, services: [] },
    });
    await call('POST', `/api/runs/${env.id}/stop`, undefined, 202);
  });

  it('from a card: the card repository runs at the card branch', async () => {
    const card = await w.card();
    const { environment: env } = await start({ cardId: card.id });
    expect(env.cardRef).toBe(card.ref);
    const project = (await q('SELECT branch_prefix FROM projects WHERE id=$1', [w.projectId]))[0];
    const c = (await q('SELECT ref, title, branch_name FROM cards WHERE id=$1', [card.id]))[0];
    const expected = c.branch_name ?? branchName(project.branch_prefix, c.ref, c.title);
    expect(env.sources[0].branch).toBe(expected);
    const list = await call('GET', `/api/runs?cardId=${card.id}`);
    expect(list.environments.map((e: any) => e.id)).toEqual([env.id]);
    const req = (
      await q('SELECT card_id, origin FROM devops_requests WHERE id=$1', [env.devopsRequestId])
    )[0];
    expect(req).toMatchObject({ card_id: card.id, origin: 'card' });
  });

  it('takes a chosen branch per repository', async () => {
    const { environment: env } = await start({ sources: [{ repoId: w.repoId, branch: 'feature/login' }] });
    expect(env.sources[0].branch).toBe('feature/login');
    await call(
      'POST',
      '/api/runs',
      {
        projectId: w.projectId,
        workstationId: w.workstationId,
        sources: [{ repoId: w.repoId, branch: 'bad..branch' }],
      },
      400,
    );
  });

  it('refuses the same branch twice and a third environment beyond the cap', async () => {
    const a = await start({ sources: [{ repoId: w.repoId, branch: 'one' }] });
    const dup = await start({ sources: [{ repoId: w.repoId, branch: 'one' }] }, 409);
    expect(dup.error.code ?? dup.code).toBe('already_running');
    const b = await start({ sources: [{ repoId: w.repoId, branch: 'two' }] });
    const third = await start({ sources: [{ repoId: w.repoId, branch: 'three' }] }, 409);
    expect(JSON.stringify(third)).toMatch(/run_cap|limit is 2/);
    expect(JSON.stringify(third)).toContain(a.environment.id);
    await call('POST', `/api/runs/${a.environment.id}/stop`, undefined, 202);
    await call('POST', `/api/runs/${b.environment.id}/stop`, undefined, 202);
  });

  it('refuses a runner that cannot run branches, and an offline workstation', async () => {
    await q(`UPDATE workstation_capabilities SET capabilities='{}' WHERE workstation_id=$1`, [
      w.workstationId,
    ]);
    const old = await start({}, 409);
    expect(JSON.stringify(old)).toMatch(/too old/);
    await q(`UPDATE workstation_capabilities SET capabilities='{runs:1}' WHERE workstation_id=$1`, [
      w.workstationId,
    ]);
    await q(`UPDATE workstations SET connected=false WHERE id=$1`, [w.workstationId]);
    const off = await start({}, 409);
    expect(JSON.stringify(off)).toMatch(/offline/);
    await q(`UPDATE workstations SET connected=true WHERE id=$1`, [w.workstationId]);
  });

  it('is invisible and unusable to a stranger', async () => {
    const stranger = await w.t.userSession(uniqueEmail('stranger'));
    await call(
      'POST',
      '/api/runs',
      { projectId: w.projectId, workstationId: w.workstationId },
      404,
      stranger.cookie,
    );
    const { environment: env } = await start();
    await call('GET', `/api/runs/${env.id}`, undefined, 404, stranger.cookie);
    await call('POST', `/api/runs/${env.id}/stop`, undefined, 404, stranger.cookie);
    expect((await call('GET', '/api/runs', undefined, 200, stranger.cookie)).environments).toEqual([]);
    await call('POST', `/api/runs/${env.id}/stop`, undefined, 202);
  });
});

describe('what the runner reports', () => {
  it('follows the run.status messages: starting, healthy with URLs, and ends with an event and a thread note', async () => {
    const { environment: env } = await start();
    await status(env.id, 'preparing', { activity: 'creating the worktrees' });
    expect((await call('GET', `/api/runs/${env.id}`)).environment).toMatchObject({
      state: 'preparing',
      activity: 'creating the worktrees',
    });
    await status(env.id, 'starting', { sources: [{ repoId: w.repoId, commit: 'abc123def456' }] });
    const services = [
      {
        name: 'web',
        state: 'healthy',
        ports: [{ name: 'http', port: 5173, wanted: 5173, url: 'http://localhost:5173/' }],
        urls: ['http://localhost:5173/'],
        health: 'passing',
        restarts: 0,
      },
    ];
    await status(env.id, 'healthy', { services });
    const got = (await call('GET', `/api/runs/${env.id}`)).environment;
    expect(got.state).toBe('healthy');
    expect(got.healthyAt).toBeTruthy();
    expect(got.sources[0].commit).toBe('abc123def456');
    expect(got.servicesStatus[0]).toMatchObject({ name: 'web', urls: ['http://localhost:5173/'] });
    const notes = await q(`SELECT body FROM thread_messages WHERE thread_id=$1 AND kind='system'`, [
      env.devopsRequestId,
    ]);
    expect(notes.some((n: any) => /running: http:\/\/localhost:5173\//.test(n.body))).toBe(true);

    await status(env.id, 'stopped', { endReason: 'stopped' });
    const end = (
      await q(`SELECT payload FROM events WHERE type='RunEnvironmentEnded' AND payload->>'envId'=$1`, [
        env.id,
      ])
    )[0];
    expect(end.payload).toMatchObject({ reason: 'stopped' });
    expect(await envRow(env.id)).toMatchObject({ state: 'stopped', stop_reason: 'stopped' });
    // a late report cannot revive it
    await status(env.id, 'healthy', { services });
    expect((await envRow(env.id)).state).toBe('stopped');
  });

  it('ignores reports for unknown environments and for environments of another workstation', async () => {
    await status(randomUUID(), 'healthy');
    const { environment: env } = await start();
    const other = await pairWorkstation(w.t, w.owner, 'Other');
    const o = await FakeRunner.connect(w.baseUrl, other.runnerToken);
    o.hello({ runtimes: MOCK_RUNTIME, capabilities: ['runs:1'] });
    await o.waitFor('welcome');
    o.send('run.status', { envId: env.id, state: 'healthy', services: [] });
    await o.barrier();
    expect((await envRow(env.id)).state).toBe('requested');
    o.close();
    await call('POST', `/api/runs/${env.id}/stop`, undefined, 202);
  });

  it('a refused run.start (cap, branch missing) fails the environment with the reason', async () => {
    const { environment: env } = await start();
    const frame = await r.waitFor('command', (f) => f.command === 'run.start' && f.payload.envId === env.id);
    r.send('command.result', {
      commandId: frame.commandId,
      ok: true,
      result: { ok: false, error: 'branch "x" does not exist in the local clone of toy' },
    });
    await until(async () => (await envRow(env.id)).state === 'failed', 5000, 'the environment to fail');
    expect((await envRow(env.id)).last_error).toMatch(/does not exist/);
  });

  it('saves the plan on run.plan.saved: versions supersede, invalid plans are dropped, the fingerprint follows the settings', async () => {
    const { environment: env } = await start();
    const plan = (notes: string) => ({
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
    r.send('run.plan.saved', { envId: env.id, plan: plan('first'), buildHash: 'h1' });
    await r.barrier();
    let plans = await q('SELECT * FROM run_plans WHERE project_id=$1 ORDER BY version', [w.projectId]);
    expect(plans.at(-1)).toMatchObject({
      version: plans.length,
      status: 'active',
      workstation_id: w.workstationId,
    });
    const v1 = plans.at(-1)!;
    expect((await envRow(env.id)).plan_version).toBe(v1.version);

    r.send('run.plan.saved', { envId: env.id, plan: plan('second'), buildHash: 'h2' });
    await r.barrier();
    plans = await q('SELECT * FROM run_plans WHERE project_id=$1 ORDER BY version', [w.projectId]);
    const active = plans.filter((p: any) => p.status === 'active');
    expect(active).toHaveLength(1);
    expect(active[0].version).toBe(v1.version + 1);
    expect(active[0].plan.notes).toBe('second');
    expect(active[0].fingerprint).not.toBe(v1.fingerprint); // BUILD.md changed
    expect(plans.find((p: any) => p.id === v1.id).status).toBe('superseded');

    const bad: any = plan('bad');
    bad.services[0].after = ['ghost'];
    r.send('run.plan.saved', { envId: env.id, plan: bad });
    await r.barrier();
    expect((await q('SELECT 1 FROM run_plans WHERE project_id=$1', [w.projectId])).length).toBe(plans.length);

    const settings = await call('GET', `/api/projects/${w.projectId}/run-settings`);
    expect(settings.plans).toHaveLength(1);
    expect(settings.plans[0]).toMatchObject({
      workstationName: 'Desk',
      status: 'active',
      plan: { notes: 'second' },
    });
    await call('POST', `/api/runs/${env.id}/stop`, undefined, 202);
  });
});

describe('stop, extend and expiry', () => {
  it('stop asks the runner, shows stopping, and a late healthy report does not undo it', async () => {
    const { environment: env } = await start();
    const stopped = await call('POST', `/api/runs/${env.id}/stop`, undefined, 202);
    expect(stopped.environment.state).toBe('stopping');
    expect(stopped.environment.canStop).toBe(false);
    const frame = await r.waitFor('command', (f) => f.command === 'run.stop' && f.payload.envId === env.id);
    expect(frame.payload.reason).toBe('stopped');
    await status(env.id, 'healthy');
    expect((await envRow(env.id)).state).toBe('stopping');
    // the request that never started is closed
    expect((await q('SELECT status FROM devops_requests WHERE id=$1', [env.devopsRequestId]))[0].status).toBe(
      'failed',
    );
    await status(env.id, 'stopped', { endReason: 'stopped' });
    expect((await envRow(env.id)).state).toBe('stopped');
    // stopping a finished environment is a no-op
    await call('POST', `/api/runs/${env.id}/stop`, undefined, 202);
  });

  it('extend moves the expiry by the project TTL and tells the runner', async () => {
    const { environment: env } = await start();
    const before = new Date(env.expiresAt).getTime();
    const ext = await call('POST', `/api/runs/${env.id}/extend`, {});
    expect(new Date(ext.environment.expiresAt).getTime() - before).toBeCloseTo(
      DEFAULT_RUN_TTL_HOURS * 3_600_000,
      -4,
    );
    const frame = await r.waitFor('command', (f) => f.command === 'run.extend' && f.payload.envId === env.id);
    expect(frame.payload.ttlAt).toBe(ext.environment.expiresAt);
    const two = await call('POST', `/api/runs/${env.id}/extend`, { hours: 2 });
    expect(
      new Date(two.environment.expiresAt).getTime() - new Date(ext.environment.expiresAt).getTime(),
    ).toBeCloseTo(2 * 3_600_000, -4);
    await call('POST', `/api/runs/${env.id}/stop`, undefined, 202);
    await call('POST', `/api/runs/${env.id}/extend`, {}, 409);
  });

  it('the TTL tick stops an environment that ran out, once', async () => {
    const { environment: env } = await start();
    await status(env.id, 'healthy');
    expect((await expireRuns(w.t.app.ctx)).stopped).not.toContain(env.id);
    await q('UPDATE run_environments SET expires_at=$2 WHERE id=$1', [
      env.id,
      new Date(w.t.clock.now().getTime() - 1000),
    ]);
    expect((await expireRuns(w.t.app.ctx)).stopped).toContain(env.id);
    const frame = await r.waitFor('command', (f) => f.command === 'run.stop' && f.payload.envId === env.id);
    expect(frame.payload.reason).toBe('ttl');
    expect((await envRow(env.id)).state).toBe('stopping');
    expect((await expireRuns(w.t.app.ctx)).stopped).not.toContain(env.id);
    await status(env.id, 'stopped', { endReason: 'ttl' });
    const end = (
      await q(`SELECT payload FROM events WHERE type='RunEnvironmentEnded' AND payload->>'envId'=$1`, [
        env.id,
      ])
    )[0];
    expect(end.payload.reason).toBe('ttl');
  });

  it('an environment nobody answered for, and one whose DevOps request ended without making it ready, are given up', async () => {
    const a = await start({ sources: [{ repoId: w.repoId, branch: 'lost' }] });
    await q('UPDATE run_environments SET created_at=$2 WHERE id=$1', [
      a.environment.id,
      new Date(w.t.clock.now().getTime() - 11 * 60_000),
    ]);
    const b = await start({ sources: [{ repoId: w.repoId, branch: 'unfinished' }] });
    await status(b.environment.id, 'starting');
    await q(`UPDATE devops_requests SET status='done', updated_at=$2 WHERE id=$1`, [
      b.environment.devopsRequestId,
      new Date(w.t.clock.now().getTime() - 60_000),
    ]);
    const out = await expireRuns(w.t.app.ctx);
    expect(out.stopped).toEqual(expect.arrayContaining([a.environment.id, b.environment.id]));
    expect((await envRow(a.environment.id)).last_error).toMatch(/did not pick the environment up/);
    expect((await envRow(b.environment.id)).last_error).toMatch(/without making the environment ready/);
    for (const id of [a.environment.id, b.environment.id]) {
      const frame = await r.waitFor('command', (f) => f.command === 'run.stop' && f.payload.envId === id);
      expect(frame.payload.reason).toBe('failed');
    }
  });
});

describe('run settings', () => {
  const put = (body: unknown, status = 200, cookie = w.owner.cookie) =>
    call('PUT', `/api/projects/${w.projectId}/run-settings`, body, status, cookie);

  it('saves, validates and survives a projection rebuild', async () => {
    const svc = (name: string, over: Record<string, unknown> = {}) => ({
      name,
      repoId: w.repoId,
      cwd: '.',
      ports: [],
      after: [],
      ...over,
    });
    const body = {
      runInstructions: 'Start the API first.',
      repoInstructions: [{ repoId: w.repoId, runInstructions: 'Use .env.local' }],
      settings: {
        ttlHours: 6,
        allowDocker: true,
        services: [
          svc('db'),
          svc('api', {
            after: ['db'],
            cmd: ['dotnet', 'run'],
            health: { kind: 'http', url: 'http://localhost:${port}/health', expect: '2xx' },
            ports: [{ name: 'http', default: 5000, envVar: 'ASPNETCORE_HTTP_PORTS' }],
          }),
        ],
      },
    };
    const saved = await put(body);
    expect(saved).toMatchObject({
      runInstructions: 'Start the API first.',
      settings: { ttlHours: 6, allowDocker: true },
    });
    expect(saved.repos[0]).toMatchObject({
      repoId: w.repoId,
      name: 'toy',
      runInstructions: 'Use .env.local',
    });

    // cycles, unknown dependencies, unsafe paths, relative env files and foreign repositories are refused
    await put(
      {
        ...body,
        settings: { ...body.settings, services: [svc('a', { after: ['b'] }), svc('b', { after: ['a'] })] },
      },
      400,
    );
    await put({ ...body, settings: { ...body.settings, services: [svc('a', { after: ['ghost'] })] } }, 400);
    await put({ ...body, settings: { ...body.settings, services: [svc('a', { cwd: '../../etc' })] } }, 400);
    await put(
      { ...body, settings: { ...body.settings, services: [svc('a', { envFile: 'relative.env' })] } },
      400,
    );
    await put(
      { ...body, settings: { ...body.settings, services: [svc('a', { repoId: randomUUID() })] } },
      400,
    );
    await put({ ...body, settings: { ...body.settings, ttlHours: 0 } }, 400);

    expect(PROJECTION_TABLES).toContain('run_plans');
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    const again = await call('GET', `/api/projects/${w.projectId}/run-settings`);
    expect(again).toMatchObject({
      runInstructions: 'Start the API first.',
      settings: { ttlHours: 6, allowDocker: true },
    });
    expect(again.repos[0].runInstructions).toBe('Use .env.local');
    expect(again.settings.services.map((s: any) => s.name)).toEqual(['db', 'api']);
    await put({
      runInstructions: '',
      repoInstructions: [],
      settings: { ttlHours: 8, allowDocker: false, services: [] },
    });
  });

  it('only the project owner changes them, any member reads them, a stranger sees nothing', async () => {
    const stranger = await w.t.userSession(uniqueEmail('stranger'));
    await put(
      {
        runInstructions: 'x',
        repoInstructions: [],
        settings: { ttlHours: 8, allowDocker: false, services: [] },
      },
      404,
      stranger.cookie,
    );
    await call('GET', `/api/projects/${w.projectId}/run-settings`, undefined, 404, stranger.cookie);
  });

  it('the environments and the plans survive a rebuild of the projections (operational / replayed)', async () => {
    const { environment: env } = await start();
    r.send('run.plan.saved', {
      envId: env.id,
      plan: {
        version: 1,
        repos: [],
        setup: [],
        services: [
          {
            name: 'web',
            repoId: w.repoId,
            cwd: '.',
            cmd: ['x'],
            env: {},
            ports: [],
            health: { kind: 'none', graceSec: 1 },
            startTimeoutSec: 60,
            after: [],
            docker: false,
          },
        ],
        notes: 'kept',
      },
    });
    await r.barrier();
    const plansBefore = (
      await q('SELECT count(*)::int AS n FROM run_plans WHERE project_id=$1', [w.projectId])
    )[0].n;
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect((await envRow(env.id)).state).toBe('requested');
    expect(
      (await q('SELECT count(*)::int AS n FROM run_plans WHERE project_id=$1', [w.projectId]))[0].n,
    ).toBe(plansBefore);
    expect(
      (await q('SELECT 1 FROM workstation_capabilities WHERE workstation_id=$1', [w.workstationId])).length,
    ).toBe(1);
    await call('POST', `/api/runs/${env.id}/stop`, undefined, 202);
  });
});

describe('workstations and the browser', () => {
  it('the workstation reports whether it can run branches and how many', async () => {
    const list = await call('GET', '/api/workstations');
    expect(list.workstations.find((x: any) => x.id === w.workstationId).runs).toEqual({
      capable: true,
      maxEnvironments: 2,
    });
  });

  it('a browser that follows an environment makes the runner send logs, and gets run.changed and run.log', async () => {
    const { environment: env } = await start();
    const b = await Browser.open(w.baseUrl, w.owner.cookie);
    await b.hello();
    const from = r.received.length;
    b.send({ type: 'run.watch', envId: env.id });
    const follow = await r.waitFor('run.follow', (f) => f.envId === env.id && f.follow === true, 5000, from);
    expect(follow.follow).toBe(true);
    r.send('run.log', { envId: env.id, service: 'web', lines: ['hello', 'world'], history: true });
    await b.until(() => b.of('run.log').length > 0);
    expect(b.of('run.log')[0]).toMatchObject({
      envId: env.id,
      service: 'web',
      lines: ['hello', 'world'],
      history: true,
    });
    await status(env.id, 'starting');
    await b.until(() => b.of('run.changed').some((m) => m.envId === env.id));
    b.send({ type: 'run.unwatch', envId: env.id });
    await r.waitFor('run.follow', (f) => f.envId === env.id && f.follow === false, 5000, from);
    r.send('run.log', { envId: env.id, service: 'web', lines: ['late'] });
    await r.barrier();
    await b.barrier();
    expect(b.of('run.log')).toHaveLength(1);
    // a stranger cannot follow it
    const stranger = await w.t.userSession(uniqueEmail('stranger'));
    const s = await Browser.open(w.baseUrl, stranger.cookie);
    await s.hello();
    s.send({ type: 'run.watch', envId: env.id });
    await s.barrier();
    r.send('run.log', { envId: env.id, service: 'web', lines: ['secret?'] });
    await r.barrier();
    await s.barrier();
    expect(s.of('run.log')).toHaveLength(0);
    b.close();
    s.close();
    await call('POST', `/api/runs/${env.id}/stop`, undefined, 202);
  });
});
