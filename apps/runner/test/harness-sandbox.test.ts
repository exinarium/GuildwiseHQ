import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer, connect as netConnect } from 'node:net';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import { afterAll, describe, expect, it } from 'vitest';
import { hostAllowed, isPrivateAddress, startEgressProxy } from '../src/sandbox/egress-proxy.ts';
import {
  type HarnessSandboxInput,
  proxyEnv,
  REAL_SHELL_IN_BOX,
  realShellPath,
  shellShimScript,
  wrapInHarnessSandbox,
} from '../src/sandbox/harness-sandbox.ts';

/**
 * Runs the harness sandbox with the REAL bubblewrap and socat on this machine (skipped without them): the filesystem, the
 * network, the process view and the shell shim are checked by running commands inside it.
 */
const have = (bin: string) => spawnSync(bin, ['--version'], { encoding: 'utf8' }).status === 0;
const ok = process.platform === 'linux' && have('bwrap') && spawnSync('socat', ['-V']).status === 0;
const probe = ok
  ? spawnSync('bwrap', [
      '--unshare-user',
      '--unshare-net',
      '--ro-bind',
      '/usr',
      '/usr',
      '--ro-bind',
      '/etc',
      '/etc',
      '--symlink',
      'usr/bin',
      '/bin',
      '--symlink',
      'usr/lib',
      '/lib',
      '--symlink',
      'usr/lib64',
      '/lib64',
      '--',
      '/usr/bin/true',
    ]).status === 0
  : false;

const root = realpathSync(mkdtempSync(join(userInfo().homedir, '.aom-harness-sbx-')));
const servers: Server[] = [];
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  for (const s of servers) s.close();
});

function upstream(): Promise<{
  port: number;
  seen: Array<{ url: string; headers: Record<string, unknown> }>;
}> {
  const seen: Array<{ url: string; headers: Record<string, unknown> }> = [];
  const s = createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    res.end(`UPSTREAM-OK ${req.url}`);
  });
  servers.push(s);
  return new Promise((r) =>
    s.listen(0, '127.0.0.1', () => r({ port: (s.address() as { port: number }).port, seen })),
  );
}

interface World {
  dir: string;
  input: HarnessSandboxInput;
  secretOutside: string;
  run: (script: string, env?: Record<string, string>) => Promise<{ out: string; code: number | undefined }>;
  proxy: Awaited<ReturnType<typeof startEgressProxy>>;
  up: Awaited<ReturnType<typeof upstream>>;
  sock: string;
}

async function world(
  name: string,
  over: Partial<HarnessSandboxInput> = {},
  proxyOpts: { allowed?: string[]; routes?: boolean } = {},
): Promise<World> {
  const dir = join(root, name);
  const agent = join(dir, 'agent');
  const dirs = {
    home: join(agent, 'home'),
    scratch: join(agent, 'scratch'),
    tmp: join(agent, 'tmp'),
    state: join(agent, 'state'),
  };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  const cwd = join(dir, 'wt');
  mkdirSync(cwd, { recursive: true });
  const outside = join(dir, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'TOPSECRET');
  const sockDir = join(dir, 'run');
  mkdirSync(sockDir);
  const sock = join(sockDir, 'proxy.sock');
  const up = await upstream();
  const proxy = await startEgressProxy({
    socketPath: sock,
    allowedHosts: proxyOpts.allowed ?? ['allowed.test'],
    allowPrivate: true,
    allowedPorts: [up.port, 80, 443],
    resolve: async () => '127.0.0.1',
    ...(proxyOpts.routes
      ? {
          routes: [
            {
              prefix: '/api',
              upstream: `http://allowed.test:${up.port}`,
              headers: { 'x-goog-api-key': 'REAL-KEY-NEVER-IN-SANDBOX' },
            },
          ],
        }
      : {}),
  });
  const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
  const input: HarnessSandboxInput = {
    cwd,
    readOnlyCwd: false,
    home: dirs.home,
    scratch: dirs.scratch,
    tmp: dirs.tmp,
    writable: [dirs.state],
    readonly: [nodeRoot],
    readDirs: [],
    gitDirs: [],
    mayCommit: false,
    proxySocket: sock,
    bridgePort: 3128,
    hiddenFromShell: [],
    ...over,
  };
  const run = async (script: string, env: Record<string, string> = {}) => {
    const w = wrapInHarnessSandbox(input, {
      bin: '/bin/sh',
      args: ['-c', script],
      env: { PATH: '/usr/bin:/bin', HOME: dirs.home, ...proxyEnv(3128), ...env },
    });
    // asynchronous: the proxy and the fake servers of these tests live in this process
    const r = await execa(w.bin, w.args, {
      cwd,
      env: w.env,
      extendEnv: false,
      reject: false,
      timeout: 30_000,
      all: true,
    });
    return { out: String(r.all ?? ''), code: r.exitCode };
  };
  return { dir, input, secretOutside: join(outside, 'secret.txt'), run, proxy, up, sock };
}

describe.skipIf(!ok || !probe)('the harness sandbox (real bubblewrap)', () => {
  it('shows only the allow-listed paths: no owner home, no runner data, no other agents', async () => {
    const w = await world('fs');
    const home = userInfo().homedir;
    const r = await w.run(
      `ls ${home} 2>&1 | head -5; cat ${w.secretOutside} 2>&1; echo ---; ls ${dirname(w.dir)} 2>&1 | head -3`,
    );
    expect(r.out).not.toContain('TOPSECRET');
    expect(r.out).not.toContain('.nvm');
    expect(r.out).toMatch(/No such file|cannot access/);
    await w.proxy.close();
  });

  it('writes in the working folder, scratch, home and tmp, and nowhere else', async () => {
    const w = await world('write');
    const r = await w.run(
      `echo a > wt-file && echo WT-OK; echo b > ${w.input.scratch}/s && echo SCRATCH-OK; echo c > ${w.input.tmp}/t && echo TMP-OK; echo d > ${w.input.home}/h && echo HOME-OK; echo e > /usr/x 2>&1 || echo USR-RO; echo f > ${w.dir}/outside/new 2>&1 || echo OUTSIDE-NO; echo g > /tmp/aom-sandbox-private-tmp-probe && echo PRIVATE-TMP`,
    );
    for (const s of ['WT-OK', 'SCRATCH-OK', 'TMP-OK', 'HOME-OK', 'USR-RO', 'OUTSIDE-NO', 'PRIVATE-TMP'])
      expect(r.out).toContain(s);
    expect(existsSync(join(w.input.cwd, 'wt-file'))).toBe(true);
    expect(existsSync(join(w.dir, 'outside', 'new'))).toBe(false);
    expect(existsSync('/tmp/aom-sandbox-private-tmp-probe')).toBe(false);
    await w.proxy.close();
  });

  it('keeps the working folder read-only for a role that cannot edit', async () => {
    const w = await world('ro', { readOnlyCwd: true });
    const r = await w.run('echo a > wt-file 2>&1 || echo RO; echo b > "$HOME/ok" && echo HOME-OK');
    expect(r.out).toContain('RO');
    expect(r.out).toContain('HOME-OK');
    expect(existsSync(join(w.input.cwd, 'wt-file'))).toBe(false);
    await w.proxy.close();
  });

  it('has no network of its own and reaches only allow-listed hosts through the proxy', async () => {
    const w = await world('net');
    const direct = await w.run(`curl -sS --noproxy '*' -m 3 http://127.0.0.1:${w.up.port}/ 2>&1; echo rc=$?`);
    expect(direct.out).not.toContain('UPSTREAM-OK');
    const viaProxy = await w.run(`curl -sS -m 10 http://allowed.test:${w.up.port}/hello 2>&1`);
    expect(viaProxy.out).toContain('UPSTREAM-OK /hello');
    const refused = await w.run(`curl -sS -m 10 http://evil.test:${w.up.port}/hello 2>&1; echo rc=$?`);
    expect(refused.out).not.toContain('UPSTREAM-OK');
    expect(w.proxy.denied()).toContain('evil.test');
    const connect = await w.run(
      `curl -sS -m 10 -p -x http://127.0.0.1:3128 https://evil.test/ 2>&1; echo rc=$?`,
    );
    expect(connect.out).toMatch(/403|Received HTTP code/);
    await w.proxy.close();
  });

  it('injects the API key at the proxy: the sandbox never has it, the upstream does', async () => {
    const w = await world('route', {}, { routes: true });
    const r = await w.run(
      `curl -sS -m 10 -H 'x-goog-api-key: sandbox-forged' http://127.0.0.1:3128/api/v1/models; echo; env | grep -c REAL-KEY`,
    );
    expect(r.out).toContain('UPSTREAM-OK /v1/models');
    expect(r.out).not.toContain('REAL-KEY-NEVER-IN-SANDBOX');
    const hit = w.up.seen.at(-1);
    expect(hit?.headers['x-goog-api-key']).toBe('REAL-KEY-NEVER-IN-SANDBOX');
    await w.proxy.close();
  });

  it('reaches the runner through its Unix socket (the aom command) and sees no other process', async () => {
    const w = await world('ipc');
    const ipcDir = join(w.dir, 'ipc');
    mkdirSync(ipcDir);
    const ipc = join(ipcDir, 'ipc.sock');
    const srv = createNetServer((c) => c.end('pong')).listen(ipc);
    w.input.ipcSocket = ipc;
    const r = await w.run(`echo ping | socat - UNIX-CONNECT:${ipc}; echo; ps -e 2>/dev/null | wc -l`);
    expect(r.out).toContain('pong');
    const n = Number(r.out.trim().split('\n').at(-1));
    expect(n).toBeLessThan(15);
    srv.close();
    await w.proxy.close();
  });

  it('masks secret files of a reference repository and opens the rest', async () => {
    const ref = join(root, 'ref');
    mkdirSync(join(ref, 'src'), { recursive: true });
    writeFileSync(join(ref, 'src', 'a.ts'), 'code');
    writeFileSync(join(ref, '.env'), 'DB_PASSWORD=hunter2');
    writeFileSync(join(ref, 'src', 'deploy.pem'), 'PEM');
    const w = await world('ref', { readDirs: [ref] });
    const r = await w.run(
      `cat ${ref}/src/a.ts; echo; cat ${ref}/.env; cat ${ref}/src/deploy.pem; echo x > ${ref}/new 2>&1 || echo RO`,
    );
    expect(r.out).toContain('code');
    expect(r.out).not.toContain('hunter2');
    expect(r.out).not.toContain('PEM');
    expect(r.out).toContain('RO');
    await w.proxy.close();
  });

  it('hides the CLI’s login from the commands it starts, through the shell shim', async () => {
    const dir0 = join(root, 'shim');
    const shim = join(dir0, 'shimbin');
    mkdirSync(shim, { recursive: true });
    const w = await world('shim', { shimDir: shim, hiddenFromShell: [] });
    const login = join(w.input.writable[0] as string, '.gemini', 'oauth_creds.json');
    mkdirSync(dirname(login), { recursive: true });
    writeFileSync(login, 'REFRESH-TOKEN-XYZ');
    w.input.hiddenFromShell = [login];
    for (const name of ['bash', 'sh']) {
      writeFileSync(join(shim, name), shellShimScript(realShellPath(), [login], ['GEMINI_API_KEY']));
      chmodSync(join(shim, name), 0o755);
    }
    // the CLI itself (here: sh -c run directly) can read it; a command started through the shim cannot
    const r = await w.run(
      `cat ${login}; echo; bash -c 'cat ${login} 2>&1; echo KEY=$GEMINI_API_KEY; echo W > ${w.input.cwd}/shim-wrote && echo SHELL-WRITES'`,
      { GEMINI_API_KEY: 'sk-gem-1' },
    );
    expect(r.out).toContain('REFRESH-TOKEN-XYZ');
    const afterShim = r.out.split('\n').slice(1).join('\n');
    expect(afterShim).not.toContain('REFRESH-TOKEN-XYZ');
    expect(afterShim).toContain('KEY=\n');
    expect(afterShim).toContain('SHELL-WRITES');
    await w.proxy.close();
  });

  it('R3c: replaces the box’s own bash for a CLI that starts its shell by absolute path (Codex), without hiding the real one from the launcher', async () => {
    const dir0 = join(root, 'override');
    const shim = join(dir0, 'shimbin');
    mkdirSync(shim, { recursive: true });
    const shimFile = join(shim, 'bash');
    const w = await world('override', {
      shimDir: shim,
      shellOverride: { shim: shimFile, real: realShellPath() },
      hiddenFromShell: [],
    });
    const login = join(w.input.writable[0] as string, 'auth.json');
    writeFileSync(login, 'CODEX-LOGIN-XYZ');
    writeFileSync(
      shimFile,
      shellShimScript(REAL_SHELL_IN_BOX, [login], ['CODEX_HOME'], 'bwrap', REAL_SHELL_IN_BOX),
    );
    chmodSync(shimFile, 0o755);
    // the launcher runs the real shell (so it still sees the login and its environment); `/bin/bash -c ...` is the masked one
    const wrapped = wrapInHarnessSandbox(w.input, {
      bin: '/bin/bash',
      args: ['-c', `cat ${login} 2>&1; echo HOME-VAR=$CODEX_HOME; echo W > ${w.input.cwd}/o && echo WRITES`],
      env: { PATH: '/usr/bin:/bin', CODEX_HOME: '/some/home', ...proxyEnv(3128) },
    });
    expect(wrapped.args).toContain(REAL_SHELL_IN_BOX);
    const r = await execa(wrapped.bin, wrapped.args, {
      cwd: w.input.cwd,
      env: wrapped.env,
      extendEnv: false,
      reject: false,
      all: true,
      timeout: 30_000,
    });
    const out = String(r.all ?? '');
    expect(out).not.toContain('CODEX-LOGIN-XYZ');
    expect(out).toContain('HOME-VAR=\n');
    expect(out).toContain('WRITES');
    await w.proxy.close();
  });
});

describe('the egress proxy rules', () => {
  it('matches exact hosts and subdomains of a wildcard', () => {
    expect(hostAllowed('registry.npmjs.org', ['*.npmjs.org'])).toBe(true);
    expect(hostAllowed('npmjs.org', ['*.npmjs.org'])).toBe(false);
    expect(hostAllowed('evilnpmjs.org', ['*.npmjs.org'])).toBe(false);
    expect(hostAllowed('GitHub.com.', ['github.com'])).toBe(true);
  });
  it('treats loopback, private, link-local and metadata addresses as private', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '192.168.1.1',
      '172.16.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '0.0.0.0',
    ])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '142.250.1.1', '2607:f8b0::1']) expect(isPrivateAddress(ip), ip).toBe(false);
  });
  it('refuses an allowed name that resolves to a private address', async () => {
    const dir = mkdtempSync(join(userInfo().homedir, '.aom-egress-'));
    const sock = join(dir, 'p.sock');
    const p = await startEgressProxy({
      socketPath: sock,
      allowedHosts: ['rebind.test'],
      resolve: async () => '169.254.169.254',
    });
    const reply = await new Promise<string>((resolve) => {
      const c = netConnect(sock);
      let b = '';
      c.on('data', (d) => {
        b += d;
      });
      c.on('close', () => resolve(b));
      c.write('CONNECT rebind.test:443 HTTP/1.1\r\nHost: rebind.test:443\r\n\r\n');
    });
    expect(reply).toMatch(/^HTTP\/1.1 403/);
    expect(p.denied()).toContain('rebind.test');
    await p.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
