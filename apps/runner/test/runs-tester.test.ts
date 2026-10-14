import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runnerPaths } from '../src/paths.ts';
import { buildHash } from '../src/runs/discovery.ts';
import { RunManager } from '../src/runs/manager.ts';
import { ServiceLauncher } from '../src/runs/sandbox.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, makeRepo, sh, tmp, waitUntil } from './helpers.ts';
import { ScriptedAdapter } from './scripted-adapter.ts';

cleanupTmp();

const SERVER_JS = `require('http').createServer((q, s) => s.end('app:' + q.url)).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('up secret=' + (process.env.MY_SECRET || ''))); setInterval(() => {}, 1000);`;
const BUILD_MD = '# build\nnode server.js\n';
const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

function repoWithApp() {
  const repo = makeRepo();
  writeFileSync(join(repo.clone, 'server.js'), SERVER_JS);
  writeFileSync(join(repo.clone, 'BUILD.md'), BUILD_MD);
  sh(repo.clone, 'git', ['add', '-A']);
  sh(repo.clone, 'git', ['commit', '-m', 'app']);
  sh(repo.clone, 'git', ['push', 'origin', 'main']);
  return repo;
}

/** A card branch with one commit, checked out as a worktree where the runner keeps card worktrees. */
function cardWorktree(
  repo: ReturnType<typeof makeRepo>,
  worktrees: string,
  file = 'card.txt',
  body = 'card\n',
) {
  const dir = join(worktrees, 'TOY-aaaaaaaa', 'TOY-1');
  mkdirSync(join(worktrees, 'TOY-aaaaaaaa'), { recursive: true });
  sh(repo.clone, 'git', ['worktree', 'add', '-b', 'aom/toy-1-card', dir, 'main']);
  writeFileSync(join(dir, file), body);
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-m', 'card work']);
  return dir;
}

/** The base branch moves on origin after the card branch was cut. */
function moveMain(repo: ReturnType<typeof makeRepo>, file: string, body: string) {
  writeFileSync(join(repo.clone, file), body);
  sh(repo.clone, 'git', ['add', '-A']);
  sh(repo.clone, 'git', ['commit', '-m', `main moves: ${file}`]);
  sh(repo.clone, 'git', ['push', 'origin', 'main']);
}

describe('a test environment for a card (rebaseCard)', () => {
  function manager() {
    const repo = repoWithApp();
    const root = tmp();
    const paths = runnerPaths(root);
    mkdirSync(paths.worktrees, { recursive: true });
    const sent: Array<{ type: string; payload: Record<string, any> }> = [];
    const mgr = new RunManager({
      paths,
      findRepo: async () => ({ localPath: repo.clone }),
      send: (type, payload) => sent.push({ type, payload }),
      log: { info() {}, warn() {}, error() {} },
      maxEnvironments: () => 3,
      launcher: new ServiceLauncher({ noScope: true }),
      portRange: () => ({ from: 44000, to: 44400 }),
      timing: { waitMs: 8000, healthPollMs: 40, superviseMs: 80, logFlushMs: 60, stopGraceMs: 400 },
    });
    const repoId = randomUUID();
    const payload = (branch: string, rebaseCard: { cardWorktreePath: string }) => ({
      envId: randomUUID(),
      projectId: randomUUID(),
      projectKey: 'TOY',
      projectName: 'Toy',
      purpose: 'test' as const,
      requestId: randomUUID(),
      sources: [{ repoId, name: 'toy', remoteUrlNormalized: repo.remoteNormalized, branch }],
      services: [],
      portRange: { from: 44000, to: 44400 },
      ttlAt: new Date(Date.now() + 3600_000).toISOString(),
      allowDocker: false,
      rebaseCard: { repoId, baseBranch: 'main', ...rebaseCard },
    });
    return { repo, paths, sent, mgr, repoId, payload };
  }
  const running: RunManager[] = [];
  afterEach(async () => {
    for (const m of running.splice(0)) {
      for (const id of m.liveEnvIds()) await m.stop({ envId: id, reason: 'failed' });
      m.shutdown();
    }
  });

  it('rebases the card branch onto its base first and runs the rebased commit', async () => {
    const m = manager();
    running.push(m.mgr);
    const wt = cardWorktree(m.repo, m.paths.worktrees);
    moveMain(m.repo, 'later.txt', 'main moved\n');
    const before = sh(wt, 'git', ['rev-parse', 'HEAD']);
    const p = m.payload('aom/toy-1-card', { cardWorktreePath: wt });
    const r = await m.mgr.startEnv(p);
    expect(r).toEqual({ ok: true });
    const after = sh(wt, 'git', ['rev-parse', 'HEAD']);
    expect(after).not.toBe(before);
    expect(sh(wt, 'git', ['merge-base', '--is-ancestor', 'origin/main', 'HEAD'])).toBe('');
    // the environment runs exactly the rebased commit, and the tester's own rebase finds nothing to do
    expect(m.mgr.sourcesOf(p.envId)[0]?.commit).toBe(after);
    expect(m.mgr.testEnvironment(p.envId)?.sources[0]).toMatchObject({ name: 'toy', commit: after });
  });

  it('fails the start with the conflicting files and leaves the card worktree clean', async () => {
    const m = manager();
    running.push(m.mgr);
    const wt = cardWorktree(m.repo, m.paths.worktrees, 'README.md', 'the card edits this\n');
    moveMain(m.repo, 'README.md', 'main edits this\n');
    const p = m.payload('aom/toy-1-card', { cardWorktreePath: wt });
    const r = await m.mgr.startEnv(p);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/conflicts with main: README\.md/);
    const last = [...m.sent].reverse().find((s) => s.type === 'run.status' && s.payload.envId === p.envId);
    expect(last?.payload).toMatchObject({
      state: 'failed',
      endReason: 'failed',
      rebaseConflictFiles: ['README.md'],
    });
    expect(sh(wt, 'git', ['status', '--porcelain'])).toBe('');
    expect(existsSync(join(wt, '.git'))).toBe(true);
  });

  it('refuses a card worktree outside the runner worktrees', async () => {
    const m = manager();
    running.push(m.mgr);
    const outside = tmp();
    const r = await m.mgr.startEnv(m.payload('main', { cardWorktreePath: outside }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not inside this runner/);
  });
});

describe('a tester working in a test environment', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.stop();
    h = undefined;
  });

  it('reaches the app through the forwarder sockets, reads the environment and reports suites with JUnit counts', async () => {
    const repo = repoWithApp();
    const envId = randomUUID();
    const repoId = randomUUID();
    const port = await freePort();
    const rpcs: Array<{ method: string; params: Record<string, any> }> = [];
    const seen: Record<string, any> = {};
    const adapter = new ScriptedAdapter(async (input, ctl) => {
      const forwards = String(input.env.AOM_ENV_FORWARDS ?? '');
      seen.forwards = forwards;
      seen.envId = input.env.AOM_ENV_ID;
      const sock = forwards
        .split(',')
        .find((x) => x.startsWith(`${port}=`))
        ?.slice(`${port}=`.length);
      if (sock) {
        seen.http = await new Promise<string>((resolve, reject) => {
          const c = net.connect(sock);
          let data = '';
          c.on('data', (d) => {
            data += d;
          });
          c.on('close', () => resolve(data));
          c.on('error', reject);
          c.write('GET /hello HTTP/1.0\r\n\r\n');
        });
      }
      seen.sockets = sock;
      seen.info = await ctl.post('/v1/rpc', { method: 'env.info', params: {} });
      seen.logs = await ctl.post('/v1/rpc', { method: 'env.logs', params: { service: 'web' } });
      seen.suites = await ctl.post('/v1/rpc', { method: 'env.suites', params: {} });
      // a JUnit report the suite wrote in the worktree; a failing case downgrades a "passed" claim
      mkdirSync(join(input.cwd, 'test-results'), { recursive: true });
      writeFileSync(
        join(input.cwd, 'test-results', 'junit.xml'),
        '<testsuite><testcase classname="a" name="ok"/><testcase classname="a" name="bad"><failure>boom MY_SECRET_VALUE</failure></testcase></testsuite>',
      );
      writeFileSync(join(input.cwd, 'test-results', 'api.log'), 'ran\nsecret=hunter2-secret-value\n');
      seen.suite = await ctl.post('/v1/rpc', {
        method: 'test.suite',
        params: { name: 'api', status: 'passed', junit: 'test-results/*.xml', log: 'test-results/api.log' },
      });
      seen.escape = await ctl.post('/v1/rpc', {
        method: 'test.suite',
        params: { name: 'api', status: 'passed', log: '/etc/passwd' },
      });
      await ctl.post('/v1/report', {
        report: {
          kind: 'outcome',
          outcomeId: 'pass',
          note: 'ok',
          data: { summary: 'ok', commands: [], outputExcerpt: '' },
        },
      });
    });
    h = await startHarness(
      {
        rpc: (msg) => {
          rpcs.push({ method: msg.method, params: msg.params as Record<string, any> });
          if (msg.method === 'env.suites')
            return {
              ok: true,
              result: {
                mode: 'local',
                flakyRetry: 1,
                suites: [
                  {
                    name: 'api',
                    kind: 'integration',
                    cmd: ['npm', 'run', 'it'],
                    cwd: '.',
                    confirmed: true,
                    timeoutMin: 20,
                    destructive: false,
                  },
                ],
              },
            };
          if (msg.method === 'test.suite') return { ok: true, result: { message: 'Recorded as failed.' } };
          return { ok: false, error: 'not in the fake' };
        },
      },
      { adapters: new Map([['mock', adapter]]) },
      repo,
    );

    // the saved plan is replayed: the app is up when the tester starts
    const plan = {
      repos: [{ repoId }],
      setup: [],
      services: [
        {
          name: 'web',
          repoId,
          cwd: '.',
          cmd: ['node', 'server.js'],
          ports: [{ name: 'http', default: port, envVar: 'PORT', url: 'http://localhost:${port}/' }],
          health: { kind: 'http', url: 'http://127.0.0.1:${port}/' },
          startTimeoutSec: 20,
        },
      ],
    };
    h.server.send('command', {
      commandId: 'c-start',
      command: 'run.start',
      payload: {
        envId,
        projectId: randomUUID(),
        projectKey: 'TOY',
        projectName: 'Toy',
        purpose: 'test',
        requestId: null,
        sources: [{ repoId, name: 'toy', remoteUrlNormalized: repo.remoteNormalized, branch: 'main' }],
        services: [],
        portRange: { from: 44500, to: 44900 },
        ttlAt: new Date(Date.now() + 3600_000).toISOString(),
        allowDocker: false,
        replay: {
          planId: randomUUID(),
          version: 1,
          plan,
          buildHash: buildHash([{ repoId, content: BUILD_MD }]),
        },
      },
    });
    await waitUntil(
      () => h!.server.of('run.status').some((s) => s.envId === envId && s.state === 'healthy'),
      30_000,
      'the environment to be healthy',
    );
    const healthy = [...h.server.of('run.status')].reverse().find((s) => s.envId === envId)!;
    const livePort = healthy.services[0]?.ports[0]?.port as number;
    expect(livePort).toBe(port);

    const res = await h.runShift({
      stage: 'test',
      mode: 'create',
      briefExtra: {
        environment: {
          mode: 'local',
          envId,
          flakyRetry: 1,
          suites: [
            {
              name: 'api',
              repoId,
              cwd: '.',
              cmd: ['npm', 'run', 'it'],
              kind: 'integration',
              timeoutMin: 20,
              destructive: false,
              confirmed: true,
            },
          ],
        },
      },
    });
    expect(res.ended.outcome).toBe('reported');

    // the sandbox reaches the app on its own port through the Unix socket, and the instructions say how
    expect(seen.envId).toBe(envId);
    expect(seen.forwards).toContain(`${port}=`);
    expect(seen.http).toContain('app:/hello');
    const note = adapter.inputs[0]?.instructionsMarkdown ?? '';
    expect(note).toContain('## Environment');
    expect(note).toContain('aom-env --timeout');
    expect(note).toContain(`http://localhost:${port}/`);
    expect(note).toContain('api (integration');
    expect(seen.info.json.result.message).toContain('aom-env');
    expect(seen.logs.json.ok).toBe(true);
    expect(seen.suites.json.result.suites[0].name).toBe('api');

    // the report counts the cases and refuses to call a failing run passed; the server hears the truth
    const sent = rpcs.find(
      (r) => r.method === 'test.suite' && r.params.junit === undefined && r.params.passed === 1,
    );
    expect(sent?.params).toMatchObject({
      name: 'api',
      status: 'failed',
      passed: 1,
      failed: 1,
      skipped: 0,
      failures: ['a > bad'],
    });
    expect(seen.suite.json.result.message).toMatch(/recorded as failed/i);
    expect(seen.suite.json.result.message).toMatch(/1 failing case/);
    // a file outside the worktree, scratch and temp folders is refused
    expect(seen.escape.json.ok).toBe(false);
    expect(seen.escape.json.error).toMatch(/inside your worktree/);

    // the sockets are gone with the shift
    expect(seen.sockets && existsSync(seen.sockets)).toBe(false);
  });

  it('turns a tester away with environment_not_ready when the environment is not up', async () => {
    const repo = repoWithApp();
    h = await startHarness(
      {},
      { adapters: new Map([['mock', new ScriptedAdapter(async () => undefined)]]) },
      repo,
    );
    const msg = (await import('./fixtures.ts')).makeShiftStart({
      stage: 'test',
      mode: 'create',
      remoteNormalized: repo.remoteNormalized,
      briefExtra: { environment: { mode: 'local', envId: randomUUID(), flakyRetry: 1, suites: [] } },
    });
    h.server.send('shift.start', msg);
    const rej = await h.server.waitFor('shift.rejected', (m) => m.shiftId === msg.shiftId, 30_000);
    expect(rej).toMatchObject({ reason: 'environment_not_ready', environment: { problem: 'run_failed' } });
  });
});
