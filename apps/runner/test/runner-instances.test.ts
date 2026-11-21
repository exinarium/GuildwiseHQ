import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type * as DeployCompose from '../admin/deploy-compose.cjs';
import {
  decideStartup,
  foreignPolicyReason,
  type HostFacts,
  writableByOthers,
} from '../src/policy/startup.ts';
import {
  adminCommand,
  dedicatedUserOf,
  INSTANCE_RE,
  instanceOfUser,
  instanceStartupPaths,
  isDedicatedUser,
} from '../src/setup/admin-command.ts';
import { parseSetupOptions } from '../src/setup/options.ts';
import { ALICE, admin, type FakeSys, type FakeUser, fakeSystem, RUNNER } from './admin/fake-system.ts';

/*
 * Named runner instances: two runners on one machine (one paired with UAT, one with production), each with its own
 * user, service, CA copy, sudoers rules, readers group, migration marker and approved apps. Everything runs against the
 * fake system (temp root, recorded commands): no root, no real users, no real install.
 */

const dc = createRequire(import.meta.url)('../admin/deploy-compose.cjs') as typeof DeployCompose;
const UAT: FakeUser = {
  name: 'guildwise-runner-uat',
  uid: 991,
  gid: 991,
  home: '/home/guildwise-runner-uat',
};
const PROD: FakeUser = {
  name: 'guildwise-runner-prod',
  uid: 992,
  gid: 992,
  home: '/home/guildwise-runner-prod',
};
const PEM = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n';

const cleanups: string[] = [];
afterEach(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});

function machine(opts: Parameters<typeof fakeSystem>[0] = {}) {
  const f = fakeSystem({ users: [UAT, PROD], ...opts });
  cleanups.push(f.root);
  for (const u of opts.users ?? [UAT, PROD]) mkdirSync(join(f.root, u.home, 'src'), { recursive: true });
  return f;
}

const read = (root: string, p: string) => readFileSync(join(root, p), 'utf8');

/** Runs guildwise-admin as the instance's own copy would run: under that instance's bundled Node. */
async function adm(args: string[], sys: FakeSys): Promise<number> {
  const i = args.indexOf('--instance');
  const eq = args.find((a) => a.startsWith('--instance='));
  const name = i >= 0 ? args[i + 1] : eq?.slice('--instance='.length);
  try {
    sys.execPath = admin.instanceLayout(name ?? null).nodePath;
  } catch {
    sys.execPath = admin.NODE_PATH;
  }
  return admin.main(args, sys);
}

describe('instance layout', () => {
  it('without an instance: exactly the names and paths of the single runner', () => {
    const L = admin.instanceLayout(null);
    expect(L).toMatchObject({
      instance: null,
      user: 'guildwise-runner',
      service: 'guildwise-runner',
      systemdUnit: admin.SYSTEMD_UNIT,
      launchdPlist: admin.LAUNCHD_PLIST,
      sudoersSudo: admin.SUDOERS_SUDO,
      sudoersDocker: admin.SUDOERS_DOCKER,
      appsConfDir: admin.APPS_CONF_DIR,
      caFile: admin.RUNNER_CA_FILE,
      migrateMarker: admin.MIGRATE_MARKER,
      readersGroup: admin.READERS_GROUP,
      flag: [],
    });
  });

  it('uat, prod and the single runner share no name or path', () => {
    const sets = [null, 'uat', 'prod'].map((n) => admin.instanceLayout(n));
    for (const key of Object.keys(sets[0]).filter((k) => !['instance', 'flag'].includes(k))) {
      const values = sets.map((L: Record<string, string>) => L[key]);
      expect(new Set(values).size, key).toBe(3);
    }
    // the instance's sudoers files can never be another runner's (no underscore in user or instance names)
    expect(admin.instanceLayout('docker').sudoersSudo).not.toBe(admin.SUDOERS_DOCKER);
    expect(admin.instanceLayout('uat').sudoersSudo).toBe('/etc/sudoers.d/guildwise-runner-uat_sudo');
  });

  it.each(['UAT', 'a_b', '-x', 'x-', '../x', 'a b', 'abcdefghijklmnop', 'node', 'deploy-compose', ''])(
    'refuses the instance name %j',
    async (name) => {
      const f = machine();
      if (name === '') {
        // an empty value means no instance: the single runner
        expect(admin.instanceLayout(name).instance).toBeNull();
        return;
      }
      expect(await adm([`--instance=${name}`, 'user', 'create'], f.sys)).toBe(64);
      expect(f.err.join('\n')).toContain('not a valid instance name');
      expect(f.calls.find((c) => c.cmd === 'useradd')).toBeUndefined();
    },
  );

  it('keeps one rule for instance names in guildwise-admin, deploy-compose and the runner', () => {
    expect(String(dc.INSTANCE_RE)).toBe(String(admin.INSTANCE_RE));
    expect(String(INSTANCE_RE)).toBe(String(admin.INSTANCE_RE));
    expect('guildwise-runner-'.length + 15).toBeLessThanOrEqual(32);
  });
});

describe('two instances side by side (Linux)', () => {
  it('user create makes guildwise-runner-uat and guildwise-runner-prod, each HOME 0700', async () => {
    const f = machine({ users: [] });
    expect(await adm(['user', 'create', '--instance', 'uat'], f.sys)).toBe(0);
    expect(await adm(['--instance', 'prod', 'user', 'create'], f.sys)).toBe(0);
    const added = f.calls.filter((c) => c.cmd === 'useradd').map((c) => c.args.at(-1));
    expect(added).toEqual(['guildwise-runner-uat', 'guildwise-runner-prod']);
    for (const h of ['/home/guildwise-runner-uat', '/home/guildwise-runner-prod']) {
      expect(statSync(join(f.root, h)).mode & 0o777).toBe(0o700);
      expect(statSync(join(f.root, h, 'src')).mode & 0o777).toBe(0o700);
    }
    expect(existsSync(join(f.root, '/home/guildwise-runner'))).toBe(false);
  });

  it('user create --instance uat refuses any other account (never a person, never the other instance)', async () => {
    const f = machine();
    expect(await adm(['user', 'create', '--instance', 'uat', '--user', 'guildwise-runner-prod'], f.sys)).toBe(
      1,
    );
    expect(f.err.join('\n')).toContain('only for the dedicated guildwise-runner-uat user');
  });

  it('service install: its own unit, user, runner root and CA copy per instance', async () => {
    const f = machine();
    writeFileSync(join(f.root, 'uat-ca.pem'), PEM);
    expect(
      await adm(['service', 'install', '--instance', 'uat', '--ca-file', '/uat-ca.pem', '--start'], f.sys),
    ).toBe(0);
    expect(await adm(['service', 'install', '--instance', 'prod', '--start'], f.sys)).toBe(0);
    const uat = read(f.root, '/etc/systemd/system/guildwise-runner-uat.service');
    const prod = read(f.root, '/etc/systemd/system/guildwise-runner-prod.service');
    expect(uat).toContain('User=guildwise-runner-uat\n');
    expect(uat).toContain(
      'ExecStart="/home/guildwise-runner-uat/.local/share/guildwise/runner/current/aom-runner" start',
    );
    expect(uat).toContain('Environment="NODE_EXTRA_CA_CERTS=/etc/guildwise-runner-uat/ca.pem"');
    expect(uat).toContain('Description=Guildwise runner uat (user guildwise-runner-uat)');
    expect(prod).toContain('User=guildwise-runner-prod\n');
    // the UAT CA is never trusted by the production runner
    expect(prod).not.toContain('NODE_EXTRA_CA_CERTS');
    expect(read(f.root, '/etc/guildwise-runner-uat/ca.pem')).toBe(PEM);
    expect(existsSync(join(f.root, admin.RUNNER_CA_FILE))).toBe(false);
    expect(existsSync(join(f.root, admin.SYSTEMD_UNIT))).toBe(false);
    expect(f.calls).toContainEqual({ cmd: 'systemctl', args: ['enable', '--now', 'guildwise-runner-uat'] });
    expect(f.calls).toContainEqual({ cmd: 'systemctl', args: ['enable', '--now', 'guildwise-runner-prod'] });
  });

  it("service install refuses the other instance's user and a runner root outside the instance's HOME", async () => {
    const f = machine();
    expect(
      await adm(['service', 'install', '--instance', 'uat', '--user', 'guildwise-runner-prod'], f.sys),
    ).toBe(1);
    expect(f.err.join('\n')).toContain('runs only as guildwise-runner-uat');
    expect(
      await adm(
        ['service', 'install', '--instance', 'uat', '--runner-root', '/home/guildwise-runner-prod/runner'],
        f.sys,
      ),
    ).toBe(1);
    expect(f.err.join('\n')).toContain('must be inside /home/guildwise-runner-uat');
    expect(existsSync(join(f.root, '/etc/systemd/system/guildwise-runner-uat.service'))).toBe(false);
  });

  it('service remove takes only its own instance down', async () => {
    const f = machine();
    await adm(['service', 'install', '--instance', 'uat'], f.sys);
    await adm(['service', 'install', '--instance', 'prod'], f.sys);
    expect(await adm(['service', 'remove', '--instance', 'uat'], f.sys)).toBe(0);
    expect(existsSync(join(f.root, '/etc/systemd/system/guildwise-runner-uat.service'))).toBe(false);
    expect(existsSync(join(f.root, '/etc/systemd/system/guildwise-runner-prod.service'))).toBe(true);
    expect(f.calls).toContainEqual({ cmd: 'systemctl', args: ['disable', '--now', 'guildwise-runner-uat'] });
    expect(f.calls.some((c) => c.args.includes('guildwise-runner-prod') && c.args.includes('disable'))).toBe(
      false,
    );
  });

  it('sudo and Docker rules: one sudoers file each, naming only that instance user (visudo-checked)', async () => {
    const f = machine();
    expect(await adm(['docker', 'narrow', '--instance', 'uat'], f.sys)).toBe(0);
    expect(await adm(['docker', 'narrow', '--instance', 'prod'], f.sys)).toBe(0);
    const uat = read(f.root, '/etc/sudoers.d/guildwise-runner-uat_docker');
    const prod = read(f.root, '/etc/sudoers.d/guildwise-runner-prod_docker');
    expect(uat).toContain(
      'guildwise-runner-uat ALL=(root) NOPASSWD: /usr/local/lib/guildwise/uat/deploy-compose\n',
    );
    expect(uat).toContain(
      'Defaults!/usr/local/lib/guildwise/uat/deploy-compose env_reset, !env_keep, !setenv\n',
    );
    expect(prod).toContain(
      'guildwise-runner-prod ALL=(root) NOPASSWD: /usr/local/lib/guildwise/prod/deploy-compose\n',
    );
    expect(uat).not.toMatch(/NOPASSWD: \/usr\/local\/lib\/guildwise\/deploy-compose/);
    expect(uat).not.toContain('guildwise-runner-prod');
    expect(prod).not.toContain('guildwise-runner-uat');
    expect(existsSync(join(f.root, admin.SUDOERS_DOCKER))).toBe(false);
    expect(await adm(['docker', 'none', '--instance', 'uat'], f.sys)).toBe(0);
    expect(existsSync(join(f.root, '/etc/sudoers.d/guildwise-runner-uat_docker'))).toBe(false);
    expect(existsSync(join(f.root, '/etc/sudoers.d/guildwise-runner-prod_docker'))).toBe(true);
    // the other instance's user is refused
    expect(
      await adm(['docker', 'narrow', '--instance', 'uat', '--user', 'guildwise-runner-prod'], f.sys),
    ).toBe(1);
  });

  it("sudo on/off: the instance's own sudoers file and its own pairings' sealed password", async () => {
    const f = machine();
    // no runner key yet: refused with the instance's own hints
    expect(await adm(['sudo', 'on', '--instance', 'uat'], f.sys)).toBe(1);
    expect(f.err.join('\n')).toContain('no runner key under /home/guildwise-runner-uat/.aom-runner');
    expect(await adm(['sudo', 'off', '--instance', 'uat'], f.sys)).toBe(0);
    expect(f.calls).toContainEqual({ cmd: 'usermod', args: ['-L', 'guildwise-runner-uat'] });
    expect(f.calls.some((c) => c.args.includes('guildwise-runner-prod'))).toBe(false);
    expect(await adm(['sudo', 'off', '--instance', 'uat', '--user', 'guildwise-runner-prod'], f.sys)).toBe(1);
  });

  it('readers: a group per instance; a runner user can never read another runner', async () => {
    const f = machine({ users: [UAT, PROD, ALICE] });
    expect(await adm(['readers', 'add', 'alice', '--instance', 'uat'], f.sys)).toBe(0);
    expect(f.calls).toContainEqual({ cmd: 'groupadd', args: ['--system', 'guildwise-readers-uat'] });
    expect(f.calls).toContainEqual({ cmd: 'usermod', args: ['-aG', 'guildwise-readers-uat', 'alice'] });
    expect(await adm(['readers', 'add', 'guildwise-runner-prod', '--instance', 'uat'], f.sys)).toBe(1);
    expect(f.err.join('\n')).toContain("runners never read each other's clones");
  });

  it('apply --instance: the dedicated user and service of that instance; current mode is refused', async () => {
    const f = machine({ users: [] });
    expect(await adm(['apply', '--yes', '--instance', 'uat'], f.sys)).toBe(0);
    expect(f.calls.find((c) => c.cmd === 'useradd')?.args.at(-1)).toBe('guildwise-runner-uat');
    expect(existsSync(join(f.root, '/etc/systemd/system/guildwise-runner-uat.service'))).toBe(true);
    const g = machine();
    expect(
      await adm(['apply', '--instance', 'uat', '--runner-user', 'current', '--user', 'alice'], g.sys),
    ).toBe(1);
    expect(g.err.join('\n')).toContain('--instance needs the dedicated runner user');
  });

  it('verify checks the sudoers files of its own instance', async () => {
    const f = machine();
    await adm(['docker', 'narrow', '--instance', 'uat'], f.sys);
    chmodSync(join(f.root, '/etc/sudoers.d/guildwise-runner-uat_docker'), 0o644);
    await adm(['verify', '--instance', 'uat'], f.sys);
    expect(f.err.join('\n')).toContain('/etc/sudoers.d/guildwise-runner-uat_docker must be mode 0440');
    const before = f.err.length;
    await adm(['verify', '--instance', 'prod'], f.sys);
    expect(f.err.slice(before).join('\n')).not.toContain('guildwise-runner-uat_docker');
  });
});

describe('migrate-user per instance', () => {
  it("a waiting migration of one runner does not block another's; never from a runner user", async () => {
    const f = machine({ users: [UAT, PROD, ALICE, RUNNER] });
    mkdirSync(dirname(join(f.root, admin.MIGRATE_MARKER)), { recursive: true });
    writeFileSync(join(f.root, admin.MIGRATE_MARKER), '{}');
    expect(await adm(['migrate-user', '--from', 'alice'], f.sys)).toBe(1);
    expect(f.err.join('\n')).toContain('a migration is waiting for --finish');
    const before = f.err.length;
    expect(await adm(['migrate-user', '--instance', 'uat', '--from', 'alice'], f.sys)).toBe(1);
    // got past the marker check: the default runner's marker is not the instance's
    expect(f.err.slice(before).join('\n')).toContain('no runner data at /home/alice/.aom-runner');
    expect(await adm(['migrate-user', '--instance', 'uat', '--from', 'guildwise-runner-prod'], f.sys)).toBe(
      1,
    );
    expect(f.err.join('\n')).toContain("one runner's data is never moved into another");
    expect(
      await adm(
        ['migrate-user', '--instance', 'uat', '--from', 'alice', '--to', 'guildwise-runner-prod'],
        f.sys,
      ),
    ).toBe(1);
    expect(f.err.join('\n')).toContain('migrates only into guildwise-runner-uat');
    expect(await adm(['migrate-user', '--instance', 'uat', '--finish'], f.sys)).toBe(1);
    expect(f.err.join('\n')).toContain('no migration is waiting to be finished');
  });
});

describe('macOS: a LaunchDaemon and hidden user per instance', () => {
  it('label com.guildwisehq.runner.<name>, home /var/guildwise-runner-<name>, its own log', async () => {
    const MUAT: FakeUser = { ...UAT, home: '/var/guildwise-runner-uat' };
    const f = machine({
      platform: 'darwin',
      users: [MUAT],
      handle: (c) =>
        c.cmd === 'dscl' && c.args[1] === '-read' && c.args[2] === '/Users/guildwise-runner-uat'
          ? {
              code: 0,
              stdout: 'UniqueID: 498\nPrimaryGroupID: 20\nNFSHomeDirectory: /var/guildwise-runner-uat\n',
              stderr: '',
            }
          : undefined,
    });
    expect(await adm(['service', 'install', '--instance', 'uat', '--start'], f.sys)).toBe(0);
    const plist = read(f.root, '/Library/LaunchDaemons/com.guildwisehq.runner.uat.plist');
    expect(plist).toContain('<key>Label</key><string>com.guildwisehq.runner.uat</string>');
    expect(plist).toContain('<key>UserName</key><string>guildwise-runner-uat</string>');
    expect(plist).toContain('/var/guildwise-runner-uat/Library/Logs/guildwise-runner-uat.log');
    expect(existsSync(join(f.root, admin.LAUNCHD_PLIST))).toBe(false);
    expect(f.calls).toContainEqual({
      cmd: 'launchctl',
      args: ['kickstart', '-k', 'system/com.guildwisehq.runner.uat'],
    });
    expect(admin.instanceLayout('uat').macHome).toBe('/var/guildwise-runner-uat');
  });
});

describe('approve-app per instance (W10)', () => {
  const HASH = 'b'.repeat(64);
  function appMachine() {
    const f = machine();
    const top = join(f.root, 'usr/local/lib/guildwise');
    const dir = join(top, 'uat');
    mkdirSync(dir, { recursive: true });
    chmodSync(top, 0o755);
    chmodSync(dir, 0o755);
    // the top-level helper (another trust domain) must never be loaded for instance uat
    writeFileSync(join(top, 'deploy-compose'), "throw new Error('top-level helper loaded');\n", {
      mode: 0o755,
    });
    chmodSync(join(top, 'deploy-compose'), 0o755);
    const log = join(f.root, 'helper-calls.json');
    writeFileSync(
      join(dir, 'deploy-compose'),
      `const fs = require('node:fs');
module.exports = {
  async prepare(app, folder, opts) { fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ app, folder, opts })); return { hash: ${JSON.stringify(HASH)}, pinned: {} }; },
  formatAppConf: ({ source, hash, owner, group }) => 'source=' + source + '\\nhash=' + hash + '\\nowner=' + owner + '\\ngroup=' + group + '\\n',
};
`,
      { mode: 0o755 },
    );
    chmodSync(join(dir, 'deploy-compose'), 0o755);
    mkdirSync(join(f.root, UAT.home, 'src/shop'), { recursive: true });
    mkdirSync(join(f.root, PROD.home, 'src/shop'), { recursive: true });
    return { ...f, calls2: () => JSON.parse(readFileSync(log, 'utf8')) };
  }

  it("writes the approval into the instance's own folder, with its project prefix and its own user as owner", async () => {
    const f = appMachine();
    expect(
      await adm(
        [
          'approve-app',
          'shop',
          '--instance',
          'uat',
          '--source',
          '/home/guildwise-runner-uat/src/shop',
          '--yes',
        ],
        f.sys,
      ),
    ).toBe(0);
    const c = f.calls2();
    expect(c.opts).toMatchObject({
      readerUid: UAT.uid,
      readerCommand: [
        '/usr/local/lib/guildwise/uat/node/bin/node',
        join(f.root, '/usr/local/lib/guildwise/uat/deploy-compose'),
      ],
      confDir: join(f.root, '/etc/guildwise-runner-uat/apps'),
      stateDir: join(f.root, '/var/lib/guildwise/apps-uat'),
      projectPrefix: 'guildwise_uat_',
    });
    expect(admin.parseAppConf(read(f.root, '/etc/guildwise-runner-uat/apps/shop.conf'))).toMatchObject({
      owner: String(UAT.uid),
    });
    expect(existsSync(join(f.root, admin.APPS_CONF_DIR, 'shop.conf'))).toBe(false);
  });

  it("refuses the other instance's user or clone", async () => {
    const f = appMachine();
    expect(
      await adm(
        [
          'approve-app',
          'shop',
          '--instance',
          'uat',
          '--source',
          '/home/guildwise-runner-prod/src/shop',
          '--yes',
        ],
        f.sys,
      ),
    ).toBe(1);
    expect(f.err.join('\n')).toContain("must be one of guildwise-runner-uat's own clones");
    expect(
      await adm(
        [
          'approve-app',
          'shop',
          '--instance',
          'uat',
          '--user',
          'guildwise-runner-prod',
          '--source',
          '/home/guildwise-runner-prod/src/shop',
          '--yes',
        ],
        f.sys,
      ),
    ).toBe(1);
    expect(f.err.join('\n')).toContain('approved only for guildwise-runner-uat');
  });
});

describe('deploy-compose: each caller sees only its own instance', () => {
  it('derives the paths from the SUDO_USER and SUDO_UID sudo sets', () => {
    expect(dc.instanceOptions({ SUDO_USER: 'guildwise-runner-uat', SUDO_UID: '991' })).toEqual({
      confDir: '/etc/guildwise-runner-uat/apps',
      stateDir: '/var/lib/guildwise/apps-uat',
      projectPrefix: 'guildwise_uat_',
      callerUid: 991,
      adminCommand: 'sudo /usr/local/lib/guildwise/uat/guildwise-admin --instance uat',
      toolsDir: '/usr/local/lib/guildwise/uat',
    });
    // the single runner, a person, root: the defaults, as before
    for (const env of [{ SUDO_USER: 'guildwise-runner', SUDO_UID: '990' }, { SUDO_USER: 'alice' }, {}])
      expect(dc.instanceOptions(env)).toEqual({});
    for (const env of [
      { SUDO_USER: 'guildwise-runner-UAT', SUDO_UID: '991' },
      { SUDO_USER: 'guildwise-runner-uat', SUDO_UID: '0' },
      { SUDO_USER: 'guildwise-runner-uat' },
    ])
      expect(() => dc.instanceOptions(env)).toThrow(/not a runner instance/);
  });

  it("refuses an approval whose owner is not the calling instance's uid (no running the other's apps)", async () => {
    const base = mkdtempSync(join(tmpdir(), 'dc-inst-'));
    cleanups.push(base);
    const confDir = join(base, 'etc/guildwise-runner-uat/apps');
    mkdirSync(confDir, { recursive: true });
    chmodSync(dirname(confDir), 0o755);
    chmodSync(confDir, 0o755);
    const src = join(base, 'src');
    mkdirSync(src);
    writeFileSync(
      join(confDir, 'shop.conf'),
      dc.formatAppConf({
        source: src,
        hash: 'c'.repeat(64),
        owner: process.getuid!(),
        group: process.getgid!(),
      }),
    );
    chmodSync(join(confDir, 'shop.conf'), 0o644);
    await expect(
      dc.deploy('shop', 'up', {
        confDir,
        stateDir: join(base, 'state'),
        docker: '/bin/false',
        rootUid: process.getuid!(),
        dropPrivileges: false,
        homeDir: homedir(),
        readerCommand: [process.execPath, 'x'],
        callerUid: process.getuid!() + 1,
      }),
    ).rejects.toMatchObject({
      exitCode: dc.EXIT.ENV,
      message: expect.stringContaining('not approved for this'),
    });
    expect(existsSync(join(base, 'state'))).toBe(false);
  });
});

describe('the runner side: setup and the start-up check', () => {
  it('names instance users and commands; without an instance the commands are as before', () => {
    expect(dedicatedUserOf(null)).toBe('guildwise-runner');
    expect(dedicatedUserOf('uat')).toBe('guildwise-runner-uat');
    expect(instanceOfUser('guildwise-runner-prod')).toBe('prod');
    expect(instanceOfUser('guildwise-runner')).toBeNull();
    expect(instanceOfUser('guildwise-runner-Bad')).toBeNull();
    expect(isDedicatedUser('guildwise-runner-uat')).toBe(true);
    expect(isDedicatedUser('alice')).toBe(false);
    expect(adminCommand(['sudo', 'on'])).toBe('sudo /usr/local/lib/guildwise/guildwise-admin sudo on');
    expect(adminCommand(['sudo', 'on'], 'uat')).toBe(
      'sudo /usr/local/lib/guildwise/uat/guildwise-admin --instance uat sudo on',
    );
    expect(instanceStartupPaths('guildwise-runner-uat')).toEqual([
      '/etc/guildwise-runner-uat',
      '/usr/local/lib/guildwise/uat',
    ]);
    expect(instanceOfUser('guildwise-runner-node')).toBeNull();
    expect(instanceStartupPaths('guildwise-runner')).toEqual([]);
    expect(instanceStartupPaths('alice')).toEqual([]);
  });

  it('setup --instance is validated', () => {
    expect(parseSetupOptions({ instance: 'uat' }, {}).instance).toBe('uat');
    expect(parseSetupOptions({}, {}).instance).toBeUndefined();
    expect(() => parseSetupOptions({ instance: 'U_AT' }, {})).toThrow(/--instance takes/);
  });

  const clean: HostFacts = {
    uid: 991,
    passwordlessSudo: false,
    groups: [],
    writableDockerSocket: null,
    writableByOthers: [],
    user: 'guildwise-runner-prod',
  };

  it("treats the other instance's policy.json as foreign: refused with the refusal on, a warning otherwise", () => {
    const uatPolicy = { runnerUser: { mode: 'dedicated' as const, name: 'guildwise-runner-uat' } };
    expect(foreignPolicyReason(uatPolicy, 'guildwise-runner-prod')).toContain(
      'belongs to the runner user guildwise-runner-uat, not guildwise-runner-prod',
    );
    expect(
      decideStartup({
        facts: clean,
        policy: { ...uatPolicy, startupRefusal: true, acceptRootEquivalent: true },
        serverRequiresSigned: false,
      }),
    ).toMatchObject({ action: 'refuse', reason: expect.stringContaining("another runner instance's files") });
    expect(
      decideStartup({
        facts: clean,
        policy: { ...uatPolicy, acceptRootEquivalent: false },
        serverRequiresSigned: false,
      }),
    ).toMatchObject({ action: 'warn' });
    // its own policy, a current-user policy, or an unknown user: as before
    for (const policy of [
      { runnerUser: { mode: 'dedicated' as const, name: 'guildwise-runner-prod' } },
      { runnerUser: { mode: 'current' as const, name: 'alice' } },
      {},
    ])
      expect(
        decideStartup({
          facts: clean,
          policy: { ...policy, startupRefusal: true, acceptRootEquivalent: false },
          serverRequiresSigned: false,
        }),
      ).toEqual({ action: 'ok' });
    expect(
      decideStartup({
        facts: { ...clean, user: undefined },
        policy: { ...uatPolicy, startupRefusal: true, acceptRootEquivalent: false },
        serverRequiresSigned: false,
      }),
    ).toEqual({ action: 'ok' });
  });

  it("a file owned by the other instance's user counts as writable by another user", () => {
    const dir = mkdtempSync(join(tmpdir(), 'inst-own-'));
    cleanups.push(dir);
    const f = join(dir, 'policy.json');
    writeFileSync(f, '{}', { mode: 0o600 });
    const me = process.getuid!();
    // owned by "me": fine for me, foreign to any other runner uid
    expect(writableByOthers(f, me)).toBe(false);
    expect(writableByOthers(f, me + 1)).toBe(me !== 0);
  });

  it('the start-up check source lists the instance paths', () => {
    const cli = readFileSync(join(import.meta.dirname, '../src/cli.ts'), 'utf8');
    expect(cli).toContain('...instanceStartupPaths()');
  });
});

describe('compose names: an instance never shares a project, volume or network with the single runner', () => {
  it('instances use guildwise_<name>_, the single runner keeps guildwise-<app>', () => {
    expect(admin.instanceLayout(null).composePrefix).toBe('guildwise-');
    expect(admin.instanceLayout('uat').composePrefix).toBe('guildwise_uat_');
    expect(dc.instanceOptions({ SUDO_USER: 'guildwise-runner-uat', SUDO_UID: '991' }).projectPrefix).toBe(
      'guildwise_uat_',
    );
    // the review's case: the single runner's app `uat` with volume `web_data`, instance uat's app `web` with `data`
    const single = `${admin.instanceLayout(null).composePrefix}uat_web_data`;
    const inst = `${admin.instanceLayout('uat').composePrefix}web_data`;
    expect(single).toBe('guildwise-uat_web_data');
    expect(inst).toBe('guildwise_uat_web_data');
    expect(single).not.toBe(inst);
    // disjoint sets: every default name starts guildwise-, every instance name guildwise_, and two instances part at
    // the first _ after the prefix (instance names have none)
    for (const n of ['uat', 'prod', 'a-b'])
      expect(admin.instanceLayout(n).composePrefix.startsWith('guildwise_')).toBe(true);
    expect(admin.instanceLayout('a').composePrefix).not.toBe(admin.instanceLayout('a-b').composePrefix);
  });
});

describe('each instance has its own root-owned tools (separate trust domains)', () => {
  it('layout: /usr/local/lib/guildwise/<name>/ for an instance, the top-level folder without one', () => {
    expect(admin.instanceLayout('uat')).toMatchObject({
      toolsDir: '/usr/local/lib/guildwise/uat',
      adminPath: '/usr/local/lib/guildwise/uat/guildwise-admin',
      deployCompose: '/usr/local/lib/guildwise/uat/deploy-compose',
      nodePath: '/usr/local/lib/guildwise/uat/node/bin/node',
    });
    expect(admin.instanceLayout(null)).toMatchObject({
      toolsDir: admin.ADMIN_DIR,
      adminPath: admin.SELF_PATH,
      deployCompose: admin.DEPLOY_COMPOSE,
      nodePath: admin.NODE_PATH,
    });
    expect(admin.toolsInstance('/usr/local/lib/guildwise/uat/node/bin/node')).toBe('uat');
    expect(admin.toolsInstance(admin.NODE_PATH)).toBeNull();
    expect(admin.toolsInstance('/usr/local/lib/guildwise/x/y/node/bin/node')).toBeNull();
  });

  it('the top-level guildwise-admin refuses to manage an instance', async () => {
    const f = machine({ users: [] });
    f.sys.execPath = admin.NODE_PATH;
    expect(await admin.main(['--instance', 'uat', 'user', 'create'], f.sys)).toBe(2);
    expect(f.err.join('\n')).toContain(
      'runs only under the bundled Node at /usr/local/lib/guildwise/uat/node/bin/node',
    );
    expect(f.err.join('\n')).toContain('sudo /usr/local/lib/guildwise/uat/guildwise-admin');
    expect(f.calls.find((c) => c.cmd === 'useradd')).toBeUndefined();
  });

  it("an instance's copy refuses another instance, and manages its own without --instance", async () => {
    const f = machine({ users: [] });
    f.sys.execPath = '/usr/local/lib/guildwise/uat/node/bin/node';
    expect(await admin.main(['--instance', 'prod', 'user', 'create'], f.sys)).toBe(2);
    expect(f.calls.find((c) => c.cmd === 'useradd')).toBeUndefined();
    expect(await admin.main(['user', 'create'], f.sys)).toBe(0);
    expect(f.calls.find((c) => c.cmd === 'useradd')?.args.at(-1)).toBe('guildwise-runner-uat');
  });

  it("verify checks the instance's own tools folder, not the other's", async () => {
    const f = machine();
    for (const d of [
      'usr',
      'usr/local',
      'usr/local/lib',
      'usr/local/lib/guildwise',
      'usr/local/lib/guildwise/prod',
    ])
      mkdirSync(join(f.root, d), { recursive: true, mode: 0o755 });
    await adm(['verify', '--instance', 'uat'], f.sys);
    const errs = f.err.join('\n');
    expect(errs).toContain('/usr/local/lib/guildwise/uat is missing');
    expect(errs).toContain('/usr/local/lib/guildwise/uat/guildwise-admin is missing');
    expect(errs).not.toContain('/usr/local/lib/guildwise/prod');
  });

  it("deploy-compose runs only as the copy in the calling instance's own folder, under its own Node", () => {
    const uatEnv = { SUDO_USER: 'guildwise-runner-uat', SUDO_UID: '991' };
    expect(dc.cliOptions(uatEnv, '/usr/local/lib/guildwise/uat/deploy-compose')).toMatchObject({
      nodeBin: '/usr/local/lib/guildwise/uat/node/bin/node',
      confDir: '/etc/guildwise-runner-uat/apps',
    });
    expect(() => dc.cliOptions(uatEnv, '/usr/local/lib/guildwise/deploy-compose')).toThrow(/does not serve/);
    expect(() => dc.cliOptions(uatEnv, '/usr/local/lib/guildwise/prod/deploy-compose')).toThrow(
      /does not serve/,
    );
    expect(
      dc.cliOptions({ SUDO_USER: 'guildwise-runner' }, '/usr/local/lib/guildwise/deploy-compose'),
    ).toEqual({
      nodeBin: '/usr/local/lib/guildwise/node/bin/node',
    });
    expect(() =>
      dc.cliOptions({ SUDO_USER: 'guildwise-runner' }, '/usr/local/lib/guildwise/uat/deploy-compose'),
    ).toThrow(/does not serve/);
  });
});
