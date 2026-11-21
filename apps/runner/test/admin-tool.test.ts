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
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunnerKeys } from '../src/secrets/keys.ts';
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
    expect(await admin.main(['docker', 'narrow', '--dry-run'], g.sys)).toBe(0);
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

describe('sudoers files pass visudo -cf', () => {
  it.each([
    ['sudo', admin.sudoersForSudo('guildwise-runner')],
    ['docker', admin.sudoersForDocker('guildwise-runner')],
  ])('%s rule', (_k, text: string) => {
    const f = fakeSystem();
    const file = join(f.root, 'rule');
    writeFileSync(file, text, { mode: 0o440 });
    const r = spawnSync('visudo', ['-cf', file], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  });

  it('sudo needs a password; the docker rule is the only NOPASSWD and names deploy-compose without wildcards', () => {
    expect(admin.sudoersForSudo('guildwise-runner')).toContain('guildwise-runner ALL=(ALL) ALL\n');
    expect(admin.sudoersForSudo('guildwise-runner')).not.toContain('NOPASSWD');
    const d = admin.sudoersForDocker('guildwise-runner');
    expect(d).toContain('guildwise-runner ALL=(root) NOPASSWD: /usr/local/lib/guildwise/deploy-compose\n');
    expect(d).not.toContain('*');
  });

  it('pins the environment of the NOPASSWD rule whatever the local sudo defaults (Node reads NODE_OPTIONS first)', () => {
    expect(admin.sudoersForDocker('guildwise-runner')).toContain(
      'Defaults!/usr/local/lib/guildwise/deploy-compose env_reset, !env_keep, !setenv\n',
    );
  });

  it('refuses a user name that could inject into the rule', () => {
    expect(() => admin.sudoersForSudo('x ALL=(ALL) NOPASSWD: ALL\nevil')).toThrow(/not a valid user name/);
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

describe('sudo on|off [R20 step 3]', () => {
  function withRunnerKey() {
    const f = fakeSystem({ users: [RUNNER] });
    const keyFile = join(f.root, RUNNER.home, '.aom-runner/secrets/runner-key.pem');
    const keys = new RunnerKeys(keyFile);
    return { ...f, keys };
  }

  it('sets a random password on stdin, writes the password-required rule (visudo-checked, 0440) and seals the password for the runner', async () => {
    const f = withRunnerKey();
    expect(await admin.main(['sudo', 'on'], f.sys)).toBe(0);
    const chpasswd = f.calls.find((c) => c.cmd === 'chpasswd');
    expect(chpasswd?.args).toEqual([]);
    const m = /^guildwise-runner:(\S+)\n$/.exec(chpasswd?.input ?? '');
    expect(m).not.toBeNull();
    const password = m?.[1] as string;
    expect(password.length).toBeGreaterThanOrEqual(32);
    const rule = join(f.root, admin.SUDOERS_SUDO);
    expect(readFileSync(rule, 'utf8')).toContain('guildwise-runner ALL=(ALL) ALL');
    expect(statSync(rule).mode & 0o777).toBe(0o440);
    expect(f.calls.some((c) => c.cmd === 'visudo')).toBe(true);
    const sealed = join(f.root, RUNNER.home, '.aom-runner/secrets/sudo.enc');
    expect(statSync(sealed).mode & 0o777).toBe(0o600);
    expect(f.keys.decrypt(readFileSync(sealed, 'utf8').trim())).toBe(password);
    // the password is never printed, logged or an argument
    expect([...f.out, ...f.err].join('\n')).not.toContain(password);
    expect(f.calls.some((c) => c.args.join(' ').includes(password))).toBe(false);
    expect(f.out.join('\n')).toContain('every such step still needs your local yes');
  });

  it('seals for every pairing of the runner', async () => {
    const f = fakeSystem({ users: [RUNNER] });
    const data = join(f.root, RUNNER.home, '.aom-runner');
    const k1 = new RunnerKeys(join(data, 'secrets/runner-key.pem'));
    const k2 = new RunnerKeys(join(data, 'pairings/uat-1/secrets/runner-key.pem'));
    writeFileSync(
      join(data, 'pairings.json'),
      JSON.stringify({
        version: 1,
        pairings: [{ dir: '.' }, { dir: 'pairings/uat-1' }, { dir: '../../etc' }],
      }),
    );
    expect(await admin.main(['sudo', 'on'], f.sys)).toBe(0);
    const pw = /:(\S+)\n/.exec(f.calls.find((c) => c.cmd === 'chpasswd')?.input ?? '')?.[1];
    expect(k1.decrypt(readFileSync(join(data, 'secrets/sudo.enc'), 'utf8').trim())).toBe(pw);
    expect(k2.decrypt(readFileSync(join(data, 'pairings/uat-1/secrets/sudo.enc'), 'utf8').trim())).toBe(pw);
    expect(existsSync(join(f.root, 'etc/secrets/sudo.enc'))).toBe(false);
  });

  it('refuses without a runner key (nothing changed), and refuses a user other than the dedicated one', async () => {
    const f = fakeSystem({ users: [RUNNER, ALICE] });
    expect(await admin.main(['sudo', 'on'], f.sys)).toBe(1);
    expect(f.err.join('\n')).toContain('no runner key');
    expect(f.calls.some((c) => c.cmd === 'chpasswd')).toBe(false);
    expect(await admin.main(['sudo', 'on', '--user', 'alice'], f.sys)).toBe(1);
    expect(f.err.join('\n')).toContain('seals your own sudo password');
  });

  it('refuses a symlinked key file (no root read through a link the runner planted)', async () => {
    const f = fakeSystem({ users: [RUNNER] });
    const secrets = join(f.root, RUNNER.home, '.aom-runner/secrets');
    mkdirSync(secrets, { recursive: true });
    const real = new RunnerKeys(join(f.root, 'elsewhere/runner-key.pem'));
    expect(real.publicKey.keyId).toBeTruthy();
    symlinkSync(join(f.root, 'elsewhere/runner-key.pem'), join(secrets, 'runner-key.pem'));
    expect(await admin.main(['sudo', 'on'], f.sys)).toBe(1);
    expect(f.err.join('\n')).toContain('not a regular file');
  });

  it('off removes the rule and the sealed password and locks the password', async () => {
    const f = withRunnerKey();
    await admin.main(['sudo', 'on'], f.sys);
    expect(await admin.main(['sudo', 'off'], f.sys)).toBe(0);
    expect(existsSync(join(f.root, admin.SUDOERS_SUDO))).toBe(false);
    expect(existsSync(join(f.root, RUNNER.home, '.aom-runner/secrets/sudo.enc'))).toBe(false);
    expect(f.calls).toContainEqual({ cmd: 'usermod', args: ['-L', 'guildwise-runner'] });
  });
});

describe('docker none|narrow|group [R20 step 4]', () => {
  it('narrow: the helper rule only, and the user leaves the docker group', async () => {
    const f = fakeSystem({ users: [{ ...RUNNER, groups: ['docker'] }] });
    expect(await admin.main(['docker', 'narrow'], f.sys)).toBe(0);
    expect(readFileSync(join(f.root, admin.SUDOERS_DOCKER), 'utf8')).toContain(
      'NOPASSWD: /usr/local/lib/guildwise/deploy-compose',
    );
    expect(f.calls).toContainEqual({ cmd: 'gpasswd', args: ['-d', 'guildwise-runner', 'docker'] });
  });

  it('group needs --accept-root-equivalent, then removes the narrow rule', async () => {
    const f = fakeSystem({ users: [RUNNER] });
    await admin.main(['docker', 'narrow'], f.sys);
    expect(await admin.main(['docker', 'group'], f.sys)).toBe(1);
    expect(f.err.join('\n')).toContain('root-equivalent');
    expect(await admin.main(['docker', 'group', '--accept-root-equivalent'], f.sys)).toBe(0);
    expect(f.calls).toContainEqual({ cmd: 'usermod', args: ['-aG', 'docker', 'guildwise-runner'] });
    expect(existsSync(join(f.root, admin.SUDOERS_DOCKER))).toBe(false);
  });

  it('none removes both', async () => {
    const f = fakeSystem({ users: [RUNNER] });
    await admin.main(['docker', 'narrow'], f.sys);
    expect(await admin.main(['docker', 'none'], f.sys)).toBe(0);
    expect(existsSync(join(f.root, admin.SUDOERS_DOCKER))).toBe(false);
  });
});

describe('approve-app: the installed deploy-compose prepare() computes the pin (W10)', () => {
  const HASH = 'a'.repeat(64);
  /** Installs a stand-in helper at /usr/local/lib/guildwise/deploy-compose that records its calls. */
  function appSystem(behaviour: 'ok' | 'refuse' | 'old', answers?: string[]) {
    const f = fakeSystem({ users: [RUNNER], answers });
    const dir = join(f.root, 'usr/local/lib/guildwise');
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    const log = join(f.root, 'helper-calls.json');
    const body =
      behaviour === 'old'
        ? 'module.exports = {};\n'
        : `const fs = require('node:fs');
module.exports = {
  async prepare(app, folder, opts) {
    fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ app, folder, opts }));
    ${behaviour === 'refuse' ? "throw new Error('the compose config is outside the allowlist: privileged');" : ''}
    return { hash: ${JSON.stringify(HASH)}, pinned: { services: { web: {} } } };
  },
  formatAppConf: ({ source, hash, owner, group }) =>
    '# written by guildwise-admin approve-app\\nsource=' + source + '\\nhash=' + hash + '\\nowner=' + owner + '\\ngroup=' + group + '\\n',
};
`;
    writeFileSync(join(dir, 'deploy-compose'), body, { mode: 0o755 });
    chmodSync(join(dir, 'deploy-compose'), 0o755);
    mkdirSync(join(f.root, RUNNER.home, 'src/shop'), { recursive: true });
    const calls = () => JSON.parse(readFileSync(log, 'utf8'));
    return { ...f, calls, helperFile: join(dir, 'deploy-compose') };
  }

  it("calls prepare() on the clone, shows the pinned config and writes the conf in the helper's format after a yes", async () => {
    const f = appSystem('ok', ['y']);
    expect(
      await admin.main(['approve-app', 'shop', '--source', '/home/guildwise-runner/src/shop'], f.sys),
    ).toBe(0);
    const c = f.calls();
    expect(c.app).toBe('shop');
    expect(c.folder).toBe(join(f.root, '/home/guildwise-runner/src/shop'));
    expect(c.opts).toMatchObject({
      dropPrivileges: true,
      readerUid: RUNNER.uid,
      readerGid: RUNNER.gid,
      readerCommand: [admin.NODE_PATH, f.helperFile],
    });
    const confFile = join(f.root, admin.APPS_CONF_DIR, 'shop.conf');
    expect(admin.parseAppConf(readFileSync(confFile, 'utf8'))).toEqual({
      source: '/home/guildwise-runner/src/shop',
      hash: HASH,
      owner: String(RUNNER.uid),
      group: String(RUNNER.gid),
    });
    expect(statSync(confFile).mode & 0o777).toBe(0o644);
    for (const d of ['/etc/guildwise-runner', admin.APPS_CONF_DIR, '/var/lib/guildwise'])
      expect(statSync(join(f.root, d)).mode & 0o777, d).toBe(0o755);
    expect(f.out.join('\n')).toContain('"web"');
  });

  it('a no writes nothing; a refusal by the helper fails with its reason', async () => {
    const f = appSystem('ok', ['n']);
    expect(
      await admin.main(['approve-app', 'shop', '--source', '/home/guildwise-runner/src/shop'], f.sys),
    ).toBe(1);
    expect(existsSync(join(f.root, admin.APPS_CONF_DIR, 'shop.conf'))).toBe(false);
    const g = appSystem('refuse');
    expect(
      await admin.main(
        ['approve-app', 'shop', '--source', '/home/guildwise-runner/src/shop', '--yes'],
        g.sys,
      ),
    ).toBe(1);
    expect(g.err.join('\n')).toContain('outside the allowlist: privileged');
    expect(existsSync(join(g.root, admin.APPS_CONF_DIR, 'shop.conf'))).toBe(false);
  });

  it('refuses a helper the runner user could have changed (writable, symlink) and one without prepare()', async () => {
    const f = appSystem('ok');
    chmodSync(f.helperFile, 0o777);
    expect(
      await admin.main(
        ['approve-app', 'shop', '--source', '/home/guildwise-runner/src/shop', '--yes'],
        f.sys,
      ),
    ).toBe(1);
    expect(f.err.join('\n')).toContain('must be owned by root, not a symlink and not writable');
    expect(existsSync(join(f.root, 'helper-calls.json'))).toBe(false);
    const g = appSystem('old');
    expect(
      await admin.main(
        ['approve-app', 'shop', '--source', '/home/guildwise-runner/src/shop', '--yes'],
        g.sys,
      ),
    ).toBe(1);
    expect(g.err.join('\n')).toContain('no prepare()');
  });

  it("refuses a folder outside the runner's own clones, a symlink and an app name deploy-compose would refuse", async () => {
    const f = appSystem('ok');
    expect(await admin.main(['approve-app', 'shop', '--source', '/home/alice/shop', '--yes'], f.sys)).toBe(1);
    expect(f.err.join('\n')).toContain('own clones');
    symlinkSync('/etc', join(f.root, RUNNER.home, 'src/etc'));
    expect(
      await admin.main(['approve-app', 'x', '--source', '/home/guildwise-runner/src/etc', '--yes'], f.sys),
    ).toBe(1);
    expect(
      await admin.main(
        ['approve-app', '../x', '--source', '/home/guildwise-runner/src/shop', '--yes'],
        f.sys,
      ),
    ).toBe(1);
    // the same limit as deploy-compose's checkAppName: 48 characters
    expect(
      await admin.main(
        ['approve-app', 'a'.repeat(49), '--source', '/home/guildwise-runner/src/shop', '--yes'],
        f.sys,
      ),
    ).toBe(1);
    expect(existsSync(join(f.root, 'helper-calls.json'))).toBe(false);
    expect(
      await admin.main(
        ['approve-app', 'a'.repeat(48), '--source', '/home/guildwise-runner/src/shop', '--yes'],
        f.sys,
      ),
    ).toBe(0);
  });

  const W10 = join(import.meta.dirname, '../admin/deploy-compose.cjs');
  it.skipIf(!existsSync(W10))(
    'contract with the real deploy-compose (after the W10 merge): exports, name limit, conf format',
    () => {
      const require = createRequire(import.meta.url);
      const dc = require(W10);
      expect(typeof dc.prepare).toBe('function');
      expect(() => dc.checkAppName('a'.repeat(48))).not.toThrow();
      expect(() => dc.checkAppName('a'.repeat(49))).toThrow();
      const source = '/home/guildwise-runner/src/shop';
      const text = dc.formatAppConf({ source, hash: HASH, owner: 1001, group: 1001 });
      expect(dc.parseAppConf(text)).toEqual({ source, hash: HASH, owner: 1001, group: 1001 });
      expect(admin.parseAppConf(text)).toEqual({ source, hash: HASH, owner: '1001', group: '1001' });
      // the approval never names root as the reader
      expect(() => dc.formatAppConf({ source, hash: HASH, owner: 0, group: 1001 })).toThrow(/non-root uid/);
      expect(() => dc.formatAppConf({ source, hash: HASH, owner: 1001, group: 0 })).toThrow(/non-root gid/);
    },
  );
});

describe('verify: root-owned install, sudoers, root PATH [rv6-1]', () => {
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
    for (const file of ['guildwise-admin', 'deploy-compose', 'node/bin/node']) {
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
    chmodSync(join(f.root, 'usr/local/lib/guildwise/deploy-compose'), 0o777);
    f.sys.env.PATH = '/home/guildwise-runner/.local/bin:/usr/bin';
    expect(await admin.main(['verify'], f.sys)).toBe(1);
    const e = f.err.join('\n');
    expect(e).toContain('/usr/local/lib/guildwise/deploy-compose is writable by group or others');
    expect(e).toContain("root's PATH includes the runner's HOME");
    const g = installed();
    g.sys.rootUid = 12345;
    expect(await admin.main(['verify'], g.sys)).toBe(1);
    expect(g.err.join('\n')).toContain('/usr/local/lib/guildwise is not owned by root');
  });

  it('flags a sudoers file that is not 0440 or does not pass visudo, and a secure_path into the runner HOME', async () => {
    const f = installed();
    mkdirSync(join(f.root, 'etc/sudoers.d'), { recursive: true });
    writeFileSync(join(f.root, admin.SUDOERS_DOCKER), 'this is not sudoers\n', { mode: 0o644 });
    writeFileSync(
      join(f.root, 'etc/sudoers'),
      'Defaults secure_path="/home/guildwise-runner/bin:/usr/bin"\n',
    );
    expect(await admin.main(['verify'], f.sys)).toBe(1);
    const e = f.err.join('\n');
    expect(e).toContain('must be mode 0440');
    expect(e).toContain('does not pass visudo -cf');
    expect(e).toContain('/home/guildwise-runner/bin');
  });
});

describe('apply: the installer flags [R20 non-interactive]', () => {
  it('--sudo on on a fresh install (no runner key yet) prints the deferred command and still sets up Docker', async () => {
    const f = fakeSystem();
    expect(await admin.main(['apply', '--yes', '--sudo', 'on', '--docker', 'narrow'], f.sys)).toBe(0);
    expect(f.calls.some((c) => c.cmd === 'chpasswd')).toBe(false);
    expect(f.out.join('\n')).toContain('run `sudo /usr/local/lib/guildwise/guildwise-admin sudo on`');
    expect(existsSync(join(f.root, admin.SUDOERS_DOCKER))).toBe(true);
  });

  it('user create and sudo off refuse any account but the dedicated one', async () => {
    const f = fakeSystem({ users: [RUNNER, ALICE] });
    expect(await admin.main(['user', 'create', '--user', 'alice'], f.sys)).toBe(1);
    expect(await admin.main(['sudo', 'off', '--user', 'alice'], f.sys)).toBe(1);
    expect(f.calls.some((c) => c.cmd === 'gpasswd' || c.cmd === 'usermod')).toBe(false);
  });

  it('--yes alone: dedicated user and its service, sudo off, no Docker', async () => {
    const f = fakeSystem();
    expect(await admin.main(['apply', '--yes'], f.sys)).toBe(0);
    expect(f.calls.some((c) => c.cmd === 'useradd')).toBe(true);
    expect(existsSync(join(f.root, admin.SYSTEMD_UNIT))).toBe(true);
    expect(existsSync(join(f.root, admin.SUDOERS_SUDO))).toBe(false);
    expect(existsSync(join(f.root, admin.SUDOERS_DOCKER))).toBe(false);
    expect(f.calls.some((c) => c.cmd === 'chpasswd')).toBe(false);
  });

  it('refuses docker group without the acceptance, and approve-app without narrow', async () => {
    const f = fakeSystem({ users: [RUNNER] });
    expect(await admin.main(['apply', '--yes', '--docker', 'group'], f.sys)).toBe(1);
    expect(
      await admin.main(['apply', '--yes', '--approve-app', 'shop=/home/guildwise-runner/src/shop'], f.sys),
    ).toBe(1);
    expect(f.calls.some((c) => c.cmd === 'useradd')).toBe(false);
  });

  it('current user with docker narrow names that user in the rule', async () => {
    const f = fakeSystem({ users: [ALICE] });
    expect(
      await admin.main(['apply', '--runner-user', 'current', '--user', 'alice', '--docker', 'narrow'], f.sys),
    ).toBe(0);
    expect(readFileSync(join(f.root, admin.SUDOERS_DOCKER), 'utf8')).toContain('alice ALL=(root) NOPASSWD:');
  });
});
