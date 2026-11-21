import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dockerEnvFor } from '../src/policy/docker-env.ts';
import {
  collectDockerSockets,
  type DockerSocketFact,
  daemonIsRootless,
  decideStartup,
  dockerSocketCandidates,
  type HostFacts,
  rootEquivalentReasons,
  trustedDockerCli,
  writableByOthers,
} from '../src/policy/startup.ts';

const clean: HostFacts = {
  uid: 1001,
  passwordlessSudo: false,
  groups: ['guildwise-runner'],
  dockerSockets: [],
  writableByOthers: [],
};
const refusing = { startupRefusal: true, acceptRootEquivalent: false };
const warnOnly = { acceptRootEquivalent: false };
const sock = (over: Partial<DockerSocketFact> = {}): DockerSocketFact => ({
  path: '/var/run/docker.sock',
  real: '/var/run/docker.sock',
  uid: 0,
  gid: 998,
  writable: true,
  own: false,
  owner: 'root',
  group: 'docker',
  ...over,
});

describe('the start-up check (R18-P, R21)', () => {
  it('names every root-equivalent property', () => {
    expect(rootEquivalentReasons({ ...clean, uid: 0 })).toEqual(['runs as root (uid 0)']);
    expect(rootEquivalentReasons({ ...clean, passwordlessSudo: true })[0]).toMatch(/sudo without a password/);
    expect(rootEquivalentReasons({ ...clean, groups: ['docker'] })[0]).toMatch(/docker group/);
    expect(rootEquivalentReasons({ ...clean, dockerSockets: [sock()] })[0]).toMatch(/Docker socket/);
  });

  it('refuses under uid 0, passwordless sudo, the docker group or a writable socket when startupRefusal is set', () => {
    for (const f of [
      { ...clean, uid: 0 },
      { ...clean, passwordlessSudo: true },
      { ...clean, groups: ['docker'] },
      { ...clean, dockerSockets: [sock({ path: '/run/docker.sock' })] },
    ])
      expect(decideStartup({ facts: f, policy: refusing, serverRequiresSigned: false })).toMatchObject({
        action: 'refuse',
      });
    expect(decideStartup({ facts: clean, policy: refusing, serverRequiresSigned: false })).toEqual({
      action: 'ok',
    });
  });

  it('refuses when the server reports "Only signed runners" even without the local setting (it may narrow)', () => {
    expect(
      decideStartup({
        facts: { ...clean, groups: ['docker'] },
        policy: warnOnly,
        serverRequiresSigned: true,
      }),
    ).toMatchObject({
      action: 'refuse',
    });
  });

  it('acceptRootEquivalent lets it start with the warning, but never overrides "writable by another user"', () => {
    const accepted = { startupRefusal: true, acceptRootEquivalent: true };
    expect(
      decideStartup({
        facts: { ...clean, passwordlessSudo: true },
        policy: accepted,
        serverRequiresSigned: true,
      }),
    ).toMatchObject({
      action: 'warn',
    });
    expect(
      decideStartup({
        facts: { ...clean, writableByOthers: ['/home/x/.config/aom-runner/policy.json'] },
        policy: accepted,
        serverRequiresSigned: false,
      }),
    ).toMatchObject({ action: 'refuse', reason: expect.stringMatching(/writable by another user/) });
  });

  it('a runner that self-updated without setup (no startupRefusal) and a server with the setting off only warns', () => {
    expect(
      decideStartup({
        facts: { ...clean, uid: 0, groups: ['docker'] },
        policy: warnOnly,
        serverRequiresSigned: false,
      }),
    ).toMatchObject({
      action: 'warn',
      reasons: expect.arrayContaining([expect.stringMatching(/root/)]),
    });
  });

  it('detects files group or others may write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aom-startup-'));
    const f = join(dir, 'policy.json');
    writeFileSync(f, '{}');
    chmodSync(f, 0o600);
    const uid = process.getuid?.() ?? null;
    expect(writableByOthers(f, uid)).toBe(false);
    chmodSync(f, 0o666);
    expect(writableByOthers(f, uid)).toBe(true);
    chmodSync(f, 0o620);
    expect(writableByOthers(f, uid)).toBe(true);
  });
});

describe('start-up check: Docker sockets (deps-without-sudo §4)', () => {
  /** A fake /run: the runner's own runtime dir (0700) and the DevBox's docker-svc socket. */
  function fakeRun() {
    const run = mkdtempSync(join(tmpdir(), 'aom-run-'));
    const uid = process.getuid?.() ?? 1000;
    const own = join(run, 'user', String(uid));
    mkdirSync(own, { recursive: true, mode: 0o700 });
    chmodSync(own, 0o700);
    writeFileSync(join(own, 'docker.sock'), '');
    mkdirSync(join(run, 'docker-svc'));
    writeFileSync(join(run, 'docker-svc', 'docker.sock'), '');
    chmodSync(join(run, 'docker-svc', 'docker.sock'), 0o660);
    return { run, uid, own };
  }

  it("the runner's own rootless socket (own uid, parent 0700) is never a reason", () => {
    const { run, uid, own } = fakeRun();
    const facts = collectDockerSockets({
      candidates: [join(own, 'docker.sock')],
      uid,
      gids: [],
      runtimeDirs: [own],
    });
    expect(facts[0]).toMatchObject({ own: true, writable: true });
    expect(rootEquivalentReasons({ ...clean, dockerSockets: facts })).toEqual([]);
    expect(
      decideStartup({
        facts: { ...clean, dockerSockets: facts },
        policy: refusing,
        serverRequiresSigned: false,
      }),
    ).toEqual({
      action: 'ok',
    });
    // a parent that is not 0700 is not "own"
    chmodSync(own, 0o755);
    expect(
      collectDockerSockets({ candidates: [join(own, 'docker.sock')], uid, gids: [], runtimeDirs: [own] })[0]
        ?.own,
    ).toBe(false);
    expect(run).toBeTruthy();
  });

  it("another daemon's group-writable socket is refused with the group named; /run/docker.sock as a symlink to it too", () => {
    const { run, uid, own } = fakeRun();
    symlinkSync(join(run, 'docker-svc', 'docker.sock'), join(run, 'docker.sock'));
    const facts = collectDockerSockets({
      candidates: dockerSocketCandidates({}, uid, run),
      uid,
      gids: [],
      runtimeDirs: [own],
    });
    const svc = facts.find((f) => f.real.endsWith('docker-svc/docker.sock'));
    // found once (by real path) although both /run/docker.sock and /run/docker-svc/docker.sock name it
    expect(facts.filter((f) => f.real.endsWith('docker-svc/docker.sock'))).toHaveLength(1);
    expect(svc?.path).toBe(join(run, 'docker.sock'));
    // as on the DevBox: root:docker-svc 660, the runner in docker-svc
    const devbox = { ...(svc as DockerSocketFact), uid: 0, owner: 'root', group: 'docker-svc', own: false };
    const reasons = rootEquivalentReasons({ ...clean, dockerSockets: [devbox] });
    expect(reasons[0]).toContain('of another daemon (owner root, through group docker-svc)');
    expect(
      decideStartup({
        facts: { ...clean, dockerSockets: [devbox] },
        policy: refusing,
        serverRequiresSigned: false,
      }),
    ).toMatchObject({
      action: 'refuse',
      reason: expect.stringContaining('docker-svc'),
    });
  });

  it('a socket in the own runtime dir that links to another daemon is not "own" (realpath)', () => {
    const { run, uid, own } = fakeRun();
    const fake = join(run, 'user', String(uid), 'docker.sock');
    // replace the own socket with a link to the shared one
    rmSync(fake);
    symlinkSync(join(run, 'docker-svc', 'docker.sock'), fake);
    const facts = collectDockerSockets({ candidates: [fake], uid, gids: [], runtimeDirs: [own] });
    expect(facts[0]?.own).toBe(false);
    expect(rootEquivalentReasons({ ...clean, dockerSockets: facts })[0]).toMatch(/of another daemon/);
  });

  it('the docker group is still refused; acceptRootEquivalent accepts all of it with a warning', () => {
    const facts = { ...clean, groups: ['docker'], dockerSockets: [sock()] };
    expect(decideStartup({ facts, policy: refusing, serverRequiresSigned: false }).action).toBe('refuse');
    expect(
      decideStartup({
        facts,
        policy: { startupRefusal: true, acceptRootEquivalent: true },
        serverRequiresSigned: false,
      }),
    ).toMatchObject({ action: 'warn' });
  });

  it('a shared rootless daemon accepted at install only warns, for exactly that socket and only while rootless (owner 2026-11-21)', () => {
    const svc = sock({
      path: '/run/docker.sock',
      real: '/run/docker-svc/docker.sock',
      group: 'docker-svc',
      rootless: true,
    });
    const policy = {
      ...refusing,
      docker: 'shared' as const,
      sharedDocker: { socket: '/run/docker-svc/docker.sock', group: 'docker-svc' },
    };
    const d = decideStartup({
      facts: { ...clean, dockerSockets: [svc] },
      policy,
      serverRequiresSigned: true,
    });
    expect(d).toMatchObject({ action: 'warn' });
    expect(d.action === 'warn' && d.reasons[0]).toContain(
      'shared rootless Docker daemon /run/docker-svc/docker.sock',
    );
    // a rootful daemon behind the same socket: refused
    expect(
      decideStartup({
        facts: { ...clean, dockerSockets: [{ ...svc, rootless: false }] },
        policy,
        serverRequiresSigned: false,
      }).action,
    ).toBe('refuse');
    // another socket than the recorded one: refused
    expect(
      decideStartup({
        facts: { ...clean, dockerSockets: [svc, sock()] },
        policy,
        serverRequiresSigned: false,
      }).action,
    ).toBe('refuse');
    // no recorded acceptance: refused
    expect(
      decideStartup({
        facts: { ...clean, dockerSockets: [svc] },
        policy: { ...refusing, docker: 'shared' as const },
        serverRequiresSigned: false,
      }).action,
    ).toBe('refuse');
    // the docker group stays refused even with a shared acceptance
    expect(
      decideStartup({
        facts: { ...clean, groups: ['docker'], dockerSockets: [svc] },
        policy,
        serverRequiresSigned: false,
      }).action,
    ).toBe('refuse');
  });

  it('an inherited tcp:// or ssh:// DOCKER_HOST is a reason unless the policy is host', () => {
    const facts = { ...clean, inheritedDockerHost: 'tcp://10.0.0.5:2375' };
    expect(rootEquivalentReasons(facts)[0]).toContain('reaches another Docker daemon');
    expect(rootEquivalentReasons({ ...clean, inheritedDockerHost: 'ssh://u:pw@h' })[0]).not.toContain('pw');
    expect(rootEquivalentReasons(facts, { docker: 'host' })).toEqual([]);
    expect(
      rootEquivalentReasons({ ...clean, inheritedDockerHost: 'unix:///run/user/1/docker.sock' }),
    ).toEqual([]);
  });
});

describe('applyDockerEnv (deps-without-sudo §3)', () => {
  it('rootless: the own socket and the root-owned binaries first on PATH; none drops an inherited DOCKER_HOST', () => {
    const env = { PATH: '/usr/bin:/bin', DOCKER_HOST: 'tcp://x:2375' };
    expect(dockerEnvFor({ docker: 'rootless' }, 991, '/usr/local/lib/guildwise/uat', env)).toMatchObject({
      DOCKER_HOST: 'unix:///run/user/991/docker.sock',
      PATH: '/usr/local/lib/guildwise/uat/docker:/usr/bin:/bin',
      DOCKER_CLI_PLUGIN_EXTRA_DIRS: '/usr/local/lib/guildwise/uat/docker/cli-plugins',
    });
    expect(dockerEnvFor({ docker: 'none' }, 991, '/x', env)).toEqual({ DOCKER_HOST: undefined });
    expect(
      dockerEnvFor({ docker: 'shared', dockerHost: 'unix:///run/docker-svc/docker.sock' }, 991, '/x', env)
        .DOCKER_HOST,
    ).toBe('unix:///run/docker-svc/docker.sock');
    expect(
      dockerEnvFor({ docker: 'host', dockerHost: 'unix:///Users/a/.docker/run/docker.sock' }, 501, '/x', env)
        .DOCKER_HOST,
    ).toBe('unix:///Users/a/.docker/run/docker.sock');
    expect(dockerEnvFor({ docker: 'host' }, 991, '/x', env)).toEqual({});
  });
});

describe('S2: the rootless probe runs a root-owned docker CLI by absolute path, never from PATH', () => {
  const uid = process.getuid?.() ?? 0;
  function fakeCli(dir: string, name: string, out: string, mode = 0o755): string {
    const f = join(dir, name);
    writeFileSync(f, `#!/bin/sh\necho '${out}'\n`);
    chmodSync(f, mode);
    return f;
  }

  it('trustedDockerCli: the first regular file owned by root and not writable by group or others', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aom-cli-'));
    const writable = fakeCli(dir, 'writable', 'x', 0o775);
    const good = fakeCli(dir, 'good', 'x');
    expect(trustedDockerCli([join(dir, 'missing'), writable, good], uid)).toBe(good);
    expect(trustedDockerCli([writable], uid)).toBeNull();
    // another owner than root is never trusted
    expect(trustedDockerCli([good], uid + 1)).toBeNull();
  });

  it('daemonIsRootless asks only the given absolute CLI; a docker planted on PATH is never run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aom-cli-'));
    const planted = mkdtempSync(join(tmpdir(), 'aom-path-'));
    fakeCli(planted, 'docker', '["name=rootless"]');
    const old = process.env.PATH;
    process.env.PATH = `${planted}:${old}`;
    try {
      expect(await daemonIsRootless('/run/x/docker.sock', null)).toBe(false);
      expect(await daemonIsRootless('/run/x/docker.sock', 'docker')).toBe(false);
      const rootful = fakeCli(dir, 'rootful', '["name=seccomp"]');
      expect(await daemonIsRootless('/run/x/docker.sock', rootful)).toBe(false);
      const rootless = fakeCli(dir, 'rootless', '["name=seccomp","name=rootless"]');
      expect(await daemonIsRootless('/run/x/docker.sock', rootless)).toBe(true);
    } finally {
      process.env.PATH = old;
    }
  });
});
