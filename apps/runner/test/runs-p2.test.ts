import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { type RunPlan, RunPlanSchema } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { runnerPaths } from '../src/paths.ts';
import { buildHash } from '../src/runs/discovery.ts';
import { RunManager, type RunManagerDeps } from '../src/runs/manager.ts';
import { pidAlive } from '../src/runs/proc.ts';
import {
  bwrapArgs,
  maskedPaths,
  ServiceLauncher,
  sandboxCommand,
  scopeCommand,
  scrubEnv,
} from '../src/runs/sandbox.ts';
import { cleanupTmp, makeRepo, sh, tmp, waitUntil } from './helpers.ts';

cleanupTmp();

const SERVER_JS = `
const http = require('node:http');
const port = Number(process.env.PORT || process.argv[2] || 0);
http.createServer((req, res) => { res.end('ok'); }).listen(port, '127.0.0.1', () => console.log('listening on ' + port + ' secret=' + (process.env.MY_SECRET || '')));
setInterval(() => {}, 1000);
`;
const BUILD_MD = '# build\nrun node server.js\n';
const hasBwrap = await new ServiceLauncher({ noScope: true }).sandboxAvailable();
const hasScope = await new ServiceLauncher().scopeAvailable();

interface Sent {
  type: string;
  payload: Record<string, any>;
}
const rangeBase = 43000 + Math.floor(Math.random() * 1500);
const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

function setup(over: Partial<RunManagerDeps> = {}) {
  const repo = makeRepo();
  writeFileSync(join(repo.clone, 'server.js'), SERVER_JS);
  writeFileSync(join(repo.clone, 'BUILD.md'), BUILD_MD);
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
    maxEnvironments: () => 3,
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
  const planFor = async (over: Record<string, unknown> = {}, service: Record<string, unknown> = {}) => {
    const port = await freePort();
    return RunPlanSchema.parse({
      repos: [{ repoId }],
      setup: [],
      services: [
        {
          name: 'web',
          repoId,
          cwd: '.',
          cmd: ['node', 'server.js'],
          ports: [{ name: 'http', default: port, envVar: 'PORT', url: 'http://localhost:${port}/' }],
          health: { kind: 'http', url: 'http://127.0.0.1:${port}/health' },
          startTimeoutSec: 10,
          ...service,
        },
      ],
      ...over,
    }) as RunPlan;
  };
  const start = (
    opts: { plan?: RunPlan; hash?: string | null; branch?: string; purpose?: 'manual' | 'test' } = {},
  ) => {
    const envId = randomUUID();
    const requestId = opts.plan ? null : randomUUID();
    return {
      envId,
      requestId,
      p: {
        envId,
        projectId: randomUUID(),
        projectKey: 'TOY',
        projectName: 'Toy',
        purpose: opts.purpose ?? ('manual' as const),
        requestId,
        sources: [
          { repoId, name: 'toy', remoteUrlNormalized: repo.remoteNormalized, branch: opts.branch ?? 'main' },
        ],
        services: [],
        portRange: { from: rangeBase, to: rangeBase + 400 },
        ttlAt: new Date(Date.now() + 3600_000).toISOString(),
        allowDocker: false,
        ...(opts.plan
          ? {
              replay: {
                planId: randomUUID(),
                version: 3,
                plan: opts.plan,
                buildHash: opts.hash === undefined ? buildHash([{ repoId, content: BUILD_MD }]) : opts.hash,
              },
            }
          : {}),
      },
    };
  };
  return { repo, root, paths, sent, mgr, repoId, planFor, start };
}

const mgrs: RunManager[] = [];
afterEach(async () => {
  for (const m of mgrs.splice(0)) {
    for (const id of m.liveEnvIds()) await m.stop({ envId: id, reason: 'failed' });
    m.shutdown();
  }
});
const last = (sent: Sent[], envId: string) =>
  [...sent].reverse().find((s) => s.type === 'run.status' && s.payload.envId === envId)?.payload;
const failures = (sent: Sent[]) => sent.filter((s) => s.type === 'run.replay.failed').map((s) => s.payload);

describe('service sandbox profile (D10)', () => {
  const spec = {
    runnerRoot: '/home/u/.aom-runner',
    realHome: '/home/u',
    worktrees: ['/home/u/.aom-runner/worktrees/P-1/run-abc/web'],
    cacheRoot: '/home/u/.aom-runner/cache',
    runTmp: '/tmp/aom-run-abc',
    uid: 1000,
  };

  it('keeps the host network, does not die with the parent, and writes only to worktree, caches and run tmp', () => {
    const a = bwrapArgs(spec);
    expect(a).not.toContain('--unshare-net');
    expect(a).not.toContain('--die-with-parent');
    expect(a).not.toContain('--new-session'); // the service already leads its own session (detached)
    expect(a).toContain('--unshare-pid');
    // the whole filesystem is read-only; the only writable binds are the three
    expect(a.slice(0, 3)).toEqual(['--ro-bind', '/', '/']);
    const binds: string[] = [];
    for (let i = 0; i < a.length; i++) if (a[i] === '--bind') binds.push(`${a[i + 1]}->${a[i + 2]}`);
    expect(binds).toEqual([
      '/tmp/aom-run-abc->/tmp',
      '/home/u/.aom-runner/worktrees/P-1/run-abc/web->/home/u/.aom-runner/worktrees/P-1/run-abc/web',
      '/home/u/.aom-runner/cache->/home/u/.aom-runner/cache',
    ]);
  });

  it('masks the same set agents cannot read (credential folders, runner data) before re-opening the worktree', () => {
    // paths that do not exist are skipped (bwrap cannot create them), so check the list rather than the argv
    const wanted = maskedPaths({ ...spec, runnerRoot: tmp(), realHome: tmp() });
    expect(wanted).toHaveLength(maskedPaths({ ...spec, runnerRoot: tmp(), realHome: tmp() }).length);
    const home = tmp();
    mkdirSync(join(home, '.ssh'));
    mkdirSync(join(home, '.aws'));
    writeFileSync(join(home, '.npmrc'), 'x');
    const root = tmp();
    const m = maskedPaths({ runnerRoot: root, realHome: home, uid: 1000 });
    expect(m).toEqual(
      expect.arrayContaining([root, join(home, '.ssh'), join(home, '.aws'), join(home, '.npmrc')]),
    );
    const args = bwrapArgs({ ...spec, runnerRoot: root, realHome: home });
    const i = (flag: string, path: string) => args.findIndex((x, k) => x === flag && args[k + 1] === path);
    expect(i('--tmpfs', root)).toBeGreaterThan(-1);
    expect(i('--tmpfs', join(home, '.ssh'))).toBeGreaterThan(-1);
    expect(
      args.findIndex(
        (x, k) => x === '--ro-bind' && args[k + 1] === '/dev/null' && args[k + 2] === join(home, '.npmrc'),
      ),
    ).toBeGreaterThan(-1);
    // the data dir is masked first, the worktree bound back afterwards
    expect(i('--tmpfs', root)).toBeLessThan(args.indexOf('--bind'));
  });

  it('wraps the command after --', () => {
    const c = sandboxCommand(spec, ['node', 'server.js']);
    expect(c.cmd).toBe('bwrap');
    expect(c.args.slice(-3)).toEqual(['--', 'node', 'server.js']);
  });

  it('scrubs credentials, buses and the runner variables from the environment', () => {
    const e = scrubEnv({
      PATH: '/usr/bin',
      LANG: 'C',
      GH_TOKEN: 'x',
      AWS_SECRET_ACCESS_KEY: 'x',
      SSH_AUTH_SOCK: '/tmp/s',
      XDG_RUNTIME_DIR: '/run/user/1000',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x',
      AOM_RUNNER_HOME: '/h',
      ANTHROPIC_API_KEY: 'x',
      DOTNET_ROOT: '/dotnet',
    });
    expect(e).toEqual({ PATH: '/usr/bin', LANG: 'C', DOTNET_ROOT: '/dotnet' });
  });

  it('a scope puts the command in its own systemd unit (the runner service kills only its own cgroup)', () => {
    const c = scopeCommand('aom-run-x', ['env', '-u', 'XDG_RUNTIME_DIR', 'bwrap', '--', 'node']);
    expect(c.cmd).toBe('systemd-run');
    expect(c.args).toEqual([
      '--user',
      '--scope',
      '--quiet',
      '--unit=aom-run-x',
      '--',
      'env',
      '-u',
      'XDG_RUNTIME_DIR',
      'bwrap',
      '--',
      'node',
    ]);
  });
});

describe.skipIf(!hasBwrap)('service sandbox (real bwrap)', () => {
  function sandboxSetup(home: string) {
    return setup({
      sandboxMode: () => ({ mode: 'required', allowUnsandboxed: false }),
      launcher: new ServiceLauncher({ noScope: true }),
      realHome: home,
    });
  }

  it('steps and services run sandboxed: worktree writable, the rest read-only, secrets and runner data unreadable, host network', async () => {
    const home = tmp('aom-fakehome-');
    mkdirSync(join(home, '.ssh'));
    writeFileSync(join(home, '.ssh', 'id_test'), 'PRIVATE');
    const t = sandboxSetup(home);
    mgrs.push(t.mgr);
    writeFileSync(join(t.paths.root, 'config.json'), '{"runnerToken":"SECRET"}');
    // a host-side http server the sandbox must reach over the shared network namespace
    const { createServer: http } = await import('node:http');
    const host = http((_q, r) => r.end('host-ok'));
    await new Promise<void>((r) => host.listen(0, '127.0.0.1', () => r()));
    const hostPort = (host.address() as { port: number }).port;
    try {
      const { p, envId } = t.start();
      await t.mgr.startEnv(p);
      const caller = { requestId: p.requestId as string, declared: [] as never[] };
      const probe = `
        const fs = require('fs');
        const out = {};
        const t = (k, f) => { try { out[k] = f(); } catch (e) { out[k] = 'ERR ' + e.code; } };
        t('writeWorktree', () => { fs.writeFileSync('inside.txt', 'x'); return 'ok'; });
        t('writeHomeDir', () => { fs.writeFileSync(${JSON.stringify(join(home, 'pwn.txt'))}, 'x'); return 'ok'; });
        t('writeEtc', () => { fs.writeFileSync('/etc/pwn', 'x'); return 'ok'; });
        t('readSsh', () => fs.readFileSync(${JSON.stringify(join(home, '.ssh', 'id_test'))}, 'utf8'));
        t('readRunnerConfig', () => fs.readFileSync(${JSON.stringify(join(t.paths.root, 'config.json'))}, 'utf8'));
        t('writeTmp', () => { fs.writeFileSync('/tmp/priv.txt', 'x'); return 'ok'; });
        t('home', () => process.env.HOME);
        fetch('http://127.0.0.1:${hostPort}/').then(r => r.text()).then(x => { out.net = x; }, e => { out.net = 'ERR ' + e.message; }).then(() => console.log('RESULT ' + JSON.stringify(out)));
      `;
      const r = (await t.mgr.rpc(
        envId,
        'run.step',
        { name: 'probe', cwd: '.', cmd: ['node', '-e', probe], wait: true },
        caller,
      )) as any;
      expect(r.ok).toBe(true);
      const logs = (await t.mgr.rpc(envId, 'run.logs', { service: 'probe' }, caller)) as any;
      const result = JSON.parse(/^RESULT (.*)$/m.exec(logs.result.message)?.[1] as string);
      expect(result.writeWorktree).toBe('ok');
      expect(result.writeHomeDir).toMatch(/^ERR (EROFS|EACCES|ENOENT)/);
      expect(result.writeEtc).toMatch(/^ERR (EROFS|EACCES)/);
      expect(result.readSsh).toMatch(/^ERR (ENOENT|EACCES)/); // masked: an empty tmpfs
      expect(result.readRunnerConfig).toMatch(/^ERR (ENOENT|EACCES)/);
      expect(result.writeTmp).toBe('ok');
      expect(existsSync('/tmp/priv.txt')).toBe(false); // the sandbox's /tmp is the run tmp dir
      expect(result.home).toBe('/tmp/home');
      expect(result.net).toBe('host-ok');
      expect(existsSync(join(home, 'pwn.txt'))).toBe(false);
    } finally {
      host.close();
    }
  });

  it('a sandboxed service gets its port, goes healthy and keeps running without the runner (re-adopted)', async () => {
    const home = tmp('aom-fakehome-');
    const t = sandboxSetup(home);
    mgrs.push(t.mgr);
    const { p, envId } = t.start();
    await t.mgr.startEnv(p);
    const port = await freePort();
    const caller = { requestId: p.requestId as string, declared: [] as never[] };
    const r = (await t.mgr.rpc(
      envId,
      'run.service',
      {
        name: 'web',
        cwd: '.',
        cmd: ['node', 'server.js'],
        ports: [{ name: 'http', default: port, envVar: 'PORT' }],
        health: { kind: 'http', url: 'http://127.0.0.1:${port}/health', expect: '2xx' },
      },
      caller,
    )) as any;
    expect(r.result.message).toMatch(/healthy/);
    const st = last(t.sent, envId)!;
    expect(st.services[0].sandbox).toBe('sandboxed');
    await t.mgr.rpc(envId, 'run.ready', {}, caller);
    const pid = st.services[0].pid as number;
    t.mgr.shutdown(); // no --die-with-parent: the service outlives this manager
    await new Promise((r2) => setTimeout(r2, 300));
    expect(pidAlive(pid)).toBe(true);
    const sent2: Sent[] = [];
    const next = new RunManager({
      paths: t.paths,
      findRepo: async () => ({ localPath: t.repo.clone }),
      send: (type, payload) => sent2.push({ type, payload }),
      log: { info() {}, warn() {}, error() {} },
      maxEnvironments: () => 3,
      portRange: () => ({ from: rangeBase, to: rangeBase + 400 }),
      launcher: new ServiceLauncher({ noScope: true }),
      timing: { healthPollMs: 40, superviseMs: 80, stopGraceMs: 400, recheckMs: 100 },
    });
    mgrs.push(next);
    await next.adopt();
    next.reportAll();
    await waitUntil(() => last(sent2, envId)?.state === 'healthy', 10_000, 'the adopted environment');
    await next.stop({ envId, reason: 'failed' });
    await waitUntil(() => !pidAlive(pid), 5000, 'the sandboxed service to stop');
  });

  it('refuses to start when the sandbox is required but cannot run', async () => {
    const t = setup({
      sandboxMode: () => ({ mode: 'required', allowUnsandboxed: false }),
      launcher: new ServiceLauncher({ probeBwrap: async () => false, noScope: true }),
    });
    mgrs.push(t.mgr);
    const { p, envId } = t.start();
    await t.mgr.startEnv(p);
    const caller = { requestId: p.requestId as string, declared: [] as never[] };
    const r = (await t.mgr.rpc(
      envId,
      'run.step',
      { name: 's', cwd: '.', cmd: ['true'], wait: true },
      caller,
    )) as any;
    const logs = (await t.mgr.rpc(envId, 'run.logs', { service: 's' }, caller)) as any;
    expect(r.result.message).toMatch(/failed/);
    expect(logs.result.message).toMatch(/service sandbox \(bubblewrap\) is not available/);
  });
});

describe('Docker steps run outside the sandbox, flagged', () => {
  it('a docker service is flagged `docker` (needs the project opt-in); best_effort without bwrap flags `off`', async () => {
    // a fake `docker` on PATH that behaves like the server
    const bin = tmp();
    writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexec node "$@"\n', { mode: 0o755 });
    const m2 = setup({
      sandboxMode: () => ({ mode: 'required', allowUnsandboxed: false }),
      launcher: new ServiceLauncher({ probeBwrap: async () => true, noScope: true }),
      pathDirs: () => [bin],
    });
    mgrs.push(m2.mgr);
    const { p, envId } = m2.start();
    await m2.mgr.startEnv({ ...p, allowDocker: true });
    const port = await freePort();
    const caller = { requestId: p.requestId as string, declared: [] as never[] };
    const r = (await m2.mgr.rpc(
      envId,
      'run.service',
      {
        name: 'web',
        cwd: '.',
        cmd: ['docker', 'server.js'],
        docker: true,
        ports: [{ name: 'http', default: port, envVar: 'PORT' }],
        health: { kind: 'tcp', port: 'http' },
      },
      caller,
    )) as any;
    expect(r.result.message).toMatch(/healthy/);
    expect(last(m2.sent, envId)!.services[0].sandbox).toBe('docker');
    // not allowed by the project: refused
    const q = m2.start();
    await m2.mgr.startEnv(q.p);
    const refused = (await m2.mgr.rpc(
      q.envId,
      'run.step',
      { name: 'd', cwd: '.', cmd: ['docker', 'compose', 'up'] },
      { requestId: q.p.requestId as string, declared: [] },
    )) as any;
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/Docker/);
  });

  it('without bwrap and with allowUnsandboxed the service runs and is flagged `off`', async () => {
    const t = setup({
      sandboxMode: () => ({ mode: 'best_effort', allowUnsandboxed: true }),
      launcher: new ServiceLauncher({ probeBwrap: async () => false, noScope: true }),
    });
    mgrs.push(t.mgr);
    const { p, envId } = t.start();
    await t.mgr.startEnv(p);
    const port = await freePort();
    await t.mgr.rpc(
      envId,
      'run.service',
      {
        name: 'web',
        cwd: '.',
        cmd: ['node', 'server.js'],
        ports: [{ name: 'http', default: port, envVar: 'PORT' }],
        health: { kind: 'tcp', port: 'http' },
      },
      { requestId: p.requestId as string, declared: [] },
    );
    expect(last(t.sent, envId)!.services[0].sandbox).toBe('off');
  });
});

describe.skipIf(!hasScope)('systemd scope (real)', () => {
  it('a service runs in a scope of its own, outside the runner service cgroup, and is stopped by pid', async () => {
    const t = setup({ launcher: new ServiceLauncher() });
    mgrs.push(t.mgr);
    const { p, envId } = t.start();
    await t.mgr.startEnv(p);
    const port = await freePort();
    await t.mgr.rpc(
      envId,
      'run.service',
      {
        name: 'web',
        cwd: '.',
        cmd: ['node', 'server.js'],
        ports: [{ name: 'http', default: port, envVar: 'PORT' }],
        health: { kind: 'tcp', port: 'http' },
      },
      { requestId: p.requestId as string, declared: [] },
    );
    const st = last(t.sent, envId)!;
    expect(st.services[0].state).toBe('healthy');
    const pid = st.services[0].pid as number;
    expect(readFileSync(`/proc/${pid}/cgroup`, 'utf8')).toMatch(/aom-run-/);
    await t.mgr.stop({ envId, reason: 'failed' });
    await waitUntil(() => !pidAlive(pid), 5000, 'the scoped service to stop');
  });
});

describe('plan replay', () => {
  it('replays a current plan with no DevOps request: setup steps, then the service, healthy', async () => {
    const t = setup();
    mgrs.push(t.mgr);
    const plan = await t.planFor({
      setup: [
        {
          name: 'install',
          repoId: t.repoId,
          cwd: '.',
          cmd: ['sh', '-c', 'echo ran >> marker.txt'],
          timeoutSec: 20,
        },
      ],
    });
    const { p, envId } = t.start({ plan });
    expect(await t.mgr.startEnv(p)).toEqual({ ok: true });
    await waitUntil(() => last(t.sent, envId)?.state === 'healthy', 15_000, 'the replay to finish');
    const st = last(t.sent, envId)!;
    expect(st.services[0]).toMatchObject({ name: 'web', state: 'healthy' });
    expect(failures(t.sent)).toEqual([]);
    expect(t.sent.some((s) => s.type === 'run.plan.saved')).toBe(false); // nothing new to save
    const wt = /(\S+run-\S+toy)/.exec(
      JSON.stringify(await t.mgr.rpc(envId, 'run.info', {}, { requestId: 'x', declared: [] })),
    )?.[1];
    expect(readFileSync(join(wt as string, 'marker.txt'), 'utf8')).toBe('ran\n');
  });

  it('starts services in `after` order and only the wanted ones with what they need', async () => {
    const t = setup();
    mgrs.push(t.mgr);
    const pa = await freePort();
    const pb = await freePort();
    const svc = (name: string, port: number, after: string[]) => ({
      name,
      repoId: t.repoId,
      cwd: '.',
      cmd: ['node', 'server.js'],
      ports: [{ name: 'http', default: port, envVar: 'PORT' }],
      health: { kind: 'tcp', port: 'http' },
      after,
      startTimeoutSec: 10,
    });
    const plan = RunPlanSchema.parse({
      repos: [{ repoId: t.repoId }],
      services: [svc('web', pa, ['api']), svc('api', pb, []), svc('worker', await freePort(), [])],
    });
    const { p, envId } = t.start({ plan });
    await t.mgr.startEnv({ ...p, services: ['web'] });
    await waitUntil(() => last(t.sent, envId)?.state === 'healthy', 15_000, 'the replay');
    expect(last(t.sent, envId)!.services.map((s: any) => s.name)).toEqual(['api', 'web']);
  });

  it('falls back to DevOps when a step fails: nothing is left running, the failure comes with the log tail', async () => {
    const t = setup();
    mgrs.push(t.mgr);
    const plan = await t.planFor({
      setup: [
        {
          name: 'build',
          repoId: t.repoId,
          cwd: '.',
          cmd: ['sh', '-c', 'echo compiling; echo BOOM >&2; exit 3'],
        },
      ],
    });
    const { p, envId } = t.start({ plan });
    await t.mgr.startEnv(p);
    await waitUntil(() => failures(t.sent).length === 1, 15_000, 'the fallback');
    const f = failures(t.sent)[0] as Record<string, any>;
    expect(f).toMatchObject({ envId, stale: false });
    expect(f.reason).toMatch(/step "build" failed \(exit 3\)/);
    expect(f.logTail).toContain('BOOM');
    const st = last(t.sent, envId)!;
    expect(st.state).toBe('starting');
    expect(st.services).toEqual([]);
    expect(st.activity).toMatch(/waiting for the DevOps engineer/);
  });

  it('falls back when the service does not get healthy, and the DevOps request that follows adopts the environment', async () => {
    const t = setup();
    mgrs.push(t.mgr);
    const plan = await t.planFor(
      {},
      { cmd: ['sh', '-c', 'echo starting; echo "cannot bind" >&2; exit 1'], startTimeoutSec: 5 },
    );
    const { p, envId } = t.start({ plan });
    await t.mgr.startEnv(p);
    await waitUntil(() => failures(t.sent).length === 1, 15_000, 'the fallback');
    const f = failures(t.sent)[0] as Record<string, any>;
    expect(f.reason).toMatch(/service "web" failed/);
    expect(f.logTail).toContain('cannot bind');
    // the DevOps engineer of the request the server filed now works the environment
    const requestId = randomUUID();
    const caller = { requestId, declared: [] as never[] };
    const port = await freePort();
    const r = (await t.mgr.rpc(
      envId,
      'run.service',
      {
        name: 'web',
        cwd: '.',
        cmd: ['node', 'server.js'],
        ports: [{ name: 'http', default: port, envVar: 'PORT' }],
        health: { kind: 'tcp', port: 'http' },
      },
      caller,
    )) as any;
    expect(r.result.message).toMatch(/healthy/);
    const ready = (await t.mgr.rpc(envId, 'run.ready', { notes: 'repaired' }, caller)) as any;
    expect(ready.ok).toBe(true);
    expect(t.sent.filter((s) => s.type === 'run.plan.saved')).toHaveLength(1); // the new plan version
    // and no other request may take it over
    expect(
      ((await t.mgr.rpc(envId, 'run.status', {}, { requestId: randomUUID(), declared: [] })) as any).ok,
    ).toBe(false);
  });

  it('a changed BUILD.md makes the plan stale: nothing runs, the fallback says so', async () => {
    const t = setup();
    mgrs.push(t.mgr);
    const plan = await t.planFor({
      setup: [{ name: 'install', repoId: t.repoId, cwd: '.', cmd: ['sh', '-c', 'echo ran >> marker.txt'] }],
    });
    const { p, envId } = t.start({ plan, hash: 'a-hash-of-an-older-build-md' });
    await t.mgr.startEnv(p);
    await waitUntil(() => failures(t.sent).length === 1, 15_000, 'the fallback');
    expect(failures(t.sent)[0]).toMatchObject({ stale: true });
    expect(failures(t.sent)[0]?.reason).toMatch(/BUILD\.md has changed/);
    expect(last(t.sent, envId)!.services).toEqual([]);
  });

  it('a plan whose cwd leaves the repository is refused by the runner too', async () => {
    const t = setup();
    mgrs.push(t.mgr);
    const plan = await t.planFor({}, { cwd: '../..' });
    const { p } = t.start({ plan });
    // the shared schema accepts it; the runner re-checks every step
    await t.mgr.startEnv(p);
    await waitUntil(() => failures(t.sent).length === 1, 15_000, 'the fallback');
    expect(failures(t.sent)[0]?.reason).toMatch(/inside the repository/);
  });

  it('a runner restart while a plan is being replayed hands over to DevOps', async () => {
    const t = setup();
    mgrs.push(t.mgr);
    const plan = await t.planFor({
      setup: [{ name: 'slow', repoId: t.repoId, cwd: '.', cmd: ['sleep', '30'], timeoutSec: 60 }],
    });
    const { p, envId } = t.start({ plan });
    await t.mgr.startEnv(p);
    await waitUntil(() => last(t.sent, envId)?.activity === 'running slow', 10_000, 'the slow step');
    t.mgr.shutdown();
    const sent2: Sent[] = [];
    const next = new RunManager({
      paths: t.paths,
      findRepo: async () => ({ localPath: t.repo.clone }),
      send: (type, payload) => sent2.push({ type, payload }),
      log: { info() {}, warn() {}, error() {} },
      maxEnvironments: () => 3,
      portRange: () => ({ from: rangeBase, to: rangeBase + 400 }),
      launcher: new ServiceLauncher({ noScope: true }),
    });
    mgrs.push(next);
    await next.adopt();
    expect(failures(sent2)).toHaveLength(1);
    expect(failures(sent2)[0]?.reason).toMatch(/runner restarted/);
  });
});

describe('restart, update and keeping worktrees', () => {
  async function running(over: Parameters<typeof setup>[0] = {}, planOver: Record<string, unknown> = {}) {
    const t = setup(over);
    mgrs.push(t.mgr);
    const plan = await t.planFor({
      setup: [
        {
          name: 'always',
          repoId: t.repoId,
          cwd: '.',
          cmd: ['sh', '-c', 'echo x >> always.txt'],
          when: 'always',
        },
        {
          name: 'first',
          repoId: t.repoId,
          cwd: '.',
          cmd: ['sh', '-c', 'echo x >> first.txt'],
          when: 'first',
        },
        {
          name: 'deps',
          repoId: t.repoId,
          cwd: '.',
          cmd: ['sh', '-c', 'echo x >> deps.txt'],
          when: 'changed:package.json',
        },
      ],
      ...planOver,
    });
    const s = t.start({ plan });
    await t.mgr.startEnv(s.p);
    await waitUntil(() => last(t.sent, s.envId)?.state === 'healthy', 15_000, 'the replay');
    const wt = (t.mgr as any).envs.get(s.envId).sources[0].path as string;
    return { t, ...s, wt, pid: () => last(t.sent, s.envId)!.services[0].pid as number };
  }
  const count = (file: string) =>
    existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;

  it('Restart: same commit, the services start again, `first` and `changed:` steps are skipped, `always` runs', async () => {
    const r = await running();
    // a fresh worktree ran everything once
    expect([
      count(join(r.wt, 'always.txt')),
      count(join(r.wt, 'first.txt')),
      count(join(r.wt, 'deps.txt')),
    ]).toEqual([1, 1, 1]);
    const before = r.pid();
    expect(
      await r.t.mgr.restart({
        envId: r.envId,
        update: false,
        ttlAt: new Date(Date.now() + 3600_000).toISOString(),
        revive: false,
      }),
    ).toEqual({ ok: true });
    await waitUntil(
      () => last(r.t.sent, r.envId)?.state === 'healthy' && r.pid() !== before,
      15_000,
      'the restart',
    );
    expect(pidAlive(before)).toBe(false);
    expect([
      count(join(r.wt, 'always.txt')),
      count(join(r.wt, 'first.txt')),
      count(join(r.wt, 'deps.txt')),
    ]).toEqual([2, 1, 1]);
    expect(r.t.sent.filter((s) => s.type === 'run.replay.failed')).toEqual([]);
  });

  it('Update & restart: fast-forwards the worktree to the branch head and runs `changed:` steps whose files changed', async () => {
    const r = await running();
    const head0 = sh(r.wt, 'git', ['rev-parse', 'HEAD']);
    // a new commit on the branch the environment runs (main) that touches package.json
    writeFileSync(join(r.t.repo.clone, 'package.json'), '{}');
    sh(r.t.repo.clone, 'git', ['add', '-A']);
    sh(r.t.repo.clone, 'git', ['commit', '-m', 'deps']);
    const head1 = sh(r.t.repo.clone, 'git', ['rev-parse', 'main']);
    expect(head1).not.toBe(head0);
    expect(
      (
        await r.t.mgr.restart({
          envId: r.envId,
          update: true,
          ttlAt: new Date(Date.now() + 3600_000).toISOString(),
          revive: false,
        })
      ).ok,
    ).toBe(true);
    await waitUntil(
      () =>
        last(r.t.sent, r.envId)?.state === 'healthy' &&
        last(r.t.sent, r.envId)?.sources?.[0]?.commit === head1,
      15_000,
      'the update',
    );
    expect(sh(r.wt, 'git', ['rev-parse', 'HEAD'])).toBe(head1);
    expect(existsSync(join(r.wt, 'package.json'))).toBe(true);
    expect([
      count(join(r.wt, 'always.txt')),
      count(join(r.wt, 'first.txt')),
      count(join(r.wt, 'deps.txt')),
    ]).toEqual([2, 1, 2]);
  });

  it('Update & restart refuses a rewritten branch and changes nothing', async () => {
    const r = await running();
    const head0 = sh(r.wt, 'git', ['rev-parse', 'HEAD']);
    const pid0 = r.pid();
    sh(r.t.repo.clone, 'git', ['reset', '--hard', 'HEAD~1']);
    writeFileSync(join(r.t.repo.clone, 'other.txt'), 'rewritten');
    sh(r.t.repo.clone, 'git', ['add', '-A']);
    sh(r.t.repo.clone, 'git', ['commit', '-m', 'rewritten']);
    const res = await r.t.mgr.restart({
      envId: r.envId,
      update: true,
      ttlAt: new Date(Date.now() + 3600_000).toISOString(),
      revive: false,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/was rewritten/);
    expect(sh(r.wt, 'git', ['rev-parse', 'HEAD'])).toBe(head0);
    expect(pidAlive(pid0)).toBe(true);
    expect(last(r.t.sent, r.envId)?.state).toBe('healthy');
  });

  it('a restart whose plan fails hands over to DevOps (services stopped, failure sent)', async () => {
    const r = await running();
    // break the plan: the step now fails
    const env = (r.t.mgr as any).envs.get(r.envId);
    env.plan.setup[0].cmd = ['sh', '-c', 'echo nope; exit 2'];
    const before = r.pid();
    await r.t.mgr.restart({
      envId: r.envId,
      update: false,
      ttlAt: new Date(Date.now() + 3600_000).toISOString(),
      revive: false,
    });
    await waitUntil(() => failures(r.t.sent).length === 1, 15_000, 'the fallback');
    expect(failures(r.t.sent)[0]?.reason).toMatch(/step "always" failed/);
    expect(pidAlive(before)).toBe(false);
  });

  it('a stopped manual environment with a plan keeps its worktrees and Restart revives it; a test environment does not keep them', async () => {
    const r = await running();
    await r.t.mgr.stop({ envId: r.envId, reason: 'stopped' });
    expect(last(r.t.sent, r.envId)).toMatchObject({ state: 'stopped', endReason: 'stopped' });
    expect(existsSync(r.wt)).toBe(true);
    expect(r.t.mgr.worktreeDirs().length).toBe(1); // the sweep leaves it alone
    expect(existsSync(`/tmp/aom-run-${r.envId.slice(0, 8)}`)).toBe(false); // the run tmp is gone
    const res = await r.t.mgr.restart({
      envId: r.envId,
      update: false,
      ttlAt: new Date(Date.now() + 3600_000).toISOString(),
      revive: true,
    });
    expect(res).toEqual({ ok: true });
    await waitUntil(() => last(r.t.sent, r.envId)?.state === 'healthy', 15_000, 'the revived environment');
    // build outputs of the first start are still there (incremental builds): the `first` step did not run again
    expect(count(join(r.wt, 'first.txt'))).toBe(1);

    const t2 = setup();
    mgrs.push(t2.mgr);
    const plan = await t2.planFor();
    const s = t2.start({ plan, purpose: 'test' });
    await t2.mgr.startEnv(s.p);
    await waitUntil(() => last(t2.sent, s.envId)?.state === 'healthy', 15_000, 'the test environment');
    const wt2 = (t2.mgr as any).envs.get(s.envId).sources[0].path as string;
    await t2.mgr.stop({ envId: s.envId, reason: 'verdict' });
    expect(existsSync(wt2)).toBe(false);
    expect(
      (
        await t2.mgr.restart({
          envId: s.envId,
          update: false,
          ttlAt: new Date(Date.now() + 3600_000).toISOString(),
          revive: true,
        })
      ).ok,
    ).toBe(false);
  });

  it('a manual environment without a plan (the DevOps engineer never finished) is removed on stop and cannot restart', async () => {
    const t = setup();
    mgrs.push(t.mgr);
    const s = t.start();
    await t.mgr.startEnv(s.p);
    const wt = (t.mgr as any).envs.get(s.envId).sources[0].path as string;
    expect(
      (await t.mgr.restart({ envId: s.envId, update: false, ttlAt: s.p.ttlAt, revive: false })).error,
    ).toMatch(/no run plan/);
    await t.mgr.stop({ envId: s.envId, reason: 'stopped' });
    expect(existsSync(wt)).toBe(false);
  });

  it('refuses to revive when the cap is reached', async () => {
    const r = await running({ maxEnvironments: () => 1 });
    await r.t.mgr.stop({ envId: r.envId, reason: 'stopped' });
    const plan = await r.t.planFor();
    const other = r.t.start({ plan });
    await r.t.mgr.startEnv(other.p);
    const res = await r.t.mgr.restart({ envId: r.envId, update: false, ttlAt: other.p.ttlAt, revive: true });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/already runs 1 environment/);
  });
});

describe('the run worktree sweep', () => {
  it('removes the run folders the server reports as not live, keeps live ones and ones with uncommitted changes, deletes nothing without an answer', async () => {
    const { sweepWorktrees } = await import('../src/git/sweep.ts');
    const t = setup();
    mgrs.push(t.mgr);
    const mk = async (): Promise<{ dir: string; wt: string }> => {
      const plan = await t.planFor();
      const s = t.start({ plan, purpose: 'manual' });
      await t.mgr.startEnv(s.p);
      await waitUntil(() => last(t.sent, s.envId)?.state === 'healthy', 15_000, 'a started environment');
      const wt = (t.mgr as any).envs.get(s.envId).sources[0].path as string;
      // kept after a stop (manual with a plan): the server decides when they are no longer wanted
      await t.mgr.stop({ envId: s.envId, reason: 'stopped' });
      return { dir: join(wt, '..'), wt };
    };
    const old = await mk();
    const dirty = await mk();
    const live = await mk();
    writeFileSync(join(dirty.wt, 'uncommitted.txt'), 'work');
    // a card worktree next to them is not touched by the run rules
    const answered = async (paths: string[]) => new Set(paths.filter((p) => p === live.dir));

    const none = await sweepWorktrees({ worktreesDir: t.paths.worktrees, liveOf: async () => null });
    expect(none.skipped).toBe('the server did not answer');
    expect(existsSync(old.wt)).toBe(true);

    const r = await sweepWorktrees({
      worktreesDir: t.paths.worktrees,
      liveOf: answered,
      repoPaths: [t.repo.clone],
    });
    expect(r.removed).toContain(old.wt);
    expect(existsSync(old.dir)).toBe(false);
    expect(r.dirty.map((d) => d.path)).toEqual([dirty.wt]);
    expect(r.dirty[0]?.files).toContain('uncommitted.txt');
    expect(existsSync(dirty.wt)).toBe(true);
    expect(existsSync(live.wt)).toBe(true);
    // the clone no longer lists the removed worktree
    expect(execFileSync('git', ['worktree', 'list'], { cwd: t.repo.clone, encoding: 'utf8' })).not.toContain(
      old.wt,
    );

    // busy folders (the runner's own live or kept environments) are never touched, whatever the server says
    const busy = await sweepWorktrees({
      worktreesDir: t.paths.worktrees,
      liveOf: async () => new Set<string>(),
      busyPaths: [live.dir, dirty.dir],
    });
    expect(busy.removed).not.toContain(live.wt);
    expect(existsSync(live.wt)).toBe(true);
  });
});
