import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runnerPaths } from '../src/paths.ts';
import { RunManager, type RunManagerDeps } from '../src/runs/manager.ts';
import { pidAlive } from '../src/runs/proc.ts';
import { ServiceLauncher } from '../src/runs/sandbox.ts';
import { cleanupTmp, makeRepo, sh, tmp, waitUntil } from './helpers.ts';

cleanupTmp();

/** A web server that listens on $PORT, answers 200 on /health, logs a line, and optionally ignores SIGTERM. */
const SERVER_JS = `
const http = require('node:http');
const port = Number(process.env.PORT || process.argv[2] || 0);
if (process.env.IGNORE_TERM) process.on('SIGTERM', () => {});
http.createServer((req, res) => { res.end('ok'); }).listen(port, '127.0.0.1', () => console.log('listening on ' + port + ' secret=' + (process.env.MY_SECRET || '')));
setInterval(() => {}, 1000);
`;

interface Sent {
  type: string;
  payload: Record<string, any>;
}

const rangeBase = 41000 + Math.floor(Math.random() * 1500);

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

function setup(over: Partial<RunManagerDeps> = {}) {
  const repo = makeRepo();
  writeFileSync(join(repo.clone, 'server.js'), SERVER_JS);
  writeFileSync(join(repo.clone, 'BUILD.md'), '# build\nrun node server.js\n');
  sh(repo.clone, 'git', ['add', '-A']);
  sh(repo.clone, 'git', ['commit', '-m', 'server']);
  sh(repo.clone, 'git', ['branch', 'feature']);
  const root = tmp();
  const paths = runnerPaths(root);
  mkdirSync(paths.worktrees, { recursive: true });
  const sent: Sent[] = [];
  const mgr = new RunManager({
    paths,
    findRepo: async () => ({ localPath: repo.clone }),
    send: (type, payload) => sent.push({ type, payload }),
    log: { info() {}, warn() {}, error() {} },
    maxEnvironments: () => 2,
    // no systemd scope and no sandbox here: the process basics are tested on plain child processes
    launcher: new ServiceLauncher({ noScope: true }),
    portRange: () => ({ from: rangeBase, to: rangeBase + 400 }),
    timing: {
      waitMs: 8000,
      healthPollMs: 40,
      superviseMs: 80,
      logFlushMs: 60,
      stopGraceMs: 400,
      recheckMs: 100,
      backoffMs: [30, 30, 30],
    },
    ...over,
  });
  const repoId = randomUUID();
  const start = (branch = 'main', extra: Record<string, unknown> = {}) => {
    const envId = randomUUID();
    const projectId = randomUUID();
    return {
      envId,
      p: {
        envId,
        projectId,
        projectKey: 'TOY',
        projectName: 'Toy',
        purpose: 'manual' as const,
        requestId: randomUUID(),
        sources: [{ repoId, name: 'toy', remoteUrlNormalized: repo.remoteNormalized, branch }],
        services: [],
        portRange: { from: rangeBase, to: rangeBase + 400 },
        ttlAt: new Date(Date.now() + 3600_000).toISOString(),
        allowDocker: false,
        ...extra,
      },
    };
  };
  const caller = (requestId: string) => ({ requestId, declared: [] as never[] });
  return { repo, root, paths, sent, mgr, repoId, start, caller };
}

const mgrs: RunManager[] = [];
afterEach(async () => {
  for (const m of mgrs.splice(0)) {
    for (const id of m.liveEnvIds()) await m.stop({ envId: id, reason: 'stopped' });
    m.shutdown();
  }
});

const lastStatus = (sent: Sent[], envId: string) =>
  [...sent].reverse().find((s) => s.type === 'run.status' && s.payload.envId === envId)?.payload;

const svcParams = (over: Record<string, unknown> = {}) => ({
  name: 'web',
  cwd: '.',
  cmd: ['node', 'server.js'],
  ports: [{ name: 'http', default: 5055, envVar: 'PORT', url: 'http://localhost:${port}/' }],
  health: { kind: 'http', url: 'http://127.0.0.1:${port}/health', expect: '2xx' },
  ...over,
});

describe('run worktrees', () => {
  it('creates a detached worktree per repository at the branch commit, without creating a branch', async () => {
    const t = setup();
    mgrs.push(t.mgr);
    const { p, envId } = t.start('feature');
    const before = sh(t.repo.clone, 'git', ['branch', '--list']);
    expect(await t.mgr.startEnv(p)).toEqual({ ok: true });
    const info = (await t.mgr.rpc(envId, 'run.info', {}, t.caller(p.requestId!))) as any;
    expect(info.ok).toBe(true);
    const wt = t.mgr.sourcesOf(envId);
    expect(wt[0]?.commit).toBe(sh(t.repo.clone, 'git', ['rev-parse', 'feature']));
    const path = /: (\S+run-\S+toy)\s/.exec(info.result.message)?.[1] as string;
    expect(existsSync(join(path, 'server.js'))).toBe(true);
    expect(sh(path, 'git', ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD'); // detached
    expect(sh(t.repo.clone, 'git', ['branch', '--list'])).toBe(before); // no branch was created
    expect(lastStatus(t.sent, envId)?.state).toBe('starting');
    await t.mgr.stop({ envId, reason: 'stopped' });
    expect(existsSync(path)).toBe(false);
    expect(lastStatus(t.sent, envId)).toMatchObject({ state: 'stopped', endReason: 'stopped' });
  });

  it('fails the start when the branch does not exist, and cleans up', async () => {
    const t = setup();
    mgrs.push(t.mgr);
    const { p, envId } = t.start('nope');
    const r = await t.mgr.startEnv(p);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/branch "nope" does not exist/);
    expect(lastStatus(t.sent, envId)).toMatchObject({ state: 'failed' });
  });

  it('refuses a start beyond the cap and a repeated start is a no-op', async () => {
    const t = setup({ maxEnvironments: () => 1 });
    mgrs.push(t.mgr);
    const a = t.start();
    const b = t.start();
    expect((await t.mgr.startEnv(a.p)).ok).toBe(true);
    expect(await t.mgr.startEnv(a.p)).toEqual({ ok: true });
    const r = await t.mgr.startEnv(b.p);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already runs 1 environment/);
  });
});

describe('services', () => {
  it('starts a service on its default port, goes healthy, saves the plan on ready, and stops it', async () => {
    const t = setup();
    mgrs.push(t.mgr);
    const { p, envId } = t.start();
    await t.mgr.startEnv(p);
    const port = await freePort();
    const r = (await t.mgr.rpc(
      envId,
      'run.service',
      svcParams({
        ports: [{ name: 'http', default: port, envVar: 'PORT', url: 'http://localhost:${port}/' }],
      }),
      t.caller(p.requestId!),
    )) as any;
    expect(r.ok).toBe(true);
    expect(r.result.message).toMatch(/healthy/);
    const st = lastStatus(t.sent, envId)!;
    expect(st.services[0]).toMatchObject({ name: 'web', state: 'healthy', health: 'passing' });
    expect(st.services[0].ports[0]).toMatchObject({ port, wanted: port, url: `http://localhost:${port}/` });
    const pid = st.services[0].pid as number;
    expect(pidAlive(pid)).toBe(true);
    const ready = (await t.mgr.rpc(
      envId,
      'run.ready',
      { notes: 'plain node' },
      t.caller(p.requestId!),
    )) as any;
    expect(ready.ok).toBe(true);
    const saved = t.sent.find((s) => s.type === 'run.plan.saved')!;
    expect(saved.payload.plan.services[0]).toMatchObject({ name: 'web', cmd: ['node', 'server.js'] });
    expect(saved.payload.plan.notes).toBe('plain node');
    expect(saved.payload.buildHash).toMatch(/^[0-9a-f]{64}$/);
    expect(lastStatus(t.sent, envId)?.state).toBe('healthy');
    await t.mgr.stop({ envId, reason: 'stopped' });
    await waitUntil(() => !pidAlive(pid), 5000, 'the service to stop');
  });

  it('allocates a port from the range when the default is taken and tells the app through its variable', async () => {
    const t = setup();
    mgrs.push(t.mgr);
    const { p, envId } = t.start();
    await t.mgr.startEnv(p);
    const busy = await freePort();
    const blocker = createServer().listen(busy, '127.0.0.1');
    try {
      const r = (await t.mgr.rpc(
        envId,
        'run.service',
        svcParams({ ports: [{ name: 'http', default: busy, envVar: 'PORT' }] }),
        t.caller(p.requestId!),
      )) as any;
      expect(r.ok).toBe(true);
      const port = lastStatus(t.sent, envId)!.services[0].ports[0];
      expect(port.wanted).toBe(busy);
      expect(port.port).toBeGreaterThanOrEqual(rangeBase);
      expect(port.port).toBeLessThanOrEqual(rangeBase + 400);
      expect(r.result.message).toMatch(/healthy/);
    } finally {
      blocker.close();
    }
  });

  it('refuses a taken port the app cannot be told to change', async () => {
    const t = setup();
    mgrs.push(t.mgr);
    const { p, envId } = t.start();
    await t.mgr.startEnv(p);
    const busy = await freePort();
    const blocker = createServer().listen(busy, '127.0.0.1');
    try {
      const r = (await t.mgr.rpc(
        envId,
        'run.service',
        svcParams({ ports: [{ name: 'http', default: busy }] }),
        t.caller(p.requestId!),
      )) as any;
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/already in use/);
      expect(r.error).toMatch(/ENV_VAR/);
    } finally {
      blocker.close();
    }
  });

  it('waits for the services named in "after" and refuses an unknown one', async () => {
    const t = setup();
    mgrs.push(t.mgr);
    const { p, envId } = t.start();
    await t.mgr.startEnv(p);
    const r = (await t.mgr.rpc(
      envId,
      'run.service',
      svcParams({ name: 'api', after: ['db'] }),
      t.caller(p.requestId!),
    )) as any;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/starts after "db"/);
  });

  it('supports log and tcp and none health checks', async () => {
    const t = setup();
    mgrs.push(t.mgr);
    const { p, envId } = t.start();
    await t.mgr.startEnv(p);
    const a = await freePort();
    const byLog = (await t.mgr.rpc(
      envId,
      'run.service',
      svcParams({
        name: 'logy',
        ports: [{ name: 'http', default: a, envVar: 'PORT' }],
        health: { kind: 'log', regex: 'listening on \\d+' },
      }),
      t.caller(p.requestId!),
    )) as any;
    expect(byLog.result.message).toMatch(/healthy/);
    const b = await freePort();
    const byTcp = (await t.mgr.rpc(
      envId,
      'run.service',
      svcParams({
        name: 'tcpy',
        ports: [{ name: 'http', default: b, envVar: 'PORT' }],
        health: { kind: 'tcp', port: 'http' },
      }),
      t.caller(p.requestId!),
    )) as any;
    expect(byTcp.result.message).toMatch(/healthy/);
    const c = await freePort();
    const none = (await t.mgr.rpc(
      envId,
      'run.service',
      svcParams({
        name: 'nonny',
        ports: [{ name: 'http', default: c, envVar: 'PORT' }],
        health: { kind: 'none', graceSec: 0 },
      }),
      t.caller(p.requestId!),
    )) as any;
    expect(none.result.message).toMatch(/healthy/);
  });

  it('reports a service that dies at start with its last output and exit code', async () => {
    const t = setup();
    mgrs.push(t.mgr);
    const { p, envId } = t.start();
    await t.mgr.startEnv(p);
    const r = (await t.mgr.rpc(
      envId,
      'run.service',
      svcParams({
        name: 'bad',
        cmd: ['node', '-e', 'console.log("boom"); process.exit(3)'],
        ports: [],
        health: { kind: 'http', url: 'http://127.0.0.1:9/' },
      }),
      t.caller(p.requestId!),
    )) as any;
    expect(r.ok).toBe(true);
    expect(r.result.exitCode).toBe(1);
    expect(r.result.message).toMatch(/failed/);
    expect(r.result.message).toMatch(/boom/);
    const svc = lastStatus(t.sent, envId)!.services[0];
    expect(svc).toMatchObject({ state: 'failed', exitCode: 3 });
    const ready = (await t.mgr.rpc(envId, 'run.ready', {}, t.caller(p.requestId!))) as any;
    expect(ready.ok).toBe(false);
    expect(ready.error).toMatch(/not ready/);
  });

  it('restarts a service that was healthy and died, up to three times, then fails the environment', async () => {
    const t = setup();
    mgrs.push(t.mgr);
    const { p, envId } = t.start();
    await t.mgr.startEnv(p);
    const port = await freePort();
    await t.mgr.rpc(
      envId,
      'run.service',
      svcParams({ ports: [{ name: 'http', default: port, envVar: 'PORT' }] }),
      t.caller(p.requestId!),
    );
    await t.mgr.rpc(envId, 'run.ready', {}, t.caller(p.requestId!));
    const kill = () => process.kill(lastStatus(t.sent, envId)!.services[0].pid, 'SIGKILL');
    kill();
    await waitUntil(
      () =>
        lastStatus(t.sent, envId)?.services[0]?.restarts === 1 &&
        lastStatus(t.sent, envId)?.state === 'healthy',
      10_000,
      'the first restart',
    );
    kill();
    await waitUntil(
      () =>
        lastStatus(t.sent, envId)?.services[0]?.restarts === 2 &&
        lastStatus(t.sent, envId)?.state === 'healthy',
      10_000,
      'the second restart',
    );
    kill();
    await waitUntil(
      () =>
        lastStatus(t.sent, envId)?.services[0]?.restarts === 3 &&
        lastStatus(t.sent, envId)?.state === 'healthy',
      10_000,
      'the third restart',
    );
    kill();
    await waitUntil(() => lastStatus(t.sent, envId)?.state === 'failed', 10_000, 'the environment to fail');
    expect(lastStatus(t.sent, envId)?.error).toMatch(/keeps exiting/);
  });

  it('stops with stopCmd first, then SIGTERM, then SIGKILL for a service that ignores SIGTERM', async () => {
    const t = setup();
    mgrs.push(t.mgr);
    const { p, envId } = t.start();
    await t.mgr.startEnv(p);
    const port = await freePort();
    const marker = join(t.root, 'stopped.txt');
    await t.mgr.rpc(
      envId,
      'run.service',
      svcParams({
        env: { IGNORE_TERM: '1' },
        ports: [{ name: 'http', default: port, envVar: 'PORT' }],
        stopCmd: ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'bye')`],
      }),
      t.caller(p.requestId!),
    );
    const pid = lastStatus(t.sent, envId)!.services[0].pid as number;
    const started = Date.now();
    await t.mgr.stop({ envId, reason: 'stopped' });
    expect(readFileSync(marker, 'utf8')).toBe('bye');
    expect(pidAlive(pid)).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300); // it waited out the grace period before SIGKILL
  });

  it('kills the whole process group', async () => {
    const t = setup();
    mgrs.push(t.mgr);
    const { p, envId } = t.start();
    await t.mgr.startEnv(p);
    const pidFile = join(t.root, 'child.pid');
    const script = `const c = require('child_process').spawn('sleep', ['60'], {stdio:'ignore'}); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(()=>{},1000)`;
    await t.mgr.rpc(
      envId,
      'run.service',
      svcParams({
        name: 'tree',
        cmd: ['node', '-e', script],
        ports: [],
        health: { kind: 'none', graceSec: 0 },
      }),
      t.caller(p.requestId!),
    );
    await waitUntil(() => existsSync(pidFile), 5000, 'the child process');
    const child = Number(readFileSync(pidFile, 'utf8'));
    expect(pidAlive(child)).toBe(true);
    await t.mgr.stop({ envId, reason: 'stopped' });
    await waitUntil(() => !pidAlive(child), 5000, 'the grandchild to die');
  });
});

describe('guards', () => {
  it('refuses Docker unless the project allows it, secrets in --env, a cwd outside the repository and a foreign request', async () => {
    const t = setup();
    mgrs.push(t.mgr);
    const { p, envId } = t.start();
    await t.mgr.startEnv(p);
    const c = t.caller(p.requestId!);
    const docker = (await t.mgr.rpc(
      envId,
      'run.step',
      { name: 'compose', cmd: ['docker', 'compose', 'up'] },
      c,
    )) as any;
    expect(docker.ok).toBe(false);
    expect(docker.error).toMatch(/Docker, which is not allowed/);
    const secret = (await t.mgr.rpc(
      envId,
      'run.service',
      svcParams({ env: { API_TOKEN: 'abc' } }),
      c,
    )) as any;
    expect(secret.ok).toBe(false);
    expect(secret.error).toMatch(/looks like a credential/);
    expect(secret.error).toMatch(/--env-file/);
    const outside = (await t.mgr.rpc(envId, 'run.step', { name: 'x', cwd: '../..', cmd: ['ls'] }, c)) as any;
    expect(outside.ok).toBe(false);
    expect(outside.error).toMatch(/inside the repository/);
    const foreign = (await t.mgr.rpc(
      envId,
      'run.info',
      {},
      { requestId: randomUUID(), declared: [] },
    )) as any;
    expect(foreign.ok).toBe(false);
    expect(foreign.error).toMatch(/another DevOps request/);
  });

  it('allows Docker when the project does', async () => {
    const t = setup();
    mgrs.push(t.mgr);
    const { p, envId } = t.start('main', { allowDocker: true });
    await t.mgr.startEnv(p);
    const r = (await t.mgr.rpc(
      envId,
      'run.step',
      { name: 'x', cmd: ['docker', '--version'] },
      t.caller(p.requestId!),
    )) as any;
    expect(r.ok).toBe(true); // it ran (docker may not exist: the step then failed, which is fine)
  });

  it('refuses a service that contradicts the declared one', async () => {
    const t = setup();
    mgrs.push(t.mgr);
    const { p, envId } = t.start();
    await t.mgr.startEnv(p);
    const declared = [
      { name: 'web', repoId: t.repoId, cwd: '.', cmd: ['node', 'declared.js'], ports: [], after: [] },
    ];
    const r = (await t.mgr.rpc(envId, 'run.service', svcParams(), {
      requestId: p.requestId!,
      declared,
    })) as any;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/may not contradict/);
    expect(r.error).toMatch(/command/);
  });

  it('only a service env file outside the worktrees and the data folder is accepted, and its values are redacted from logs', async () => {
    const t = setup();
    mgrs.push(t.mgr);
    const { p, envId } = t.start();
    await t.mgr.startEnv(p);
    const c = t.caller(p.requestId!);
    const port = await freePort();
    const inRepo = (await t.mgr.rpc(
      envId,
      'run.service',
      svcParams({ envFile: join(t.paths.root, 'x.env') }),
      c,
    )) as any;
    expect(inRepo.ok).toBe(false);
    const rel = (await t.mgr.rpc(envId, 'run.service', svcParams({ envFile: 'x.env' }), c)) as any;
    expect(rel.ok).toBe(false);
    const envFile = join(tmp(), 'app.env');
    writeFileSync(envFile, 'MY_SECRET=supersecretvalue\n');
    const ok = (await t.mgr.rpc(
      envId,
      'run.service',
      svcParams({ envFile, ports: [{ name: 'http', default: port, envVar: 'PORT' }] }),
      c,
    )) as any;
    expect(ok.ok).toBe(true);
    const logs = (await t.mgr.rpc(envId, 'run.logs', { service: 'web' }, c)) as any;
    expect(logs.result.message).toContain('secret=***');
    expect(logs.result.message).not.toContain('supersecretvalue');
    // and the plan keeps only the path
    await t.mgr.rpc(envId, 'run.ready', {}, c);
    const saved = t.sent.find((s) => s.type === 'run.plan.saved')!;
    expect(JSON.stringify(saved.payload)).not.toContain('supersecretvalue');
    expect(saved.payload.plan.services[0].envFile).toBe(envFile);
  });
});

describe('steps', () => {
  it('runs a setup step, records it for the plan, and reports a failing one with its output', async () => {
    const t = setup();
    mgrs.push(t.mgr);
    const { p, envId } = t.start();
    await t.mgr.startEnv(p);
    const c = t.caller(p.requestId!);
    const ok = (await t.mgr.rpc(
      envId,
      'run.step',
      { name: 'build', cmd: ['node', '-e', 'console.log("built")'] },
      c,
    )) as any;
    expect(ok.result.exitCode).toBe(0);
    expect(ok.result.message).toContain('built');
    const bad = (await t.mgr.rpc(
      envId,
      'run.step',
      { name: 'lint', cmd: ['node', '-e', 'console.error("oops"); process.exit(2)'] },
      c,
    )) as any;
    expect(bad.result.exitCode).toBe(1);
    expect(bad.result.message).toMatch(/failed \(exit 2\)/);
    expect(bad.result.message).toContain('oops');
    const port = await freePort();
    await t.mgr.rpc(
      envId,
      'run.service',
      svcParams({ ports: [{ name: 'http', default: port, envVar: 'PORT' }] }),
      c,
    );
    await t.mgr.rpc(envId, 'run.ready', {}, c);
    const plan = t.sent.find((s) => s.type === 'run.plan.saved')!.payload.plan;
    expect(plan.setup.map((s: any) => s.name)).toEqual(['build']); // only the step that worked
  });

  it('kills a step that exceeds its timeout', async () => {
    const t = setup();
    mgrs.push(t.mgr);
    const { p, envId } = t.start();
    await t.mgr.startEnv(p);
    const r = (await t.mgr.rpc(
      envId,
      'run.step',
      { name: 'hang', cmd: ['sleep', '30'], timeoutSec: 1 },
      t.caller(p.requestId!),
    )) as any;
    expect(r.result.exitCode).toBe(1);
    expect(r.result.message).toMatch(/failed/);
  });

  it('answers "still running" when a step outlasts the wait, and --wait picks it up', async () => {
    const t = setup({ timing: { waitMs: 300 } as never });
    mgrs.push(t.mgr);
    const { p, envId } = t.start();
    await t.mgr.startEnv(p);
    const c = t.caller(p.requestId!);
    const first = (await t.mgr.rpc(envId, 'run.step', { name: 'slow', cmd: ['sleep', '1'] }, c)) as any;
    expect(first.result.exitCode).toBe(3);
    expect(first.result.message).toMatch(/still running/);
    await waitUntil(
      async () =>
        ((await t.mgr.rpc(envId, 'run.step', { name: 'slow', wait: true }, c)) as any).result.exitCode === 0,
      10_000,
      'the step to finish',
    );
  });
});

describe('runner restart and logs', () => {
  it('re-adopts a live service after a restart and stops it later; an environment whose services are gone ends as runner_restarted', async () => {
    const t = setup();
    mgrs.push(t.mgr);
    const { p, envId } = t.start();
    await t.mgr.startEnv(p);
    const port = await freePort();
    await t.mgr.rpc(
      envId,
      'run.service',
      svcParams({ ports: [{ name: 'http', default: port, envVar: 'PORT' }] }),
      t.caller(p.requestId!),
    );
    await t.mgr.rpc(envId, 'run.ready', {}, t.caller(p.requestId!));
    const pid = lastStatus(t.sent, envId)!.services[0].pid as number;
    t.mgr.shutdown(); // the old process ends; the service keeps running
    expect(pidAlive(pid)).toBe(true);

    const sent2: Sent[] = [];
    const next = new RunManager({
      paths: t.paths,
      findRepo: async () => ({ localPath: t.repo.clone }),
      send: (type, payload) => sent2.push({ type, payload }),
      log: { info() {}, warn() {}, error() {} },
      maxEnvironments: () => 2,
      portRange: () => ({ from: rangeBase, to: rangeBase + 400 }),
      timing: { healthPollMs: 40, superviseMs: 80, stopGraceMs: 400, recheckMs: 100 },
    });
    mgrs.push(next);
    await next.adopt();
    next.reportAll();
    await waitUntil(
      () => lastStatus(sent2, envId)?.state === 'healthy',
      10_000,
      'the adopted environment to be healthy',
    );
    expect(lastStatus(sent2, envId)!.services[0]).toMatchObject({ name: 'web', pid });
    await next.stop({ envId, reason: 'stopped' });
    await waitUntil(() => !pidAlive(pid), 5000, 'the adopted service to stop');

    // the same again, but the service dies while the runner is down
    const b = t.start();
    await next.startEnv({ ...b.p, requestId: b.p.requestId });
    const port2 = await freePort();
    await next.rpc(
      b.envId,
      'run.service',
      svcParams({ ports: [{ name: 'http', default: port2, envVar: 'PORT' }] }),
      t.caller(b.p.requestId!),
    );
    const pid2 = lastStatus(sent2, b.envId)!.services[0].pid as number;
    next.shutdown();
    process.kill(pid2, 'SIGKILL');
    await waitUntil(() => !pidAlive(pid2), 5000, 'the service to die');
    const sent3: Sent[] = [];
    const third = new RunManager({
      paths: t.paths,
      findRepo: async () => ({ localPath: t.repo.clone }),
      send: (type, payload) => sent3.push({ type, payload }),
      log: { info() {}, warn() {}, error() {} },
      maxEnvironments: () => 2,
      portRange: () => ({ from: rangeBase, to: rangeBase + 400 }),
    });
    mgrs.push(third);
    await third.adopt();
    expect(lastStatus(sent3, b.envId)).toMatchObject({ state: 'stopped', endReason: 'runner_restarted' });
  });

  it('streams log lines only while followed, with history first', async () => {
    const t = setup();
    mgrs.push(t.mgr);
    const { p, envId } = t.start();
    await t.mgr.startEnv(p);
    const port = await freePort();
    const script = `console.log('one'); setTimeout(()=>console.log('two'), 400); setInterval(()=>{}, 1000)`;
    await t.mgr.rpc(
      envId,
      'run.service',
      svcParams({
        name: 'chat',
        cmd: ['node', '-e', script],
        ports: [{ name: 'http', default: port }],
        health: { kind: 'none', graceSec: 0 },
      }),
      t.caller(p.requestId!),
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(t.sent.filter((s) => s.type === 'run.log')).toHaveLength(0); // nobody follows
    t.mgr.follow(envId, true);
    const hist = t.sent.find((s) => s.type === 'run.log' && s.payload.history);
    expect(hist?.payload.lines.join('\n')).toContain('one');
    await waitUntil(
      () => t.sent.some((s) => s.type === 'run.log' && !s.payload.history && s.payload.lines.includes('two')),
      5000,
      'the new line',
    );
    t.mgr.follow(envId, false);
    const n = t.sent.filter((s) => s.type === 'run.log').length;
    await new Promise((r) => setTimeout(r, 200));
    expect(t.sent.filter((s) => s.type === 'run.log').length).toBe(n);
  });

  it('fail ends the environment as failed with the reason', async () => {
    const t = setup();
    mgrs.push(t.mgr);
    const { p, envId } = t.start();
    await t.mgr.startEnv(p);
    const r = (await t.mgr.rpc(
      envId,
      'run.fail',
      { reason: 'needs a database nobody has' },
      t.caller(p.requestId!),
    )) as any;
    expect(r.ok).toBe(true);
    await waitUntil(() => lastStatus(t.sent, envId)?.state === 'failed', 5000, 'failed');
    expect(lastStatus(t.sent, envId)?.error).toBe('needs a database nobody has');
  });
});
