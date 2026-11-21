import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALICE, admin, fakeSystem, RUNNER } from './admin/fake-system.ts';

const OLD = '/home/alice/.aom-runner';
const NEW = '/home/guildwise-runner/.aom-runner';

/** A 1.10.0 current-user install of alice, stopped, plus an empty dedicated user. */
function aliceInstall(opts: { alive?: number[]; policy?: unknown; version?: string } = {}) {
  const f = fakeSystem({ users: [ALICE, RUNNER], alive: opts.alive });
  const at = (p: string) => join(f.root, p);
  const put = (p: string, text: string) => {
    mkdirSync(join(at(p), '..'), { recursive: true });
    writeFileSync(at(p), text, { mode: 0o644 });
  };
  mkdirSync(at(RUNNER.home), { recursive: true });
  put(
    `${OLD}/config.json`,
    JSON.stringify({
      serverUrl: 'https://hq.example.com',
      runnerToken: 'aomr_secret-token',
      repoRoots: [
        '/home/alice/guildwise-runner/src',
        '/srv/shared-code',
        '/home/alice/code',
        '/home/alice/.ssh',
      ],
      logins: { claude: '/home/alice/.aom-runner/agents/x' },
    }),
  );
  put(`${OLD}/secrets/sudo.enc`, 'sealed\n');
  put(`${OLD}/secrets/claude.json`, '{"oauthToken":"t"}');
  put(`${OLD}/logs/runner.log`, 'log line\n');
  put(
    `${OLD}/status.json`,
    JSON.stringify({ pid: 4242, connected: false, activeShifts: 0, updatedAt: '2026-11-20T10:00:00Z' }),
  );
  put(
    '/home/alice/.config/aom-runner/policy.json',
    JSON.stringify(
      opts.policy ?? {
        version: 1,
        setupDone: true,
        runnerUser: { mode: 'current', name: 'alice' },
        devops: { agents: {}, sudo: true },
        acceptRootEquivalent: true,
      },
    ),
  );
  put('/home/alice/guildwise-runner/src/shop/README.md', 'hello\n');
  put('/home/alice/code/app/.env', 'DB_PASSWORD=person\n');
  put('/home/alice/.ssh/id_ed25519', 'KEY\n');
  put('/etc/shadow-copy', 'TOP SECRET\n');
  symlinkSync(at('/etc/shadow-copy'), at(`${OLD}/planted`));
  if (opts.version) {
    mkdirSync(at(`/home/alice/.local/share/guildwise/runner/${opts.version}/aom-runner`), {
      recursive: true,
    });
    symlinkSync(`${opts.version}/aom-runner`, at('/home/alice/.local/share/guildwise/runner/current'));
  }
  return { ...f, at, put };
}

describe('migrate-user [rv6-5]', () => {
  it('copies the data dir, its own clones and the policy to the dedicated user, secrets at 0600, and prints the logins to redo', async () => {
    const f = aliceInstall({ version: '1.10.0' });
    expect(await admin.main(['migrate-user', '--from', 'alice'], f.sys)).toBe(0);
    for (const s of [`${NEW}/config.json`, `${NEW}/secrets/claude.json`])
      expect(statSync(f.at(s)).mode & 0o777, s).toBe(0o600);
    expect(statSync(f.at(`${NEW}/secrets`)).mode & 0o777).toBe(0o700);
    expect(statSync(f.at(NEW)).mode & 0o777).toBe(0o700);
    const policyFile = f.at('/home/guildwise-runner/.config/aom-runner/policy.json');
    expect(statSync(policyFile).mode & 0o777).toBe(0o600);
    const policy = JSON.parse(readFileSync(policyFile, 'utf8'));
    expect(policy.runnerUser).toEqual({ mode: 'dedicated', name: 'guildwise-runner' });
    // the old mode's sudo and root-equivalence acceptance do not carry over
    expect(policy.devops.sudo).toBe(false);
    expect(policy.acceptRootEquivalent).toBe(false);
    // the person's sealed sudo password never reaches the runner user
    expect(existsSync(f.at(`${NEW}/secrets/sudo.enc`))).toBe(false);
    expect(f.out.join('\n')).toContain('Sudo is off for guildwise-runner');
    // configs now point at the new HOME (own clones at ~/src)
    const cfg = JSON.parse(readFileSync(f.at(`${NEW}/config.json`), 'utf8'));
    expect(cfg.repoRoots).toEqual([
      '/home/guildwise-runner/src',
      '/srv/shared-code',
      '/home/guildwise-runner/code',
      '/home/guildwise-runner/.ssh',
    ]);
    expect(cfg.logins.claude).toBe('/home/guildwise-runner/.aom-runner/agents/x');
    expect(readFileSync(f.at('/home/guildwise-runner/src/shop/README.md'), 'utf8')).toBe('hello\n');
    // only the runner's own clones: the person's folders (their .env) and ~/.ssh are never copied
    expect(existsSync(f.at('/home/guildwise-runner/code'))).toBe(false);
    expect(existsSync(f.at('/home/guildwise-runner/.ssh'))).toBe(false);
    // the status file is never carried (the good-start check reads the new one)
    expect(existsSync(f.at(`${NEW}/status.json`))).toBe(false);
    const out = f.out.join('\n');
    expect(out).toContain('/home/alice/guildwise-runner/src): /srv/shared-code');
    expect(out).toContain('/home/alice/guildwise-runner/src): /home/alice/code');
    // the old service is disabled so it cannot start again with the same token
    expect(f.calls).toContainEqual({
      cmd: 'systemctl',
      args: ['--user', '-M', 'alice@', 'disable', '--now', 'aom-runner'],
    });
    expect(out).toContain('sudo -u guildwise-runner -H gh auth login');
    expect(out).toContain('migrate-user --finish');
    // the old copies stay until --finish
    expect(existsSync(f.at(`${OLD}/secrets/sudo.enc`))).toBe(true);
    // the marker that lists what --finish deletes is root's, not the runner's
    expect(statSync(f.at(admin.MIGRATE_MARKER)).mode & 0o777).toBe(0o600);
  });

  it('never follows a symlink: a planted link is copied as a link, its target is not read', async () => {
    const f = aliceInstall();
    expect(await admin.main(['migrate-user', '--from', 'alice'], f.sys)).toBe(0);
    const copy = f.at(`${NEW}/planted`);
    expect(lstatSync(copy).isSymbolicLink()).toBe(true);
    expect(readlinkSync(copy)).toBe(f.at('/etc/shadow-copy'));
  });

  it.each([['the old runner still runs', { alive: [4242] }, /still running \(pid 4242\)/]])(
    'refuses while %s',
    async (_n, o, msg) => {
      const f = aliceInstall(o);
      expect(await admin.main(['migrate-user', '--from', 'alice'], f.sys)).toBe(1);
      expect(f.err.join('\n')).toMatch(msg);
      expect(existsSync(f.at(NEW))).toBe(false);
    },
  );

  it('refuses while a shift runs, a shift waits to resume, or a deploy runs', async () => {
    const shifts = aliceInstall();
    shifts.put(`${OLD}/status.json`, JSON.stringify({ pid: 1, activeShifts: 2 }));
    expect(await admin.main(['migrate-user', '--from', 'alice'], shifts.sys)).toBe(1);
    expect(shifts.err.join('\n')).toContain('2 shift(s) are running');

    const resume = aliceInstall();
    resume.put(`${OLD}/active-shifts/s1.json`, '{}');
    expect(await admin.main(['migrate-user', '--from', 'alice'], resume.sys)).toBe(1);
    expect(resume.err.join('\n')).toContain('a shift was running');

    const deploy = aliceInstall();
    deploy.put(`${OLD}/deploys/run-1/started.json`, '{}');
    expect(await admin.main(['migrate-user', '--from', 'alice'], deploy.sys)).toBe(1);
    expect(deploy.err.join('\n')).toContain('deploy run-1 is running');
    deploy.put(`${OLD}/deploys/run-1/result.json`, '{}');
    expect(await admin.main(['migrate-user', '--from', 'alice'], deploy.sys)).toBe(0);
  });

  it('refuses state written by a runner below the floor (R21): no policy.json, or an older installed version', async () => {
    const old = aliceInstall();
    old.put('/home/alice/.config/aom-runner/policy.json', 'not json');
    expect(await admin.main(['migrate-user', '--from', 'alice'], old.sys)).toBe(1);
    expect(old.err.join('\n')).toContain('nothing is carried over');
    const older = aliceInstall({ version: '0.1.50' });
    expect(await admin.main(['migrate-user', '--from', 'alice'], older.sys)).toBe(1);
    expect(older.err.join('\n')).toContain('installed: 0.1.50');
    expect(existsSync(older.at(NEW))).toBe(false);
  });

  it('refuses to overwrite data the runner user already has', async () => {
    const f = aliceInstall();
    f.put(`${NEW}/config.json`, '{}');
    expect(await admin.main(['migrate-user', '--from', 'alice'], f.sys)).toBe(1);
    expect(f.err.join('\n')).toContain('already exists');
  });

  it('--finish waits for the first good start as the new user, then deletes and lists the old copies', async () => {
    const f = aliceInstall();
    expect(await admin.main(['migrate-user', '--from', 'alice'], f.sys)).toBe(0);
    expect(await admin.main(['migrate-user', '--finish'], f.sys)).toBe(1);
    expect(f.err.join('\n')).toContain('has not started well');
    expect(existsSync(f.at(`${OLD}/config.json`))).toBe(true);
    f.put(
      `${NEW}/status.json`,
      JSON.stringify({ pid: 7, connected: true, updatedAt: new Date(Date.now() + 60_000).toISOString() }),
    );
    // still enabled for the old user: refused
    const wants = '/home/alice/.config/systemd/user/default.target.wants/aom-runner.service';
    f.put(wants, '');
    expect(await admin.main(['migrate-user', '--finish'], f.sys)).toBe(1);
    expect(f.err.join('\n')).toContain('systemctl --user disable --now aom-runner');
    rmSync(f.at(wants));
    f.out.length = 0;
    expect(await admin.main(['migrate-user', '--finish'], f.sys)).toBe(0);
    for (const gone of [`${OLD}/config.json`, `${OLD}/secrets`, '/home/alice/.config/aom-runner/policy.json'])
      expect(existsSync(f.at(gone)), gone).toBe(false);
    // the work stays, and so do the person's own logins
    expect(existsSync(f.at(`${OLD}/logs/runner.log`))).toBe(true);
    const out = f.out.join('\n');
    expect(out).toContain(`${OLD}/config.json`);
    expect(out).toContain(`${OLD}/secrets`);
    expect(existsSync(f.at(admin.MIGRATE_MARKER))).toBe(false);
    // deleted with alice's own rights, never by root through a path
    const rm = f.calls.filter((c) => c.cmd === 'runuser');
    expect(rm.length).toBe(3);
    for (const c of rm) expect(c.args.slice(0, 5)).toEqual(['-u', 'alice', '--', 'rm', '-rf']);
  });

  it('dry run copies nothing', async () => {
    const f = aliceInstall();
    expect(await admin.main(['migrate-user', '--from', 'alice', '--dry-run'], f.sys)).toBe(0);
    expect(existsSync(f.at(NEW))).toBe(false);
    expect(f.out.join('\n')).toContain(`would copy ${OLD} -> ${NEW}`);
  });
});
