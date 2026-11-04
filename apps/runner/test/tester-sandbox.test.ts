import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { BUILTIN_ROLES, type LocalTestService } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildShiftSettings,
  REGISTRY_DOMAINS,
  testServiceDoctorLines,
} from '../src/adapters/claude-policy.ts';
import {
  decideTestServices,
  isTesterShift,
  noTestServicesNote,
  notAnsweringLine,
  probeLocalPort,
  refusedProgress,
  TEST_SERVICES_SETTING,
  type TestServiceDecision,
  type TestServiceInput,
  testerScratchNote,
  testerShiftEnv,
  testServiceDomains,
  testServicesNote,
  testServicesSpec,
  withReachability,
} from '../src/sandbox/test-services.ts';
import { AOM_BRIDGES_FILE, AOM_BRIDGES_SCRIPT, writeShims } from '../src/shims.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, tmp } from './helpers.ts';
import { POLICY_PATHS, policyCtx } from './policy-fixtures.ts';
import { ScriptedAdapter } from './scripted-adapter.ts';

cleanupTmp();

const HOSTED: LocalTestService = { name: 'hosted-build', host: '127.0.0.1', port: 4710 };
const PG: LocalTestService = { name: 'postgres-test', host: '127.0.0.1', port: 5433 };
const role = (key: string) => {
  const r = BUILTIN_ROLES.find((x) => x.key === key);
  if (!r) throw new Error(key);
  return r;
};
const input = (over: Partial<TestServiceInput> = {}): TestServiceInput => ({
  services: [HOSTED, PG],
  kind: 'card',
  roleKey: 'tester',
  isDevops: false,
  runtime: 'claude-code',
  hasShell: true,
  platform: 'linux',
  sandbox: 'enforced',
  claudeVersion: '2.1.314',
  runnerPorts: new Set(),
  envForwardPorts: new Set(),
  ...over,
});
type Refused = Extract<TestServiceDecision, { state: 'refused' }>;

describe('tester shift: test-services setting -> opened ports', () => {
  it('opens exactly the declared ports [4710, 5433] in the tester policy; another port is not in it', () => {
    const d = decideTestServices(input());
    expect(d.map((x) => x.state)).toEqual(['allowed', 'allowed']);
    expect(testServicesSpec(d)).toBe('127.0.0.1:4710,127.0.0.1:5433');
    const s = buildShiftSettings(
      role('tester').permissions,
      policyCtx({ testServiceDomains: testServiceDomains(d) }),
      POLICY_PATHS,
      'tester',
    );
    const domains = s.sandbox?.network.allowedDomains ?? [];
    expect(domains).toEqual([...REGISTRY_DOMAINS, '127.0.0.1:4710', '127.0.0.1:5433']);
    expect(domains.some((x) => x.startsWith('127.0.0.1') && !/^127\.0\.0\.1:(4710|5433)$/.test(x))).toBe(
      false,
    );
    expect(domains).not.toContain('127.0.0.1:5999');
  });

  it('the tester policy still binds local ports and opens Unix sockets (suite server, browser, mock runner IPC)', () => {
    const s = buildShiftSettings(role('tester').permissions, policyCtx(), POLICY_PATHS, 'tester');
    expect(s.sandbox?.network.allowLocalBinding).toBe(true);
    expect(s.sandbox?.network.allowAllUnixSockets).toBe(true);
  });
});

describe('tester shift env (BASH_ENV, E2E scratch, nested runner tmp root)', () => {
  it('a tester with opened services gets the bridges as BASH_ENV and the scratch under its TMPDIR', () => {
    const env = testerShiftEnv({
      isTester: true,
      autoBridged: true,
      tmp: '/tmp/aom-0123456789',
      binDir: '/r/bin',
    });
    expect(env).toEqual({
      BASH_ENV: join('/r/bin', AOM_BRIDGES_FILE),
      SHLVL: '1',
      AOM_E2E_DIR: '/tmp/aom-0123456789/e2e',
      AOM_AGENT_TMP_ROOT: '/tmp/aom-0123456789/e2e/agent-tmp',
      PLAYWRIGHT_HTML_OUTPUT_DIR: '/tmp/aom-0123456789/e2e/playwright-report',
    });
  });

  it('no BASH_ENV without an opened service; nothing at all for any other shift', () => {
    const env = testerShiftEnv({ isTester: true, autoBridged: false, tmp: '/t/aom-x', binDir: '/r/bin' });
    expect(env.BASH_ENV).toBeUndefined();
    expect(env.AOM_E2E_DIR).toBe('/t/aom-x/e2e');
    expect(testerShiftEnv({ isTester: false, autoBridged: true, tmp: '/t/aom-x', binDir: '/r/bin' })).toEqual(
      {},
    );
  });

  it('only a tester card shift is a tester shift', () => {
    expect(isTesterShift('card', 'tester', false)).toBe(true);
    expect(isTesterShift('card', 'tester', true)).toBe(false);
    expect(isTesterShift('devops', 'tester', false)).toBe(false);
    for (const r of ['builder', 'reviewer', 'ba', 'ceo', 'devops'])
      expect(isTesterShift('card', r, false)).toBe(false);
  });
});

describe('messages name the port and the setting', () => {
  it('refused progress and the note point to Project settings > Local test services', () => {
    const d = decideTestServices(input({ runnerPorts: new Set([4710]) }));
    const refused = d[0] as Refused;
    expect(refusedProgress(refused)).toBe(
      `Local test service hosted-build (127.0.0.1:4710) not opened: port 4710 belongs to the runner (its local HTTP port or a run environment). The project Owner changes this in ${TEST_SERVICES_SETTING}.`,
    );
    expect(testServicesNote(d)).toContain(`hosted-build (127.0.0.1:4710)`);
    expect(testServicesNote(d)).toContain(`The project Owner changes this in ${TEST_SERVICES_SETTING}.`);
    expect(TEST_SERVICES_SETTING).toBe('Project settings > Local test services');
  });

  it('a tester note says plain commands reach the services and every other port is closed', () => {
    const note = testServicesNote(decideTestServices(input()), { autoBridged: true });
    expect(note).toContain('- hosted-build: 127.0.0.1:4710');
    expect(note).toContain('Every Bash command of this shift reaches them directly');
    expect(note).toContain('Any other local port is closed in this shift');
    expect(note).toContain('you cannot open it yourself');
    // a builder's note keeps the aom-env instruction and gets no tester line
    const builder = testServicesNote(decideTestServices(input({ roleKey: 'builder' })));
    expect(builder).toContain('run every command that needs them through aom-env');
    expect(builder).not.toContain('Any other local port is closed');
  });

  it('a tester of a project that declared nothing is told where the Owner declares one', () => {
    const note = noTestServicesNote();
    expect(note).toContain(TEST_SERVICES_SETTING);
    expect(note).toContain('same Bash call');
  });

  it('the scratch note names the dir, --output and that Docker specs go to DevOps', () => {
    const note = testerScratchNote('/tmp/aom-0123456789/e2e');
    expect(note).toContain('/tmp/aom-0123456789/e2e');
    expect(note).toContain('--output "$AOM_E2E_DIR/test-results"');
    expect(note).toContain('removed when the shift ends');
    expect(note).toMatch(/Docker is not available in this sandbox.*aom devops/);
  });

  it('a declared service that does not answer is named with its port, the setting and DevOps', async () => {
    const d = await withReachability(decideTestServices(input()), async (_h, port) => port === 5433);
    expect(d.map((x) => (x.state === 'allowed' ? x.answering : null))).toEqual([false, true]);
    const line = notAnsweringLine(HOSTED);
    expect(line).toContain('hosted-build (127.0.0.1:4710)');
    expect(line).toContain(TEST_SERVICES_SETTING);
    expect(line).toContain('aom devops');
    expect(testServicesNote(d, { autoBridged: true })).toContain(line);
    expect(testServicesNote(d, { autoBridged: true })).not.toContain(notAnsweringLine(PG));
    const doctor = testServiceDoctorLines({ GWP: { at: 'T', decisions: d } });
    expect(doctor[0]).toEqual({
      ok: 'warn',
      name: 'test service',
      detail: 'GWP hosted-build 127.0.0.1:4710 opened but not answering on this workstation (as of T)',
    });
    expect(doctor[1]?.ok).toBe(true);
  });

  it('a refused doctor line points to the setting', () => {
    const d = decideTestServices(input({ runnerPorts: new Set([4710]) }));
    expect(testServiceDoctorLines({ GWP: { at: 'T', decisions: d } })[0]?.detail).toContain(
      `(change it in ${TEST_SERVICES_SETTING})`,
    );
  });

  it('withReachability leaves refused services alone and treats a failing probe as not answering', async () => {
    const d = decideTestServices(input({ runnerPorts: new Set([4710]) }));
    const out = await withReachability(d, async () => {
      throw new Error('boom');
    });
    expect(out[0]).toEqual(d[0]);
    expect(out[1]).toEqual({ ...PG, state: 'allowed', answering: false });
  });

  it('probeLocalPort connects to a listening port and reports a closed one', async () => {
    const srv = net.createServer((c) => c.end());
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as net.AddressInfo).port;
    try {
      expect(await probeLocalPort('127.0.0.1', port)).toBe(true);
    } finally {
      await new Promise((r) => srv.close(r));
    }
    expect(await probeLocalPort('127.0.0.1', port, 500)).toBe(false);
  });
});

describe('bin/aom-bridges.sh (BASH_ENV): every bash reaches the declared ports without aom-env', () => {
  const hasSocat = spawnSync('socat', ['-V']).status === 0;
  const freePort = () =>
    new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
  const NODE_PROBE = (port: number) =>
    `const s=require('net').connect(${port},'127.0.0.1');s.on('data',d=>{process.stdout.write(String(d));s.end()});s.on('error',e=>{console.log('ERR '+e.code);process.exit(1)})`;
  const bash = (script: string, env: Record<string, string>) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const c = spawn('bash', ['-c', script], { env: { PATH: process.env.PATH ?? '', SHLVL: '1', ...env } });
      let stdout = '';
      let stderr = '';
      c.stdout.on('data', (d) => {
        stdout += d;
      });
      c.stderr.on('data', (d) => {
        stderr += d;
      });
      c.on('close', (status) => resolve({ status, stdout, stderr }));
    });
  /** A fake sandbox proxy that only lets `allowed` through (the real one enforces the settings' exact host:port list). */
  const startProxy = async (allowed: string, servicePort: number) => {
    const connects: string[] = [];
    const proxy = http.createServer();
    proxy.on('connect', (req, sock) => {
      connects.push(req.url ?? '');
      if (req.url !== allowed) {
        sock.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      const up = net.connect(servicePort, '127.0.0.1', () => {
        sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        up.pipe(sock);
        sock.pipe(up);
      });
      up.on('error', () => sock.destroy());
      sock.on('error', () => up.destroy());
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    return { proxy, connects, port: (proxy.address() as net.AddressInfo).port };
  };
  const closers: Array<() => void> = [];
  afterEach(() => {
    for (const c of closers.splice(0)) c();
  });

  it('writeShims writes the sourced file, not executable', async () => {
    const dir = tmp();
    await writeShims(dir);
    const { readFileSync, statSync } = await import('node:fs');
    expect(readFileSync(join(dir, AOM_BRIDGES_FILE), 'utf8')).toBe(AOM_BRIDGES_SCRIPT);
    expect(statSync(join(dir, AOM_BRIDGES_FILE)).mode & 0o777).toBe(0o644);
    expect(spawnSync('bash', ['-n', join(dir, AOM_BRIDGES_FILE)]).status).toBe(0);
  });

  it('the tester env makes bash read BASH_ENV even when Node starts it with a socket for stdin', async () => {
    const dir = tmp();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, AOM_BRIDGES_FILE), 'echo SOURCED\n');
    const env = testerShiftEnv({ isTester: true, autoBridged: true, tmp: dir, binDir: dir });
    const run = (e: Record<string, string>) =>
      String(spawnSync('bash', ['-c', 'echo cmd'], { env: { PATH: process.env.PATH ?? '', ...e } }).stdout);
    expect(run(env)).toBe('SOURCED\ncmd\n');
    // without SHLVL bash takes its rshd path and skips BASH_ENV: why the tester env sets it
    if (process.platform === 'linux') expect(run({ BASH_ENV: env.BASH_ENV as string })).toBe('cmd\n');
  });

  it('a plain command reaches the declared port, prints nothing extra and leaves no listener behind', async () => {
    if (!hasSocat) return; // socat is a sandbox prerequisite; skip where it is absent
    const dir = tmp();
    await writeShims(dir);
    const service = net.createServer((c) => c.end('pg-hello'));
    await new Promise<void>((r) => service.listen(0, '127.0.0.1', r));
    closers.push(() => service.close());
    const declared = await freePort();
    const { proxy, connects, port } = await startProxy(
      `127.0.0.1:${declared}`,
      (service.address() as net.AddressInfo).port,
    );
    closers.push(() => proxy.close());
    const env = {
      BASH_ENV: join(dir, AOM_BRIDGES_FILE),
      AOM_TEST_SERVICES: `127.0.0.1:${declared}`,
      HTTPS_PROXY: `http://srt.user:s3cret@127.0.0.1:${port}`,
    };
    const r = await bash(
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify(NODE_PROBE(declared))}`,
      env,
    );
    expect(r.stdout).toBe('pg-hello');
    expect(r.stderr).toBe('');
    expect(connects).toEqual([`127.0.0.1:${declared}`]);
    // the bridge died with the shell: nothing listens on the declared port any more
    let closed = false;
    for (let i = 0; i < 30 && !closed; i++) {
      closed = !(await probeLocalPort('127.0.0.1', declared, 200));
      if (!closed) await new Promise((res) => setTimeout(res, 100));
    }
    expect(closed).toBe(true);
    // the shell's own variables are not polluted
    const vars = await bash('echo "${_aom_quiet-unset} ${_aom_pids-unset}"', env);
    expect(vars.stdout.trim()).toBe('unset unset');
  });

  it('aom-env inside an auto-bridged call still works (no second listener, no failure)', async () => {
    if (!hasSocat) return;
    const dir = tmp();
    await writeShims(dir);
    const service = net.createServer((c) => c.end('pg-hello'));
    await new Promise<void>((r) => service.listen(0, '127.0.0.1', r));
    closers.push(() => service.close());
    const declared = await freePort();
    const { proxy, port } = await startProxy(
      `127.0.0.1:${declared}`,
      (service.address() as net.AddressInfo).port,
    );
    closers.push(() => proxy.close());
    const r = await bash(
      `${JSON.stringify(join(dir, 'aom-env'))} --timeout 1 -- ${JSON.stringify(process.execPath)} -e ${JSON.stringify(NODE_PROBE(declared))}`,
      {
        BASH_ENV: join(dir, AOM_BRIDGES_FILE),
        AOM_TEST_SERVICES: `127.0.0.1:${declared}`,
        HTTPS_PROXY: `http://u:p@127.0.0.1:${port}`,
      },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('pg-hello');
  });

  it('an undeclared port stays closed, also when the agent edits AOM_TEST_SERVICES (the proxy refuses it)', async () => {
    if (!hasSocat) return;
    const dir = tmp();
    await writeShims(dir);
    const service = net.createServer((c) => c.end('secret-service'));
    await new Promise<void>((r) => service.listen(0, '127.0.0.1', r));
    closers.push(() => service.close());
    const declared = await freePort();
    const undeclared = await freePort();
    const { proxy, connects, port } = await startProxy(
      `127.0.0.1:${declared}`,
      (service.address() as net.AddressInfo).port,
    );
    closers.push(() => proxy.close());
    const env = {
      BASH_ENV: join(dir, AOM_BRIDGES_FILE),
      HTTPS_PROXY: `http://u:p@127.0.0.1:${port}`,
    };
    // not in the list: nothing listens
    const plain = await bash(
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify(NODE_PROBE(undeclared))}`,
      {
        ...env,
        AOM_TEST_SERVICES: `127.0.0.1:${declared}`,
      },
    );
    expect(plain.stdout).toContain('ERR ECONNREFUSED');
    // put into the list by hand: a listener starts, but the proxy refuses the tunnel
    const widened = await bash(
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify(NODE_PROBE(undeclared))}`,
      {
        ...env,
        AOM_TEST_SERVICES: `127.0.0.1:${undeclared}`,
      },
    );
    expect(widened.stdout).not.toContain('secret-service');
    expect(connects).toContain(`127.0.0.1:${undeclared}`);
  });

  it('is silent and opens nothing without a usable proxy or without services', async () => {
    if (!hasSocat) return;
    const dir = tmp();
    await writeShims(dir);
    const declared = await freePort();
    for (const env of [
      { AOM_TEST_SERVICES: `127.0.0.1:${declared}` },
      { AOM_TEST_SERVICES: `127.0.0.1:${declared}`, HTTPS_PROXY: 'garbage' },
      { HTTPS_PROXY: 'http://u:p@127.0.0.1:9' },
    ] as Record<string, string>[]) {
      const r = await bash(
        `env -u HTTPS_PROXY ${JSON.stringify(process.execPath)} -e ${JSON.stringify(NODE_PROBE(declared))}`,
        { BASH_ENV: join(dir, AOM_BRIDGES_FILE), ...env },
      );
      expect(r.stderr).toBe('');
      expect(r.stdout).toContain('ERR ECONNREFUSED');
    }
  });
});

describe('supervisor: a tester shift', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.stop();
    h = undefined;
  });
  const shift = async (stage: 'test' | 'build', testServices?: LocalTestService[]) => {
    const adapter = new ScriptedAdapter(async (_i, ctl) => {
      await ctl.post('/v1/report', {
        report: {
          kind: 'outcome',
          outcomeId: stage === 'test' ? 'pass' : 'handoff',
          note: 'ok',
          data: stage === 'test' ? { summary: 'ok', commands: [], outputExcerpt: '' } : {},
        },
      });
    });
    h = await startHarness({}, { adapters: new Map([['mock', adapter]]), envChecker: async () => null });
    await h.runShift({ stage, mode: 'create', ...(testServices ? { startExtra: { testServices } } : {}) });
    return { env: adapter.inputs[0]?.env ?? {}, instructions: adapter.instructions[0] ?? '' };
  };

  it('gets the E2E scratch and nested runner tmp root inside its TMPDIR, with the dirs created', async () => {
    const { env, instructions } = await shift('test');
    const tmpDir = env.TMPDIR as string;
    expect(env.AOM_E2E_DIR).toBe(join(tmpDir, 'e2e'));
    expect(env.AOM_AGENT_TMP_ROOT).toBe(join(tmpDir, 'e2e', 'agent-tmp'));
    expect(env.PLAYWRIGHT_HTML_OUTPUT_DIR).toBe(join(tmpDir, 'e2e', 'playwright-report'));
    // no service was opened (none declared): no BASH_ENV
    expect(env.BASH_ENV).toBeUndefined();
    expect(instructions).toContain('## E2E scratch');
    expect(instructions).toContain(TEST_SERVICES_SETTING);
  });

  it('a refused declared service names the port and the setting (mock runtime: nothing opened, no BASH_ENV)', async () => {
    const { env, instructions } = await shift('test', [HOSTED]);
    expect(env.BASH_ENV).toBeUndefined();
    expect(env.AOM_TEST_SERVICES).toBeUndefined();
    expect(instructions).toContain('hosted-build (127.0.0.1:4710)');
    expect(instructions).toContain(`The project Owner changes this in ${TEST_SERVICES_SETTING}.`);
  });

  it('a build shift gets none of it', async () => {
    const { env, instructions } = await shift('build');
    for (const k of ['BASH_ENV', 'AOM_E2E_DIR', 'AOM_AGENT_TMP_ROOT', 'PLAYWRIGHT_HTML_OUTPUT_DIR'])
      expect(env[k]).toBeUndefined();
    expect(instructions).not.toContain('## E2E scratch');
    expect(instructions).not.toContain('## Local test services');
  });
});
