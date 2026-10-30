import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import {
  buildChatSettings,
  buildCeoSettings,
  buildMentionWorkSettings,
  buildShiftSettings,
  REGISTRY_DOMAINS,
  sandboxDoctorLines,
  scanSandboxBlock,
  testServiceDoctorLines,
} from '../src/adapters/claude-policy.ts';
import {
  decideTestServices,
  refusedProgress,
  type TestServiceInput,
  testServiceDomains,
  testServicesNote,
  testServicesSpec,
  versionAtLeast,
} from '../src/sandbox/test-services.ts';
import { writeShims } from '../src/shims.ts';
import { cleanupTmp, tmp } from './helpers.ts';
import { POLICY_PATHS, policyCtx } from './policy-fixtures.ts';

cleanupTmp();

const PG = { name: 'postgres-test', host: '127.0.0.1', port: 5433 };
const role = (key: string) => {
  const r = BUILTIN_ROLES.find((x) => x.key === key);
  if (!r) throw new Error(key);
  return r;
};
const input = (over: Partial<TestServiceInput> = {}): TestServiceInput => ({
  services: [PG],
  kind: 'card',
  roleKey: 'builder',
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
const reason = (d: ReturnType<typeof decideTestServices>[number] | undefined) =>
  d && d.state === 'refused' ? d.reason : undefined;

describe('decideTestServices', () => {
  it('allows a declared service for a builder, reviewer and tester card shift', () => {
    for (const roleKey of ['builder', 'reviewer', 'tester'])
      expect(decideTestServices(input({ roleKey }))).toEqual([{ ...PG, state: 'allowed' }]);
  });

  it('adds nothing for other roles, kinds, DevOps or an empty list', () => {
    for (const roleKey of ['ba', 'ceo', 'mention', 'architect', 'planner', 'devops'])
      expect(decideTestServices(input({ roleKey }))).toEqual([]);
    expect(decideTestServices(input({ kind: 'devops' }))).toEqual([]);
    expect(decideTestServices(input({ kind: 'ba_task' }))).toEqual([]);
    expect(decideTestServices(input({ isDevops: true }))).toEqual([]);
    expect(decideTestServices(input({ services: [] }))).toEqual([]);
    expect(decideTestServices(input({ services: undefined }))).toEqual([]);
  });

  it('refuses without opening anything where the sandbox cannot enforce one port', () => {
    expect(reason(decideTestServices(input({ platform: 'darwin' }))[0])).toMatch(/cannot open a single loopback port/);
    expect(reason(decideTestServices(input({ sandbox: 'unsandboxed' }))[0])).toMatch(/nothing was opened/);
    expect(reason(decideTestServices(input({ sandbox: 'unavailable' }))[0])).toMatch(/nothing was opened/);
    expect(reason(decideTestServices(input({ runtime: 'codex' }))[0])).toMatch(/codex runtime/);
    expect(reason(decideTestServices(input({ hasShell: false }))[0])).toMatch(/no shell/);
    expect(reason(decideTestServices(input({ claudeVersion: '2.1.228' }))[0])).toMatch(/cannot limit the sandbox to one port/);
    expect(reason(decideTestServices(input({ claudeVersion: undefined }))[0])).toMatch(/unknown version/);
  });

  it('never opens the runner\'s own ports, the environment ports or the proxy ports', () => {
    const d = decideTestServices(
      input({
        services: [
          { name: 'a', host: '127.0.0.1', port: 43210 },
          { name: 'b', host: 'localhost', port: 4000 },
          { name: 'c', host: '127.0.0.1', port: 3128 },
          PG,
        ],
        runnerPorts: new Set([43210]),
        envForwardPorts: new Set([4000]),
      }),
    );
    expect(reason(d[0])).toMatch(/belongs to the runner/);
    expect(reason(d[1])).toMatch(/already forwarded to the test environment/);
    expect(reason(d[2])).toMatch(/sandbox proxy/);
    expect(d[3]?.state).toBe('allowed');
    expect(testServiceDomains(d)).toEqual(['127.0.0.1:5433']);
  });

  it('refuses a host that is not loopback and a bad port even if the server sent it', () => {
    const d = decideTestServices(
      input({
        services: [
          { name: 'a', host: '10.0.0.5', port: 5433 },
          { name: 'b', host: '127.0.0.2', port: 5434 },
          { name: 'c', host: '127.0.0.1', port: 0 },
          { name: 'd', host: '127.0.0.1', port: 70000 },
        ],
      }),
    );
    expect(d.every((x) => x.state === 'refused')).toBe(true);
    expect(testServiceDomains(d)).toEqual([]);
    expect(testServicesSpec(d)).toBe('');
  });

  it('versionAtLeast compares numerically', () => {
    expect(versionAtLeast('2.1.229', '2.1.229')).toBe(true);
    expect(versionAtLeast('2.1.1000', '2.1.229')).toBe(true);
    expect(versionAtLeast('2.2.0 (Claude Code)', '2.1.229')).toBe(true);
    expect(versionAtLeast('2.1.99', '2.1.229')).toBe(false);
    expect(versionAtLeast('unknown', '2.1.229')).toBe(false);
    expect(versionAtLeast(undefined, '2.1.229')).toBe(false);
  });
});

describe('domains, spec and note', () => {
  const mixed = decideTestServices(
    input({
      services: [PG, { name: 'v6', host: '::1', port: 6379 }, { name: 'bus', host: 'localhost', port: 4000 }],
      runnerPorts: new Set([4000]),
    }),
  );
  it('builds exact port-qualified entries (IPv6 bracketed), allowed services only', () => {
    expect(testServiceDomains(mixed)).toEqual(['127.0.0.1:5433', '[::1]:6379']);
    expect(testServicesSpec(mixed)).toBe('127.0.0.1:5433,[::1]:6379');
  });

  it('tells the agent what it may reach, how, and what it may not', () => {
    const note = testServicesNote(mixed);
    expect(note).toContain('## Local test services');
    expect(note).toContain('- postgres-test: 127.0.0.1:5433');
    expect(note).toContain('aom-env --timeout');
    expect(note).toContain('Not reachable in this shift: bus (localhost:4000)');
    expect(note).not.toMatch(/postgres:\/\//);
  });

  it('says so when every service is refused, and writes nothing when none was declared', () => {
    const none = decideTestServices(input({ platform: 'darwin' }));
    expect(testServicesNote(none)).toContain('No local test service is reachable in this shift.');
    expect(refusedProgress(none[0] as Extract<(typeof none)[number], { state: 'refused' }>)).toMatch(
      /^Local test service postgres-test \(127\.0\.0\.1:5433\) not opened: /,
    );
    expect(testServicesNote([])).toBe('');
  });
});

describe('sandbox settings', () => {
  const paths = POLICY_PATHS;
  const settings = (roleKey: string, over = {}) =>
    buildShiftSettings(role(roleKey).permissions, policyCtx(over), paths, roleKey);
  const domains = (s: ReturnType<typeof settings>) => s.sandbox?.network.allowedDomains;

  it('a build, review and test shift gets exactly the declared host:port pairs on top of today\'s list', () => {
    for (const roleKey of ['builder', 'reviewer', 'tester']) {
      const d = domains(settings(roleKey, { testServiceDomains: ['127.0.0.1:5433', '[::1]:6379'] }));
      expect(d).toEqual([...REGISTRY_DOMAINS, '127.0.0.1:5433', '[::1]:6379']);
      expect(d).not.toContain('127.0.0.1');
      expect(d).not.toContain('localhost');
    }
  });

  it('changes nothing else in the settings', () => {
    const base = settings('builder');
    const withSvc = settings('builder', { testServiceDomains: ['127.0.0.1:5433'] });
    expect({ ...withSvc.sandbox?.network, allowedDomains: [] }).toEqual({ ...base.sandbox?.network, allowedDomains: [] });
    expect({ ...withSvc, sandbox: { ...withSvc.sandbox, network: undefined } }).toEqual({
      ...base,
      sandbox: { ...base.sandbox, network: undefined },
    });
  });

  it('an empty or absent list gives byte-identical settings for every shell role', () => {
    for (const roleKey of ['builder', 'reviewer', 'tester', 'ba', 'architect', 'planner']) {
      const plain = JSON.stringify(settings(roleKey));
      expect(JSON.stringify(settings(roleKey, { testServiceDomains: [] }))).toBe(plain);
      expect(JSON.stringify(settings(roleKey, { testServiceDomains: undefined }))).toBe(plain);
    }
  });

  it('other roles ignore the list even if a context carries it', () => {
    const carry = { testServiceDomains: ['127.0.0.1:5433'] };
    for (const roleKey of ['ba', 'architect', 'planner', 'pre_reviewer', 'writer', 'researcher'])
      expect(JSON.stringify(settings(roleKey, carry))).toBe(JSON.stringify(settings(roleKey)));
    // a mention, DevOps and CEO shift
    expect(
      JSON.stringify(buildShiftSettings(role('builder').permissions, policyCtx(carry), paths, 'mention')),
    ).toBe(JSON.stringify(buildShiftSettings(role('builder').permissions, policyCtx(), paths, 'mention')));
    expect(
      JSON.stringify(buildMentionWorkSettings(role('builder').permissions, policyCtx(carry), paths)),
    ).toBe(JSON.stringify(buildMentionWorkSettings(role('builder').permissions, policyCtx(), paths)));
    expect(
      JSON.stringify(buildShiftSettings(role('devops').permissions, policyCtx(carry), paths, 'devops', true)),
    ).toBe(JSON.stringify(buildShiftSettings(role('devops').permissions, policyCtx(), paths, 'devops', true)));
    expect(JSON.stringify(buildShiftSettings(role('ceo').permissions, policyCtx(carry), paths, 'ceo'))).toBe(
      JSON.stringify(buildShiftSettings(role('ceo').permissions, policyCtx(), paths, 'ceo')),
    );
  });

  it('chat, CEO and scan sandboxes never take the list', () => {
    const carry = policyCtx({ testServiceDomains: ['127.0.0.1:5433'] });
    const plain = policyCtx();
    expect(JSON.stringify(buildChatSettings(false, [], carry, paths))).toBe(
      JSON.stringify(buildChatSettings(false, [], plain, paths)),
    );
    expect(JSON.stringify(buildCeoSettings(carry, paths))).toBe(JSON.stringify(buildCeoSettings(plain, paths)));
    expect(JSON.stringify(scanSandboxBlock(carry, paths))).toBe(JSON.stringify(scanSandboxBlock(plain, paths)));
    for (const s of [buildChatSettings(false, [], carry, paths), buildCeoSettings(carry, paths)])
      expect(JSON.stringify(s)).not.toContain('5433');
  });

  it('a shift of another project (no list) is unchanged by a neighbour that declared one', () => {
    settings('builder', { testServiceDomains: ['127.0.0.1:5433'] });
    expect(domains(settings('builder'))).toEqual([...REGISTRY_DOMAINS]);
  });
});

describe('doctor lines', () => {
  const seen = (decisions: ReturnType<typeof decideTestServices>) => ({ GWP: { at: '2026-10-30T10:00:00.000Z', decisions } });
  it('lists the allowed and refused services per project', () => {
    const lines = sandboxDoctorLines(
      { state: 'enforced', reason: 'bubblewrap + socat' },
      'linux',
      seen(
        decideTestServices(
          input({
            services: [PG, { name: 'redis', host: '127.0.0.1', port: 43548 }],
            runnerPorts: new Set([43548]),
          }),
        ),
      ),
    );
    expect(lines.map((l) => l.detail)).toContain(
      'GWP postgres-test 127.0.0.1:5433 (build, review and test shifts; as of 2026-10-30T10:00:00.000Z)',
    );
    const warn = lines.find((l) => l.ok === 'warn');
    expect(warn?.detail).toMatch(/^GWP redis 127\.0\.0\.1:43548 not opened: port 43548 belongs to the runner/);
  });

  it('says none declared when nothing is recorded, and leaves the sandbox line as it was', () => {
    const sb = { state: 'enforced' as const, reason: 'bubblewrap + socat' };
    expect(testServiceDoctorLines(undefined)[0]?.detail).toMatch(/none declared/);
    expect(sandboxDoctorLines(sb, 'linux', {})).toHaveLength(2);
    expect(sandboxDoctorLines(sb, 'linux')).toHaveLength(1);
    expect(sandboxDoctorLines(sb, 'linux')[0]).toEqual({ ok: true, name: 'sandbox', detail: 'enforced (bubblewrap + socat)' });
  });
});

describe('aom-env test services', () => {
  const hasSocat = spawnSync('socat', ['-V']).status === 0;
  const freePort = () =>
    new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
  const aomEnv = (dir: string, args: string[], env: Record<string, string>) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const c = spawn('bash', [join(dir, 'aom-env'), ...args], { env: { PATH: process.env.PATH ?? '', ...env } });
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
  const NODE_PROBE = (port: number) =>
    `const s=require('net').connect(${port},'127.0.0.1');s.on('data',d=>{process.stdout.write(String(d));s.end()});s.on('error',e=>{console.log('ERR '+e.code);process.exit(1)})`;

  it('tunnels the declared port through the sandbox proxy with its credential, and prints no credential', async () => {
    if (!hasSocat) return; // socat is a sandbox prerequisite; skip where it is absent
    const dir = tmp();
    await writeShims(dir);
    const service = net.createServer((c) => c.end('pg-hello'));
    await new Promise<void>((r) => service.listen(0, '127.0.0.1', r));
    const servicePort = (service.address() as net.AddressInfo).port;
    const declared = await freePort(); // not listening: aom-env must put the listener there
    const connects: { target: string; auth: string | undefined }[] = [];
    const proxy = http.createServer();
    proxy.on('connect', (req, sock) => {
      connects.push({ target: req.url ?? '', auth: req.headers['proxy-authorization'] });
      const up = net.connect(servicePort, '127.0.0.1', () => {
        sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        up.pipe(sock);
        sock.pipe(up);
      });
      up.on('error', () => sock.destroy());
      sock.on('error', () => up.destroy());
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    const proxyPort = (proxy.address() as net.AddressInfo).port;
    try {
      const r = await aomEnv(dir, ['--timeout', '1', '--', process.execPath, '-e', NODE_PROBE(declared)], {
        AOM_TEST_SERVICES: `127.0.0.1:${declared}`,
        HTTPS_PROXY: `http://srt.user:s3cret@127.0.0.1:${proxyPort}`,
      });
      expect(r.stdout).toBe('pg-hello');
      expect(connects).toHaveLength(1);
      expect(connects[0]?.target).toBe(`127.0.0.1:${declared}`);
      expect(Buffer.from((connects[0]?.auth ?? '').replace('Basic ', ''), 'base64').toString()).toBe('srt.user:s3cret');
      expect(r.stdout + r.stderr).not.toContain('s3cret');
    } finally {
      proxy.close();
      service.close();
    }
  });

  it('opens nothing and runs the command when there is no usable proxy', async () => {
    if (!hasSocat) return;
    const dir = tmp();
    await writeShims(dir);
    const declared = await freePort();
    for (const env of [{}, { HTTPS_PROXY: 'socks5://x:y@127.0.0.1:1080' }, { HTTPS_PROXY: 'garbage' }]) {
      const r = await aomEnv(dir, ['--timeout', '1', '--', process.execPath, '-e', NODE_PROBE(declared)], {
        AOM_TEST_SERVICES: `127.0.0.1:${declared}`,
        ...env,
      });
      expect(r.stderr).toContain('no sandbox proxy, test services not reachable');
      expect(r.stdout).toContain('ERR ECONNREFUSED');
    }
  });

  it('ignores a malformed or non-loopback entry', async () => {
    if (!hasSocat) return;
    const dir = tmp();
    await writeShims(dir);
    const r = await aomEnv(dir, ['--timeout', '1', '--', 'true'], {
      AOM_TEST_SERVICES: '10.0.0.5:5433,127.0.0.1:abc',
      HTTPS_PROXY: 'http://u:p@127.0.0.1:9',
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("ignoring test service '10.0.0.5:5433'");
    expect(r.stderr).toContain("ignoring test service '127.0.0.1:abc'");
  });
});
