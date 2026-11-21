import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUNNER_VERSION } from '../src/version.ts';
import { ADMIN_FILE, ALICE, admin, fakeSystem, RUNNER } from './admin/fake-system.ts';

const RUNNER_SRC = join(import.meta.dirname, '../src');
const source = readFileSync(ADMIN_FILE, 'utf8');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

describe('guildwise-admin: a self-contained root tool [rv6-1, rv7-12]', () => {
  it('imports nothing but node: built-ins (nothing from the runner tree)', () => {
    const requires = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    expect(requires.length).toBeGreaterThan(3);
    for (const r of requires) expect(r).toMatch(/^node:/);
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/import\(/);
  });

  it('starts with the bundled Node as its interpreter', () => {
    expect(source.split('\n')[0]).toBe('#!/usr/local/lib/guildwise/node/bin/node');
  });

  it('refuses to run under any other Node (here: the test runner)', () => {
    const r = spawnSync(process.execPath, [ADMIN_FILE, 'verify'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('runs only under the bundled Node at /usr/local/lib/guildwise/node/bin/node');
  });

  it('refuses through main() for a wrong execPath, and needs root unless --dry-run', async () => {
    const f = fakeSystem({ users: [RUNNER] });
    f.sys.execPath = '/usr/bin/node';
    expect(await admin.main(['verify'], f.sys)).toBe(2);
    const g = fakeSystem({ users: [RUNNER] });
    g.sys.uid = () => 1000;
    expect(await admin.main(['docker', 'none'], g.sys)).toBe(2);
    expect(g.err.join('\n')).toContain('needs root');
    expect(await admin.main(['docker', 'none', '--dry-run'], g.sys)).toBe(0);
  });

  it('keeps its compiled-in floor equal to MIN_TRUSTED_RUNNER (raised by hand, never with RUNNER_VERSION)', () => {
    const floorFile = join(RUNNER_SRC, 'update/floor.ts');
    if (existsSync(floorFile)) {
      const m = /MIN_TRUSTED_RUNNER\s*=\s*'([^']+)'/.exec(readFileSync(floorFile, 'utf8'));
      expect(admin.RUNNER_FLOOR).toBe(m?.[1]);
    } else {
      // before the W8 merge: the floor is W8's 1.10.0 runner, never below this tree's version
      const num = (v: string) => v.split('.').reduce((n, p) => n * 1000 + Number(p), 0);
      expect(num(admin.RUNNER_FLOOR)).toBeGreaterThanOrEqual(num(RUNNER_VERSION));
    }
  });

  it('is never written by the runner: no runner source outside setup/ names the admin folder', () => {
    const hits = walk(RUNNER_SRC)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => readFileSync(f, 'utf8').includes('/usr/local/lib/guildwise'))
      .map((f) => relative(RUNNER_SRC, f));
    expect(hits).toEqual(['setup/admin-command.ts']);
  });
});

describe('user create [R20 step 1, R18-P]', () => {
  it('Linux: useradd --system with no login shell, leaves sudo/docker groups, HOME and ~/src at 0700', async () => {
    const f = fakeSystem({
      handle: (c) => {
        if (c.cmd === 'id' && c.args[1] === 'guildwise-runner')
          return { code: 0, stdout: 'guildwise-runner docker sudo\n', stderr: '' };
        return undefined;
      },
    });
    expect(await admin.main(['user', 'create'], f.sys)).toBe(0);
    expect(f.calls).toContainEqual({
      cmd: 'useradd',
      args: ['--system', '--create-home', '--shell', '/usr/sbin/nologin', 'guildwise-runner'],
    });
    expect(f.calls).toContainEqual({ cmd: 'gpasswd', args: ['-d', 'guildwise-runner', 'docker'] });
    expect(f.calls).toContainEqual({ cmd: 'gpasswd', args: ['-d', 'guildwise-runner', 'sudo'] });
    expect(statSync(join(f.root, '/home/guildwise-runner')).mode & 0o777).toBe(0o700);
    expect(statSync(join(f.root, '/home/guildwise-runner/src')).mode & 0o7777).toBe(0o700);
  });

  it('macOS: a hidden standard user below uid 500 with home /var/guildwise-runner, not in admin', async () => {
    let created = false;
    const f = fakeSystem({
      platform: 'darwin',
      handle: (c) => {
        if (c.cmd === 'dscl' && c.args[1] === '-read')
          return created
            ? {
                code: 0,
                stdout: 'UniqueID: 497\nPrimaryGroupID: 20\nNFSHomeDirectory: /var/guildwise-runner\n',
                stderr: '',
              }
            : { code: 56, stdout: '', stderr: 'not found' };
        if (c.cmd === 'dscl' && c.args[1] === '-list')
          return { code: 0, stdout: 'root 0\n_a 499\n_b 498\n', stderr: '' };
        if (c.cmd === 'dscl' && c.args.includes('IsHidden')) created = true;
        if (c.cmd === 'id') return { code: 0, stdout: 'staff admin\n', stderr: '' };
        return undefined;
      },
    });
    mkdirSync(join(f.root, 'var'));
    expect(await admin.main(['user', 'create'], f.sys)).toBe(0);
    const creates = f.calls
      .filter((c) => c.cmd === 'dscl' && c.args[1] === '-create')
      .map((c) => c.args.slice(3));
    expect(creates).toContainEqual(['UniqueID', '497']);
    expect(creates).toContainEqual(['IsHidden', '1']);
    expect(creates).toContainEqual(['NFSHomeDirectory', '/var/guildwise-runner']);
    expect(creates).toContainEqual(['PrimaryGroupID', '20']);
    expect(f.calls).toContainEqual({
      cmd: 'dseditgroup',
      args: ['-o', 'edit', '-d', 'guildwise-runner', '-t', 'user', 'admin'],
    });
    expect(existsSync(join(f.root, '/var/guildwise-runner/src'))).toBe(true);
  });

  it('dry run changes nothing', async () => {
    const f = fakeSystem();
    expect(await admin.main(['user', 'create', '--dry-run'], f.sys)).toBe(0);
    expect(f.calls.some((c) => c.cmd === 'useradd')).toBe(false);
    expect(f.out.join('\n')).toContain(
      'would run: useradd --system --create-home --shell /usr/sbin/nologin guildwise-runner',
    );
    expect(existsSync(join(f.root, 'home'))).toBe(false);
  });
});

describe('service install [R18-P]', () => {
  it('Linux: a system unit as the runner user that is not restarted after the start-up refusal (78)', async () => {
    const f = fakeSystem({ users: [RUNNER] });
    expect(await admin.main(['service', 'install'], f.sys)).toBe(0);
    const unit = readFileSync(join(f.root, admin.SYSTEMD_UNIT), 'utf8');
    for (const line of [
      'User=guildwise-runner',
      'RestartPreventExitStatus=78',
      'NoNewPrivileges=no',
      'ProtectSystem=full',
      'ExecStart="/home/guildwise-runner/.local/share/guildwise/runner/current/aom-runner" start',
      'WantedBy=multi-user.target',
    ])
      expect(unit).toContain(`${line}\n`);
    expect(statSync(join(f.root, admin.SYSTEMD_UNIT)).mode & 0o777).toBe(0o644);
    expect(f.calls).toContainEqual({ cmd: 'systemctl', args: ['daemon-reload'] });
  });

  it('refuses a runner root that could inject into the unit', async () => {
    const f = fakeSystem({ users: [RUNNER] });
    expect(
      await admin.main(['service', 'install', '--runner-root', '/x"\nExecStartPre=/bin/evil'], f.sys),
    ).toBe(1);
    expect(existsSync(join(f.root, admin.SYSTEMD_UNIT))).toBe(false);
  });

  it('--ca-file: a root-owned copy of the CA, NODE_EXTRA_CA_CERTS in the unit, TLS checks left on (UAT R25 F4)', async () => {
    const f = fakeSystem({ users: [RUNNER] });
    const src = join(RUNNER.home, '.local/share/guildwise/runner/ca.pem');
    mkdirSync(join(f.root, RUNNER.home, '.local/share/guildwise/runner'), { recursive: true });
    const pem = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n';
    writeFileSync(join(f.root, src), pem);
    expect(await admin.main(['service', 'install', '--ca-file', src, '--start'], f.sys)).toBe(0);
    expect(readFileSync(join(f.root, admin.RUNNER_CA_FILE), 'utf8')).toBe(pem);
    expect(statSync(join(f.root, admin.RUNNER_CA_FILE)).mode & 0o777).toBe(0o644);
    const unit = readFileSync(join(f.root, admin.SYSTEMD_UNIT), 'utf8');
    expect(unit).toContain('Environment="NODE_EXTRA_CA_CERTS=/etc/guildwise-runner/ca.pem"\n');
    expect(unit).not.toContain('NODE_TLS_REJECT_UNAUTHORIZED');
    // a later install without the option keeps the CA
    expect(await admin.main(['service', 'install'], f.sys)).toBe(0);
    expect(readFileSync(join(f.root, admin.SYSTEMD_UNIT), 'utf8')).toContain('NODE_EXTRA_CA_CERTS=');
    // without any CA: no line
    const g = fakeSystem({ users: [RUNNER] });
    expect(await admin.main(['service', 'install'], g.sys)).toBe(0);
    expect(readFileSync(join(g.root, admin.SYSTEMD_UNIT), 'utf8')).not.toContain('NODE_EXTRA_CA_CERTS');
  });

  it('--ca-file refuses a missing file, a non-certificate and a private key', async () => {
    const f = fakeSystem({ users: [RUNNER] });
    mkdirSync(join(f.root, 'tmp'), { recursive: true });
    writeFileSync(join(f.root, 'tmp/not.pem'), 'hello\n');
    writeFileSync(
      join(f.root, 'tmp/key.pem'),
      '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n-----BEGIN PRIVATE KEY-----\ny\n',
    );
    for (const file of ['/tmp/missing.pem', '/tmp/not.pem', '/tmp/key.pem']) {
      expect(await admin.main(['service', 'install', '--ca-file', file], f.sys)).toBe(1);
    }
    expect(existsSync(join(f.root, admin.RUNNER_CA_FILE))).toBe(false);
    expect(existsSync(join(f.root, admin.SYSTEMD_UNIT))).toBe(false);
  });

  it('macOS: the LaunchDaemon gets NODE_EXTRA_CA_CERTS with a CA', () => {
    const u = { name: 'guildwise-runner', uid: 497, gid: 20, home: '/var/guildwise-runner' };
    const root = '/var/guildwise-runner/.local/share/guildwise/runner';
    expect(admin.plistText(u, root, '/etc/guildwise-runner/ca.pem')).toContain(
      '<key>NODE_EXTRA_CA_CERTS</key><string>/etc/guildwise-runner/ca.pem</string>',
    );
    expect(admin.plistText(u, root)).not.toContain('NODE_EXTRA_CA_CERTS');
  });

  it('macOS: a LaunchDaemon with UserName guildwise-runner', () => {
    const plist = admin.plistText(
      { name: 'guildwise-runner', uid: 497, gid: 20, home: '/var/guildwise-runner' },
      '/var/guildwise-runner/.local/share/guildwise/runner',
    );
    expect(plist).toContain('<key>UserName</key><string>guildwise-runner</string>');
    expect(plist).toContain('<key>Label</key><string>com.guildwisehq.runner</string>');
    expect(plist).toContain('<key>KeepAlive</key><dict><key>Crashed</key><true/></dict>');
    expect(admin.LAUNCHD_PLIST).toBe('/Library/LaunchDaemons/com.guildwisehq.runner.plist');
  });
});

describe('docker rootless|host|shared|none (deps-without-sudo §3)', () => {
  /** A machine with Docker sockets: `stat` answers for the fixture paths (a fixture cannot be owned by another group). */
  function withSockets(
    sockets: Record<string, { uid: number; gid: number; link?: string }>,
    opts: Parameters<typeof fakeSystem>[0] = {},
  ) {
    const groupNames: Record<number, string> = { 0: 'root', 962: 'docker-svc', 998: 'docker' };
    const f = fakeSystem({
      users: [RUNNER],
      ...opts,
      handle: (c, sys) =>
        c.cmd === 'getent' && c.args[0] === 'group' && /^\d+$/.test(c.args[1] as string)
          ? { code: 0, stdout: `${groupNames[Number(c.args[1])] ?? 'g'}:x:${c.args[1]}:\n`, stderr: '' }
          : opts.handle?.(c, sys),
    });
    const stats = new Map<string, { uid: number; gid: number }>();
    for (const [p, s] of Object.entries(sockets)) {
      mkdirSync(join(f.root, p, '..'), { recursive: true });
      // an absolute link inside the fixture root (never the real machine's sockets)
      if (s.link) symlinkSync(join(f.root, s.link), join(f.root, p));
      else {
        writeFileSync(join(f.root, p), '');
        stats.set(join(f.root, p), { uid: s.uid, gid: s.gid });
      }
    }
    (f.sys as unknown as { stat: (p: string) => unknown }).stat = (p: string) => {
      const st = stats.get(p);
      if (!st) throw new Error('ENOENT');
      return st;
    };
    return f;
  }

  it('rootless: leaves the groups of every Docker socket (docker, docker-svc), gets a subuid range and linger', async () => {
    const f = withSockets(
      {
        '/run/docker-svc/docker.sock': { uid: 0, gid: 962 },
        '/run/docker.sock': { uid: 0, gid: 0, link: '/run/docker-svc/docker.sock' },
      },
      { users: [{ ...RUNNER, groups: ['docker', 'docker-svc'] }] },
    );
    expect(await admin.main(['docker', 'rootless'], f.sys)).toBe(0);
    expect(f.calls).toContainEqual({ cmd: 'gpasswd', args: ['-d', 'guildwise-runner', 'docker'] });
    expect(f.calls).toContainEqual({ cmd: 'gpasswd', args: ['-d', 'guildwise-runner', 'docker-svc'] });
    expect(f.calls).toContainEqual({
      cmd: 'usermod',
      args: ['--add-subuids', '131072-196607', '--add-subgids', '131072-196607', 'guildwise-runner'],
    });
    expect(f.calls).toContainEqual({ cmd: 'loginctl', args: ['enable-linger', 'guildwise-runner'] });
  });

  it('subuid ranges: aligned, from 100000 up, after every entry of both files; skipped when the user has one', () => {
    expect(admin.nextSubidStart([])).toBe(131072);
    expect(admin.nextSubidStart(admin.parseSubids('a:100000:65536\nb:165536:65536\n'))).toBe(262144);
    expect(admin.parseSubids('# c\nx:1:2\nbad line\n')).toEqual([{ name: 'x', start: 1, count: 2 }]);
  });

  it('F2: the AppArmor profile only where unprivileged user namespaces are restricted (AppArmor 4)', async () => {
    const restricted = fakeSystem({ users: [RUNNER] });
    mkdirSync(join(restricted.root, '/proc/sys/kernel'), { recursive: true });
    writeFileSync(join(restricted.root, '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'), '1\n');
    expect(await admin.main(['docker', 'rootless'], restricted.sys)).toBe(0);
    const profile = readFileSync(
      join(restricted.root, '/etc/apparmor.d/guildwise-runner-rootlesskit'),
      'utf8',
    );
    expect(profile).toContain('abi <abi/4.0>,');
    expect(profile).toContain('"/usr/local/lib/guildwise/docker/rootlesskit" flags=(unconfined)');
    expect(profile).toContain('  userns,');
    expect(restricted.calls).toContainEqual({
      cmd: 'apparmor_parser',
      args: ['-r', '/etc/apparmor.d/guildwise-runner-rootlesskit'],
    });
    // Debian 12 (AppArmor 3): the sysctl is absent; no profile, no apparmor_parser
    const debian = fakeSystem({ users: [RUNNER] });
    mkdirSync(join(debian.root, '/sys/kernel/security/apparmor'), { recursive: true });
    expect(await admin.main(['docker', 'rootless'], debian.sys)).toBe(0);
    expect(existsSync(join(debian.root, '/etc/apparmor.d/guildwise-runner-rootlesskit'))).toBe(false);
    expect(debian.calls.some((c) => c.cmd === 'apparmor_parser')).toBe(false);
    expect(debian.out.join('\n')).toContain('no AppArmor profile needed');
  });

  it('F1: current-user mode never changes the groups of the person installing', async () => {
    const f = withSockets(
      { '/var/run/docker.sock': { uid: 0, gid: 998 } },
      { users: [{ ...ALICE, groups: ['docker'] }] },
    );
    expect(await admin.main(['docker', 'rootless', '--user', 'alice'], f.sys)).toBe(0);
    expect(await admin.main(['docker', 'none', '--user', 'alice'], f.sys)).toBe(0);
    expect(f.calls.some((c) => c.cmd === 'gpasswd')).toBe(false);
    expect(f.calls.some((c) => c.cmd === 'loginctl' && c.args[0] === 'disable-linger')).toBe(false);
  });

  it("host: needs --accept-root-equivalent, uses the socket's own group, refuses gid 0", async () => {
    const f = withSockets({ '/var/run/docker.sock': { uid: 0, gid: 998 } });
    expect(await admin.main(['docker', 'host'], f.sys)).toBe(1);
    expect(f.err.join('\n')).toContain('root-equivalent');
    expect(await admin.main(['docker', 'host', '--accept-root-equivalent'], f.sys)).toBe(0);
    expect(f.calls).toContainEqual({ cmd: 'usermod', args: ['-aG', 'docker', 'guildwise-runner'] });
    const g = withSockets({ '/var/run/docker.sock': { uid: 0, gid: 0 } });
    expect(await admin.main(['docker', 'host', '--accept-root-equivalent'], g.sys)).toBe(1);
    expect(g.err.join('\n')).toContain('group root');
    expect(g.calls.some((c) => c.args[0] === '-aG')).toBe(false);
  });

  it('host on macOS: ACLs for the hidden user on the Docker Desktop socket and its folders (not yet tested on hardware)', async () => {
    const f = fakeSystem({
      platform: 'darwin',
      users: [{ ...RUNNER, home: '/var/guildwise-runner' }],
      handle: (c) =>
        c.cmd === 'dscl' && c.args[1] === '-read'
          ? {
              code: 0,
              stdout: 'UniqueID: 498\nPrimaryGroupID: 20\nNFSHomeDirectory: /var/guildwise-runner\n',
              stderr: '',
            }
          : undefined,
    });
    const sock = '/Users/alice/.docker/run/docker.sock';
    expect(
      await admin.main(
        ['docker', 'host', '--accept-root-equivalent', '--desktop-socket', '/tmp/x.sock'],
        f.sys,
      ),
    ).toBe(1);
    expect(
      await admin.main(['docker', 'host', '--accept-root-equivalent', '--desktop-socket', sock], f.sys),
    ).toBe(0);
    expect(f.calls.filter((c) => c.cmd === 'chmod')).toEqual([
      { cmd: 'chmod', args: ['+a', 'guildwise-runner allow search', '/Users/alice'] },
      { cmd: 'chmod', args: ['+a', 'guildwise-runner allow search', '/Users/alice/.docker'] },
      {
        cmd: 'chmod',
        args: [
          '+a',
          'guildwise-runner allow list,search,add_file,read,write,append,file_inherit',
          '/Users/alice/.docker/run',
        ],
      },
      { cmd: 'chmod', args: ['+a', 'guildwise-runner allow read,write,append', sock] },
    ]);
    expect(await admin.main(['docker', 'none', '--desktop-socket', sock], f.sys)).toBe(0);
    expect(f.calls.filter((c) => c.cmd === 'chmod' && c.args[0] === '-a')).toHaveLength(4);
    expect(await admin.main(['docker', 'rootless'], f.sys)).toBe(1);
  });

  /** A root-owned docker CLI at /usr/bin/docker in the fixture root; `info` answers with `opts` (S1). */
  function sharedMachine(
    info: { rootless: boolean; code?: number },
    sockets?: Parameters<typeof withSockets>[0],
  ) {
    const f = withSockets(
      sockets ?? {
        '/run/docker-svc/docker.sock': { uid: 0, gid: 962 },
        '/run/docker.sock': { uid: 0, gid: 0, link: '/run/docker-svc/docker.sock' },
      },
      {
        handle: (c) =>
          c.cmd === '/usr/bin/docker'
            ? {
                code: info.code ?? 0,
                stdout: info.rootless ? '["name=seccomp","name=rootless"]\n' : '["name=seccomp"]\n',
                stderr: '',
              }
            : undefined,
      },
    );
    mkdirSync(join(f.root, 'usr/bin'), { recursive: true });
    writeFileSync(join(f.root, 'usr/bin/docker'), '#!/bin/sh\n');
    chmodSync(join(f.root, 'usr/bin/docker'), 0o755);
    mkdirSync(join(f.root, RUNNER.home), { recursive: true });
    return f;
  }
  const SHARED = [
    'docker',
    'shared',
    '--docker-socket',
    '/run/docker-svc/docker.sock',
    '--accept-shared-daemon',
  ];
  const joined = (f: { calls: { cmd: string; args: string[] }[] }) =>
    f.calls.some((c) => (c.cmd === 'usermod' && c.args[0] === '-aG') || c.cmd === 'gpasswd');

  it("shared (owner 2026-11-21): the socket group of another user's rootless daemon, the acceptance recorded in policy.json", async () => {
    const f = sharedMachine({ rootless: true });
    expect(await admin.main(SHARED.slice(0, 4), f.sys)).toBe(1);
    expect(f.err.join('\n')).toContain('--accept-shared-daemon');
    expect(await admin.main(SHARED, f.sys)).toBe(0);
    // S1: root asked the daemon itself, through the root-owned CLI, before the group change
    const ask = f.calls.findIndex((c) => c.cmd === '/usr/bin/docker');
    const join_ = f.calls.findIndex((c) => c.cmd === 'usermod' && c.args[0] === '-aG');
    expect(f.calls[ask]?.args).toEqual([
      '-H',
      'unix:///run/docker-svc/docker.sock',
      'info',
      '--format',
      '{{json .SecurityOptions}}',
    ]);
    expect(ask).toBeLessThan(join_);
    expect(f.calls[join_]).toEqual({ cmd: 'usermod', args: ['-aG', 'docker-svc', 'guildwise-runner'] });
    const policy = JSON.parse(
      readFileSync(join(f.root, RUNNER.home, '.config/aom-runner/policy.json'), 'utf8'),
    );
    expect(policy).toMatchObject({
      docker: 'shared',
      dockerHost: 'unix:///run/docker-svc/docker.sock',
      sharedDocker: { socket: '/run/docker-svc/docker.sock', group: 'docker-svc' },
    });
    expect(f.out.join('\n')).toContain("Runners that share a daemon can each control the other's containers");
  });

  it('S1: a daemon that is not rootless (or does not answer) is refused and no group is joined', async () => {
    for (const info of [{ rootless: false }, { rootless: true, code: 1 }]) {
      const f = sharedMachine(info);
      expect(await admin.main(SHARED, f.sys)).toBe(1);
      expect(f.err.join('\n')).toContain('does not run rootless');
      expect(joined(f)).toBe(false);
      expect(existsSync(join(f.root, RUNNER.home, '.config/aom-runner/policy.json'))).toBe(false);
    }
  });

  it('S1: a link to the default root socket, a dot segment, the docker group and no trusted CLI are refused', async () => {
    // /run/x/docker.sock links to the root daemon's /run/docker.sock
    const link = sharedMachine(
      { rootless: true },
      {
        '/run/docker.sock': { uid: 0, gid: 998 },
        '/run/x/docker.sock': { uid: 0, gid: 0, link: '/run/docker.sock' },
      },
    );
    expect(
      await admin.main([...SHARED.slice(0, 3), '/run/x/docker.sock', '--accept-shared-daemon'], link.sys),
    ).toBe(1);
    expect(link.err.join('\n')).toContain('resolves to /run/docker.sock');
    expect(joined(link)).toBe(false);
    // /run/./docker.sock never passes the pattern
    expect(
      await admin.main([...SHARED.slice(0, 3), '/run/./docker.sock', '--accept-shared-daemon'], link.sys),
    ).toBe(1);
    expect(link.err.join('\n')).toContain('--docker-socket /run/<name>/docker.sock');
    // a socket of the docker group is root-equivalent: host, never shared
    const grp = sharedMachine({ rootless: true }, { '/run/svc/docker.sock': { uid: 0, gid: 998 } });
    expect(
      await admin.main([...SHARED.slice(0, 3), '/run/svc/docker.sock', '--accept-shared-daemon'], grp.sys),
    ).toBe(1);
    expect(grp.err.join('\n')).toContain('docker group');
    expect(joined(grp)).toBe(false);
    // no root-owned CLI: nothing is asked through PATH, refused
    const nocli = sharedMachine({ rootless: true });
    chmodSync(join(nocli.root, 'usr/bin/docker'), 0o777);
    expect(await admin.main(SHARED, nocli.sys)).toBe(1);
    expect(nocli.err.join('\n')).toContain('no root-owned docker CLI');
    expect(nocli.calls.some((c) => c.cmd === 'docker' || c.cmd === '/usr/bin/docker')).toBe(false);
    expect(joined(nocli)).toBe(false);
  });

  it('none: leaves the socket groups and removes the AppArmor profile', async () => {
    const f = withSockets(
      { '/var/run/docker.sock': { uid: 0, gid: 998 } },
      { users: [{ ...RUNNER, groups: ['docker'] }] },
    );
    mkdirSync(join(f.root, '/etc/apparmor.d'), { recursive: true });
    writeFileSync(join(f.root, '/etc/apparmor.d/guildwise-runner-rootlesskit'), 'x');
    expect(await admin.main(['docker', 'none'], f.sys)).toBe(0);
    expect(f.calls).toContainEqual({ cmd: 'gpasswd', args: ['-d', 'guildwise-runner', 'docker'] });
    expect(existsSync(join(f.root, '/etc/apparmor.d/guildwise-runner-rootlesskit'))).toBe(false);
  });

  it('the removed modes are refused', async () => {
    const f = fakeSystem({ users: [RUNNER] });
    expect(await admin.main(['docker', 'narrow'], f.sys)).toBe(1);
    expect(await admin.main(['docker', 'group', '--accept-root-equivalent'], f.sys)).toBe(1);
  });
});

describe('cleanup-legacy: what 1.10.0 removed (sudo, sealed sudo, narrow mode)', () => {
  it('removes the sudoers files, deploy-compose and its approvals, locks the password, deletes sudo.enc unread', async () => {
    const f = fakeSystem({ users: [RUNNER] });
    mkdirSync(join(f.root, 'etc/sudoers.d'), { recursive: true });
    writeFileSync(join(f.root, admin.SUDOERS_SUDO), 'x\n');
    writeFileSync(join(f.root, admin.SUDOERS_DOCKER), 'x\n');
    mkdirSync(join(f.root, '/etc/guildwise-runner/apps'), { recursive: true });
    writeFileSync(join(f.root, '/etc/guildwise-runner/apps/shop.conf'), 'hash=x\n');
    mkdirSync(join(f.root, '/usr/local/lib/guildwise'), { recursive: true });
    writeFileSync(join(f.root, '/usr/local/lib/guildwise/deploy-compose'), 'x');
    const data = join(f.root, RUNNER.home, '.aom-runner');
    mkdirSync(join(data, 'secrets'), { recursive: true });
    mkdirSync(join(data, 'pairings/uat-1/secrets'), { recursive: true });
    writeFileSync(
      join(data, 'pairings.json'),
      JSON.stringify({ pairings: [{ dir: '.' }, { dir: 'pairings/uat-1' }] }),
    );
    // not readable at all: an unlink never needs to open it
    for (const d of ['secrets', 'pairings/uat-1/secrets']) {
      writeFileSync(join(data, d, 'sudo.enc'), 'CIPHERTEXT\n');
      chmodSync(join(data, d, 'sudo.enc'), 0o000);
    }
    expect(await admin.main(['cleanup-legacy'], f.sys)).toBe(0);
    expect(existsSync(join(f.root, admin.SUDOERS_SUDO))).toBe(false);
    expect(existsSync(join(f.root, admin.SUDOERS_DOCKER))).toBe(false);
    expect(existsSync(join(f.root, '/etc/guildwise-runner/apps'))).toBe(false);
    expect(existsSync(join(f.root, '/usr/local/lib/guildwise/deploy-compose'))).toBe(false);
    expect(existsSync(join(data, 'secrets/sudo.enc'))).toBe(false);
    expect(existsSync(join(data, 'pairings/uat-1/secrets/sudo.enc'))).toBe(false);
    expect(f.calls).toContainEqual({ cmd: 'usermod', args: ['-L', 'guildwise-runner'] });
    expect(f.out.join('\n')).not.toContain('CIPHERTEXT');
    // idempotent
    expect(await admin.main(['cleanup-legacy'], f.sys)).toBe(0);
  });

  it('refuses a symlinked secrets folder (never follows a link the runner planted)', async () => {
    const f = fakeSystem({ users: [RUNNER] });
    const data = join(f.root, RUNNER.home, '.aom-runner');
    mkdirSync(data, { recursive: true });
    mkdirSync(join(f.root, 'elsewhere'), { recursive: true });
    writeFileSync(join(f.root, 'elsewhere/sudo.enc'), 'x');
    symlinkSync(join(f.root, 'elsewhere'), join(data, 'secrets'));
    expect(await admin.main(['cleanup-legacy'], f.sys)).toBe(1);
    expect(f.err.join('\n')).toContain('refusing to follow the symlink');
    expect(existsSync(join(f.root, 'elsewhere/sudo.enc'))).toBe(true);
  });

  it('leaves apps narrow mode started alone and says how to stop them', async () => {
    const f = fakeSystem({ users: [RUNNER] });
    mkdirSync(join(f.root, '/var/lib/guildwise/apps/shop'), { recursive: true });
    expect(await admin.main(['cleanup-legacy'], f.sys)).toBe(0);
    expect(existsSync(join(f.root, '/var/lib/guildwise/apps/shop'))).toBe(true);
    expect(f.out.join('\n')).toContain('docker compose -p <project> down');
  });
});

describe('verify: root-owned install, no sudoers rule, root PATH [rv6-1]', () => {
  function installed() {
    const f = fakeSystem({ users: [RUNNER] });
    const dirs = [
      'usr',
      'usr/local',
      'usr/local/lib',
      'usr/local/lib/guildwise',
      'usr/local/lib/guildwise/node',
      'usr/local/lib/guildwise/node/bin',
    ];
    for (const d of dirs) {
      mkdirSync(join(f.root, d), { recursive: true });
      chmodSync(join(f.root, d), 0o755);
    }
    for (const file of ['guildwise-admin', 'node/bin/node']) {
      writeFileSync(join(f.root, 'usr/local/lib/guildwise', file), '#!/bin/sh\n');
      chmodSync(join(f.root, 'usr/local/lib/guildwise', file), 0o755);
    }
    chmodSync(f.root, 0o755);
    return f;
  }

  it('passes on a clean install', async () => {
    const f = installed();
    expect(await admin.main(['verify'], f.sys)).toBe(0);
    expect(f.err).toEqual([]);
  });

  it("flags a tool writable by others, a parent not owned by root, and a runner path on root's PATH", async () => {
    const f = installed();
    mkdirSync(join(f.root, 'usr/local/lib/guildwise/docker'), { mode: 0o755 });
    writeFileSync(join(f.root, 'usr/local/lib/guildwise/docker/dockerd'), '');
    chmodSync(join(f.root, 'usr/local/lib/guildwise/docker/dockerd'), 0o777);
    f.sys.env.PATH = '/home/guildwise-runner/.local/bin:/usr/bin';
    expect(await admin.main(['verify'], f.sys)).toBe(1);
    const e = f.err.join('\n');
    expect(e).toContain('/usr/local/lib/guildwise/docker/dockerd is writable by group or others');
    expect(e).toContain("root's PATH includes the runner's HOME");
    const g = installed();
    g.sys.rootUid = 12345;
    expect(await admin.main(['verify'], g.sys)).toBe(1);
    expect(g.err.join('\n')).toContain('/usr/local/lib/guildwise is not owned by root');
  });

  it('flags any sudoers drop-in left for the runner, and a secure_path into the runner HOME', async () => {
    const f = installed();
    mkdirSync(join(f.root, 'etc/sudoers.d'), { recursive: true });
    writeFileSync(join(f.root, admin.SUDOERS_DOCKER), 'x\n', { mode: 0o440 });
    writeFileSync(join(f.root, 'etc/sudoers.d/other-user'), 'x\n', { mode: 0o440 });
    writeFileSync(
      join(f.root, 'etc/sudoers'),
      'Defaults secure_path="/home/guildwise-runner/bin:/usr/bin"\n',
    );
    expect(await admin.main(['verify'], f.sys)).toBe(1);
    const e = f.err.join('\n');
    expect(e).toContain('/etc/sudoers.d/guildwise-runner-docker gives the runner sudo');
    expect(e).not.toContain('other-user');
    expect(e).toContain('/home/guildwise-runner/bin');
  });
});

describe('apply: the installer flags [R20 non-interactive]', () => {
  it('rejects the removed flags --sudo and --approve-app, and the removed docker values', async () => {
    const f = fakeSystem({ users: [RUNNER] });
    expect(await admin.main(['apply', '--yes', '--sudo', 'on'], f.sys)).toBe(64);
    expect(await admin.main(['apply', '--yes', '--approve-app', 'shop=/x'], f.sys)).toBe(64);
    expect(await admin.main(['apply', '--yes', '--docker', 'narrow'], f.sys)).toBe(1);
    expect(await admin.main(['apply', '--yes', '--docker', 'group'], f.sys)).toBe(1);
    expect(await admin.main(['sudo', 'on'], f.sys)).toBe(64);
    expect(await admin.main(['approve-app', 'shop'], f.sys)).toBe(64);
    expect(f.calls.some((c) => c.cmd === 'useradd')).toBe(false);
  });

  it('user create refuses any account but the dedicated one', async () => {
    const f = fakeSystem({ users: [RUNNER, ALICE] });
    expect(await admin.main(['user', 'create', '--user', 'alice'], f.sys)).toBe(1);
    expect(f.calls.some((c) => c.cmd === 'gpasswd' || c.cmd === 'usermod')).toBe(false);
  });

  it('--yes alone: dedicated user and its service, the legacy clean-up, no Docker, no sudoers', async () => {
    const f = fakeSystem();
    mkdirSync(join(f.root, 'etc/sudoers.d'), { recursive: true });
    writeFileSync(join(f.root, admin.SUDOERS_SUDO), 'x\n');
    expect(await admin.main(['apply', '--yes'], f.sys)).toBe(0);
    expect(f.calls.some((c) => c.cmd === 'useradd')).toBe(true);
    expect(existsSync(join(f.root, admin.SYSTEMD_UNIT))).toBe(true);
    expect(existsSync(join(f.root, admin.SUDOERS_SUDO))).toBe(false);
    expect(f.calls.some((c) => c.cmd === 'chpasswd' || c.cmd === 'visudo')).toBe(false);
    expect(readFileSync(join(f.root, admin.SYSTEMD_UNIT), 'utf8')).not.toContain('sudo');
  });

  it('refuses docker host without the acceptance and shared without its own acceptance', async () => {
    const f = fakeSystem({ users: [RUNNER] });
    expect(await admin.main(['apply', '--yes', '--docker', 'host'], f.sys)).toBe(1);
    expect(
      await admin.main(
        ['apply', '--yes', '--docker', 'shared', '--docker-socket', '/run/x/docker.sock'],
        f.sys,
      ),
    ).toBe(1);
    expect(f.calls.some((c) => c.cmd === 'useradd')).toBe(false);
  });

  it('--docker rootless: the dedicated user gets its subuid range and linger', async () => {
    const f = fakeSystem();
    expect(await admin.main(['apply', '--yes', '--docker', 'rootless'], f.sys)).toBe(0);
    expect(f.calls).toContainEqual({ cmd: 'loginctl', args: ['enable-linger', 'guildwise-runner'] });
  });
});
