import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { CheckEvidenceSchema, IntegrationSuiteSchema } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { handoffCheckDoctorLines, sandboxDoctorLines } from '../src/adapters/claude-policy.ts';
import {
  type CheckLaunch,
  countsText,
  environmentProblem,
  type LaunchOptions,
  runHandoffChecks,
} from '../src/checks/run.ts';
import { checkRunId, unitCounts } from '../src/checks/units.ts';
import { runnerPaths } from '../src/paths.ts';
import { startServiceForwards } from '../src/runs/forward.ts';
import { RunManager } from '../src/runs/manager.ts';
import { decideCheckServices, type TestServiceDecision } from '../src/sandbox/test-services.ts';
import { CHECK_BRIDGE_EXIT, CHECK_BRIDGE_SCRIPT, CHECK_ENV_PREFIX } from '../src/shims.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

const REPO = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
const unit = (script: string) =>
  IntegrationSuiteSchema.parse({
    name: 'server',
    repoId: REPO,
    kind: 'unit',
    cwd: 'apps/server',
    cmd: ['sh', '-c', script],
    handoffCmd: ['sh', '-c', script, 'x', '{files}'],
  });
const lint = IntegrationSuiteSchema.parse({ name: 'lint', repoId: REPO, kind: 'check', cmd: ['true'] });
const plain = (argv: string[]): CheckLaunch => ({
  cmd: argv[0] as string,
  args: argv.slice(1),
  env: { PATH: process.env.PATH ?? '' },
});
function worktree() {
  const wt = tmp('aom-svc-wt-');
  mkdirSync(join(wt, 'apps/server/test'), { recursive: true });
  writeFileSync(join(wt, 'apps/server/test/a.test.ts'), 'x\n');
  return { worktree: wt, logDir: join(tmp('aom-svc-log-'), 'checks') };
}
const cap = (output: string, exitCode: number | null = 1) => ({
  output,
  capped: false,
  exitCode,
  timedOut: false,
  aborted: false,
});
const fakeForwards = (failed: string[] = []) => {
  let closed = 0;
  return {
    forwards: [{ name: 'postgres-test', host: '127.0.0.1', port: 5433 }],
    failures: () => failed,
    close: () => {
      closed++;
    },
    closed: () => closed,
  };
};
const allowed: TestServiceDecision = {
  name: 'postgres-test',
  host: '127.0.0.1',
  port: 5433,
  state: 'allowed',
};

/** Unix socket listeners are refused inside some command sandboxes: the forwarder tests need them. */
const canListenUnix = await new Promise<boolean>((resolve) => {
  const dir = tmp('aom-svc-probe-');
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(join(dir, 'p.sock'), () => s.close(() => resolve(true)));
});

const tcpServer = async (onConn?: (c: net.Socket) => void) => {
  const s = net.createServer((c) => (onConn ? onConn(c) : c.end('hello\n')));
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { server: s, port: (s.address() as net.AddressInfo).port };
};

describe('decideCheckServices', () => {
  const base = {
    services: [allowed],
    kind: 'card',
    roleKey: 'builder',
    isDevops: false,
    platform: 'linux' as NodeJS.Platform,
    runnerPorts: new Set<number>(),
  };
  it('a builder card shift on Linux gets the declared loopback services', () => {
    expect(decideCheckServices(base)).toEqual([allowed]);
  });
  it('every other shift gets nothing (only a builder handoff runs unit tests)', () => {
    expect(decideCheckServices({ ...base, roleKey: 'tester' })).toEqual([]);
    expect(decideCheckServices({ ...base, roleKey: 'reviewer' })).toEqual([]);
    expect(decideCheckServices({ ...base, isDevops: true })).toEqual([]);
    expect(decideCheckServices({ ...base, kind: 'chat' })).toEqual([]);
    expect(decideCheckServices({ ...base, services: undefined })).toEqual([]);
  });
  it('refuses non-loopback hosts, runner and reserved ports, and other platforms, with the reason', () => {
    const d = decideCheckServices({
      ...base,
      services: [
        { name: 'remote', host: '10.0.0.5' as never, port: 5432 },
        { name: 'ipc', host: '127.0.0.1', port: 4100 },
        { name: 'proxy', host: '127.0.0.1', port: 3128 },
      ],
      runnerPorts: new Set([4100]),
    });
    expect(d.map((x) => x.state)).toEqual(['refused', 'refused', 'refused']);
    expect(JSON.stringify(d)).toMatch(/only 127\.0\.0\.1.*belongs to the runner.*sandbox proxy/);
    const mac = decideCheckServices({ ...base, platform: 'darwin' });
    expect(mac[0]).toMatchObject({ state: 'refused', reason: expect.stringMatching(/no network namespace/) });
  });
});

describe('checkRunId and unitCounts', () => {
  it('gives every run its own short lowercase id, also two runs of one shift at the same head', () => {
    const a = checkRunId('019e3f6a-7b1c-7a2d', 'ABCDEF1234567890');
    const b = checkRunId('019e3f6a-7b1c-7a2d', 'ABCDEF1234567890');
    const other = checkRunId('aaaa1111-2222', 'ABCDEF1234567890');
    expect(a).toMatch(/^c019e3f6aabcdef12[0-9a-f]{4}$/);
    expect(a).toHaveLength(21);
    expect(`aom_test_${a}`).toMatch(/^aom_test(_[a-z0-9]+)?$/);
    expect(new Set([a, b, other, checkRunId('019e3f6a-7b1c-7a2d', 'ABCDEF1234567890')]).size).toBe(4);
  });
  it('reads the real counts of vitest and jest', () => {
    expect(
      unitCounts(' Test Files  1 failed | 2 passed (3)\n      Tests  1 failed | 11 passed (12)\n'),
    ).toEqual({
      files: { failed: 1, passed: 2, total: 3 },
      tests: { failed: 1, passed: 11, total: 12 },
    });
    expect(unitCounts('Test Suites: 3 passed, 3 total\nTests:       12 passed, 12 total\n')).toEqual({
      files: { failed: 0, passed: 3, total: 3 },
      tests: { failed: 0, passed: 12, total: 12 },
    });
    expect(unitCounts('no summary here')).toEqual({});
    expect(countsText(' Test Files  3 passed (3)\n      Tests  12 passed (12)\n')).toBe(
      '12 tests in 3 files',
    );
    expect(countsText('Tests  1 failed | 11 passed (12)')).toBe('1 failed, 11 passed of 12 tests');
  });
});

describe('environmentProblem', () => {
  it('names the declared service whose forwarder could not connect (strong signal), even with FAIL lines', () => {
    const p = environmentProblem(cap('FAIL test/a.test.ts'), ['test/a.test.ts'], {
      forwards: fakeForwards(['127.0.0.1:5433']),
    });
    expect(p).toEqual({
      text: expect.stringMatching(/postgres-test \(127\.0\.0\.1:5433\).*did not accept a connection/),
      environment: '127.0.0.1:5433',
    });
  });
  it('reads the bridge exit line', () => {
    const p = environmentProblem(
      cap(
        `${CHECK_ENV_PREFIX} socat is not installed on this workstation, so the test services (127.0.0.1:5433=/tmp/svc/5433.sock) cannot be reached`,
        CHECK_BRIDGE_EXIT,
      ),
      [],
      undefined,
    );
    expect(p?.text).toMatch(/^socat is not installed/);
    expect(p?.environment).toBe('127.0.0.1:5433');
  });
  it('a refused loopback connection with no failing test file: declared, refused for checks, or undeclared', () => {
    const out = cap('Error: connect ECONNREFUSED 127.0.0.1:5433\n    at TCPConnectWrap');
    expect(environmentProblem(out, [], { services: [allowed] })?.text).toMatch(
      /could not connect to 127\.0\.0\.1:5433 \(postgres-test\)/,
    );
    expect(
      environmentProblem(out, [], {
        services: [
          { ...allowed, state: 'refused', reason: 'no network namespace for the checks on this platform' },
        ],
      })?.text,
    ).toMatch(/not reachable from handoff checks: no network namespace/);
    expect(environmentProblem(out, [], { services: [] })).toEqual({
      text: expect.stringMatching(
        /127\.0\.0\.1:5433, which is not declared in Project settings > Local test services/,
      ),
      environment: '127.0.0.1:5433',
    });
  });
  it('is no environment problem when a test file fails, the run passed, timed out or was stopped', () => {
    const out = 'ECONNREFUSED 127.0.0.1:6379';
    expect(environmentProblem(cap(out), ['test/a.test.ts'], { services: [] })).toBeUndefined();
    expect(environmentProblem(cap(out, 0), [], {})).toBeUndefined();
    expect(environmentProblem({ ...cap(out), timedOut: true }, [], {})).toBeUndefined();
    expect(environmentProblem({ ...cap(out), aborted: true }, [], {})).toBeUndefined();
    expect(environmentProblem(cap('ECONNREFUSED 10.1.2.3:5432'), [], {})).toBeUndefined();
  });
});

describe('runHandoffChecks with test services', () => {
  const run = (
    script: string,
    launch: (argv: string[], key: string, o: LaunchOptions) => Promise<CheckLaunch>,
  ) =>
    runHandoffChecks({
      ...worktree(),
      suites: [lint],
      units: [unit(script)],
      changedPaths: ['apps/server/test/a.test.ts'],
      headSha: 'abcdef1234567890',
      launch,
    });

  it('a unit launch is told it is a unit run, a check is not; the forwarders are closed after the run', async () => {
    const seen: boolean[] = [];
    const fw = fakeForwards();
    const r = await run(
      'echo " Test Files  1 passed (1)"; echo "      Tests  4 passed (4)"',
      async (argv, _k, o) => {
        seen.push(o.unit);
        return o.unit ? { ...plain(argv), forwards: fw, services: [allowed] } : plain(argv);
      },
    );
    expect(seen).toEqual([false, true]);
    expect(fw.closed()).toBe(1);
    expect(r.evidence[1]).toMatchObject({
      kind: 'unit',
      status: 'passed',
      summary: 'passed: 4 tests in 1 file',
    });
    expect(r.blocking).toEqual([]);
  });

  it('a database that does not answer is an environment problem naming host:port: error, no FAIL lines, its own refusal', async () => {
    const fw = fakeForwards(['127.0.0.1:5433']);
    const r = await run('echo "Error: connect ECONNREFUSED 127.0.0.1:5433"; exit 1', async (argv, _k, o) =>
      o.unit ? { ...plain(argv), forwards: fw, services: [allowed] } : plain(argv),
    );
    const ev = r.evidence[1];
    expect(ev).toMatchObject({ status: 'error', environment: '127.0.0.1:5433', introduced: [] });
    expect(ev?.summary).toMatch(/^environment problem: the test service postgres-test \(127\.0\.0\.1:5433\)/);
    expect(r.blocking).toHaveLength(1);
    expect(r.refusal).toMatch(/environment problem on this workstation, not a failure in your code/);
    expect(r.refusal).toMatch(/aom devops "start the test service 127\.0\.0\.1:5433"/);
    expect(r.refusal).toMatch(/Do not change or skip tests/);
    expect(fw.closed()).toBe(1);
    // the server keeps the field
    expect(CheckEvidenceSchema.parse(ev).environment).toBe('127.0.0.1:5433');
  });

  it('an undeclared database is an environment problem too, never a pass', async () => {
    const r = await run('echo "connect ECONNREFUSED 127.0.0.1:5433"; exit 1', async (argv) => plain(argv));
    expect(r.evidence[1]).toMatchObject({ status: 'error', environment: '127.0.0.1:5433' });
    expect(r.evidence[1]?.summary).toMatch(/not declared/);
  });

  it('a failing test with the database reachable still fails and names the test, with the real counts', async () => {
    const r = await run(
      'echo " FAIL  test/a.test.ts > breaks"; echo " Test Files  1 failed (1)"; echo "      Tests  1 failed | 3 passed (4)"; exit 1',
      async (argv, _k, o) =>
        o.unit ? { ...plain(argv), forwards: fakeForwards(), services: [allowed] } : plain(argv),
    );
    expect(r.evidence[1]).toMatchObject({
      status: 'failed',
      introduced: ['FAIL apps/server/test/a.test.ts'],
    });
    expect(r.evidence[1]?.summary).toBe('1 test file failing (1 failed, 3 passed of 4 tests in 1 file)');
    expect(r.evidence[1]?.environment).toBeUndefined();
  });

  it('closes the forwarders also when the run times out', async () => {
    const fw = fakeForwards();
    const r = await runHandoffChecks({
      ...worktree(),
      suites: [],
      units: [unit('sleep 30')],
      changedPaths: ['apps/server/test/a.test.ts'],
      headSha: 'abcdef1234567890',
      unitBudgetMs: 1500,
      launch: async (argv) => ({ ...plain(argv), forwards: fw }),
    });
    expect(r.evidence[0]?.status).toBe('timeout');
    expect(fw.closed()).toBe(1);
  }, 15_000);
});

describe('CHECK_BRIDGE_SCRIPT', () => {
  it('runs the command and returns its exit status with an empty spec', () => {
    const r = spawnSync(
      'bash',
      ['-c', CHECK_BRIDGE_SCRIPT, 'aom-check-bridge', '', 'sh', '-c', 'echo ran; exit 7'],
      {
        encoding: 'utf8',
      },
    );
    expect(r.stdout).toContain('ran');
    expect(r.status).toBe(7);
  });
  it('without socat: an environment line and exit 125, the command does not run', () => {
    const r = spawnSync(
      '/bin/bash',
      [
        '-c',
        CHECK_BRIDGE_SCRIPT,
        'aom-check-bridge',
        '127.0.0.1:5433=/tmp/svc/5433.sock',
        'sh',
        '-c',
        'echo ran',
      ],
      { encoding: 'utf8', env: { PATH: '/nonexistent' } },
    );
    expect(r.status).toBe(CHECK_BRIDGE_EXIT);
    expect(r.stderr).toContain(`${CHECK_ENV_PREFIX} socat is not installed`);
    expect(r.stdout).not.toContain('ran');
  });
  it('rejects a malformed entry as an environment problem', () => {
    const r = spawnSync('bash', ['-c', CHECK_BRIDGE_SCRIPT, 'b', '127.0.0.1:x=/tmp/s', 'true'], {
      encoding: 'utf8',
    });
    if (spawnSync('sh', ['-c', 'command -v socat']).status !== 0) return;
    expect(r.status).toBe(CHECK_BRIDGE_EXIT);
    expect(r.stderr).toContain('bad test service entry');
  });
});

describe.skipIf(!canListenUnix)('startServiceForwards', () => {
  it('pipes a connection to the declared service, records a failed upstream once, and closes idempotently', async () => {
    const { server, port } = await tcpServer();
    const closed = await tcpServer();
    const deadPort = closed.port;
    await new Promise<void>((r) => closed.server.close(() => r()));
    const dir = tmp('aom-svc-fw-');
    const fw = await startServiceForwards(dir, [
      { name: 'db', host: '127.0.0.1', port },
      { name: 'dead', host: 'localhost', port: deadPort },
      { name: 'proxy', host: '127.0.0.1', port: 3128 },
    ]);
    expect(fw.forwards.map((f) => f.port)).toEqual([port, deadPort]);
    expect(fw.spec).toBe(
      `127.0.0.1:${port}=/tmp/svc/${port}.sock,localhost:${deadPort}=/tmp/svc/${deadPort}.sock`,
    );
    const read = (sock: string) =>
      new Promise<string>((resolve) => {
        let out = '';
        const c = net.connect(sock);
        c.on('data', (b) => {
          out += b.toString();
        });
        c.on('close', () => resolve(out));
        c.on('error', () => resolve(out));
      });
    expect(await read(fw.forwards[0]?.socket as string)).toBe('hello\n');
    expect(fw.failures()).toEqual([]);
    await read(fw.forwards[1]?.socket as string);
    await read(fw.forwards[1]?.socket as string);
    expect(fw.failures()).toEqual([`localhost:${deadPort}`]);
    fw.close();
    fw.close();
    expect(existsSync(fw.forwards[0]?.socket as string)).toBe(false);
    server.close();
  });
});

const bwrapOk =
  spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-net', 'true'])
    .status === 0;
const socatOk = spawnSync('sh', ['-c', 'command -v socat']).status === 0;

describe.skipIf(!bwrapOk || !socatOk || !canListenUnix || process.platform !== 'linux')(
  'checkLaunch (real bwrap)',
  () => {
    const manager = (on: boolean) =>
      new RunManager({
        paths: runnerPaths(tmp()),
        findRepo: async () => undefined,
        send: () => {},
        log: { info() {}, warn() {}, error() {} },
        maxEnvironments: () => 1,
        portRange: () => ({ from: 43000, to: 43010 }),
        realHome: '/nonexistent-home',
        ...(on ? { sandboxMode: () => ({ mode: 'required' as const, allowUnsandboxed: false }) } : {}),
      });
    const probe = (port: number) =>
      `require('node:net').connect(${port}, '127.0.0.1').on('connect', () => { console.log('open ${port}'); process.exit(0); }).on('error', (e) => { console.log(e.code + ' ${port}'); process.exit(3); })`;

    it('reaches the declared service on its own port and nothing else; two runs at once bind the same port', async () => {
      const a = await tcpServer((c) => c.end());
      const b = await tcpServer((c) => c.end());
      const mgr = manager(true);
      const launch = (key: string, port: number) =>
        mgr.checkLaunch({
          key,
          worktree: tmp(),
          argv: [process.execPath, '-e', probe(port)],
          services: [{ name: 'db', host: '127.0.0.1', port: a.port }],
          runId: 'c0test',
        });
      const one = await launch('one', a.port);
      const two = await launch('two', a.port);
      const other = await launch('three', b.port);
      expect(one.network).toBe('none');
      expect(one.env.AOM_TEST_RUN_ID).toBe('c0test');
      const go = (l: Awaited<ReturnType<typeof launch>>) =>
        new Promise<{ code: number | null; out: string }>((resolve) => {
          const r = spawnSync(l.cmd, l.args, { env: l.env, encoding: 'utf8', timeout: 20_000 });
          resolve({ code: r.status, out: r.stdout });
        });
      const [r1, r2, r3] = await Promise.all([go(one), go(two), go(other)]);
      for (const l of [one, two, other]) l.forwards?.close();
      expect(r1).toMatchObject({ code: 0, out: expect.stringContaining(`open ${a.port}`) });
      expect(r2).toMatchObject({ code: 0, out: expect.stringContaining(`open ${a.port}`) });
      expect(r3.code).toBe(3);
      expect(r3.out).toMatch(/ECONNREFUSED/);
      a.server.close();
      b.server.close();
    }, 60_000);
  },
);

describe('checkLaunch without a namespace', () => {
  it('unsandboxed: no wrapper and no forwarders, the run id is still set; without services nothing changes', async () => {
    const mgr = new RunManager({
      paths: runnerPaths(tmp()),
      findRepo: async () => undefined,
      send: () => {},
      log: { info() {}, warn() {}, error() {} },
      maxEnvironments: () => 1,
      portRange: () => ({ from: 43000, to: 43010 }),
      realHome: '/nonexistent-home',
    });
    const wt = tmp();
    const l = await mgr.checkLaunch({
      key: 'k',
      worktree: wt,
      argv: ['node', 'x.js'],
      services: [{ name: 'db', host: '127.0.0.1', port: 5433 }],
      runId: 'c0abc',
    });
    expect(l.cmd).toBe('node');
    expect(l.args).toEqual(['x.js']);
    expect(l.forwards).toBeUndefined();
    expect(l.env.AOM_TEST_RUN_ID).toBe('c0abc');
    const plainLaunch = await mgr.checkLaunch({ key: 'k2', worktree: wt, argv: ['node', 'x.js'] });
    expect(plainLaunch.env.AOM_TEST_RUN_ID).toBeUndefined();
    expect([plainLaunch.cmd, ...plainLaunch.args]).toEqual(['node', 'x.js']);
  });
});

describe('doctor: handoff checks lines', () => {
  const seen = (decisions: TestServiceDecision[]) => ({ GWP: { at: '2026-11-16T10:00:00.000Z', decisions } });
  const sb = { state: 'enforced' as const, reason: 'bubblewrap + socat' };
  it('reachable now, not answering, non-Linux and socat missing', () => {
    const up = sandboxDoctorLines(sb, 'linux', seen([{ ...allowed, answering: true }]), { socat: true });
    expect(up.at(-1)).toEqual({
      ok: true,
      name: 'handoff checks',
      detail: 'GWP postgres-test 127.0.0.1:5433 reachable now (bridged into builder unit test runs)',
    });
    const down = handoffCheckDoctorLines(seen([{ ...allowed, answering: false }]), 'linux', false);
    expect(down.map((l) => l.detail)).toEqual([
      'GWP postgres-test 127.0.0.1:5433 not answering now: handoff unit runs that need it will report an environment problem',
      'socat not installed: handoff unit runs cannot reach the test services',
    ]);
    expect(down.every((l) => l.ok === 'warn')).toBe(true);
    expect(handoffCheckDoctorLines(seen([allowed]), 'darwin', true)[0]?.detail).toMatch(
      /not bridged: no network namespace/,
    );
  });
  it('no lines when nothing is declared, or without the live view (the lines above stay as they were)', () => {
    expect(handoffCheckDoctorLines({}, 'linux', false)).toEqual([]);
    expect(sandboxDoctorLines(sb, 'linux', seen([allowed])).some((l) => l.name === 'handoff checks')).toBe(
      false,
    );
  });
});
