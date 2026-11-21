import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeRunner, runSh, type ShSetup, shHome } from './helpers/installer-sh.ts';

/**
 * R21: "Looking for an older runner". With "Only signed runners" off (the self-hosted default) an existing runner is kept
 * and upgraded as before; it is stopped and quarantined (nothing carried over) only on a server that requires signed
 * runners, when it is not a runner this installer verified, or when the user asks with --legacy.
 */
const FIX = join(__dirname, '../../runner/test/fixtures/minisign');
const pubLine = (name: string) => readFileSync(join(FIX, name), 'utf8').split('\n')[1] ?? '';
const TEST_PUB = pubLine('test.pub');
const MANIFEST_SHA = 'c0365f8580934d0be3bfe769275180a302585ba4d547d58093dc2c7428285e41';
// `kill` is a shell builtin: replaced so a test can never signal a real process.
const LEGACY_ONLY = `kill() { echo "kill $*" >> "$STUB_LOG"; }\nmain "$@"`;

let setup: ShSetup;
afterEach(() => setup?.cleanup());

/** An install of the kind every runner before 1.10.0 left: runner root, data, config, commands and a user service. */
function oldInstall(home: string, version = '1.9.0'): string[] {
  const root = fakeRunner(home, version);
  const data = join(home, '.aom-runner');
  mkdirSync(join(data, 'logs'), { recursive: true });
  writeFileSync(
    join(data, 'config.json'),
    '{"serverUrl":"https://hq.example.com","runnerToken":"aomr_secret"}',
  );
  mkdirSync(join(home, '.config/aom-runner'), { recursive: true });
  writeFileSync(join(home, '.config/aom-runner/sudo-vault.json'), '{"sealed":"x"}');
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  spawnSync('ln', ['-sfn', join(root, 'current/aom-runner'), join(home, '.local/bin/guildwise-runner')]);
  spawnSync('ln', ['-sfn', join(root, 'current/aom-runner'), join(home, '.local/bin/aom-runner')]);
  mkdirSync(join(home, '.config/systemd/user'), { recursive: true });
  writeFileSync(join(home, '.config/systemd/user/aom-runner.service'), '[Service]\n');
  return [
    root,
    data,
    join(home, '.config/aom-runner'),
    join(home, '.local/bin/guildwise-runner'),
    join(home, '.local/bin/aom-runner'),
    join(home, '.config/systemd/user/aom-runner.service'),
  ];
}

/** A 1.10.0 install this installer set up: kept manifest and signature, matching tarball checksum. */
function signedInstall(home: string, sig = 'manifest.json.minisig'): string {
  const root = fakeRunner(home, '1.10.0', { sha256: MANIFEST_SHA });
  copyFileSync(join(FIX, 'manifest.json'), join(root, 'manifest.json'));
  copyFileSync(join(FIX, sig), join(root, 'manifest.json.minisig'));
  return root;
}

const quarantineDirs = (home: string) => {
  const base = join(home, '.guildwise-quarantine');
  return existsSync(base) ? readdirSync(base).map((d) => join(base, d)) : [];
};
const mode = (p: string) => statSync(p).mode & 0o777;

describe('installer: an older runner, "Only signed runners" off (self-hosted default)', () => {
  it('finds nothing on a clean computer', () => {
    setup = shHome();
    const r = runSh(setup, LEGACY_ONLY, { args: ['--legacy-only'] });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('No older runner on this computer');
    expect(r.stdout).toContain('LEGACY_RESULT=none');
  });

  it('keeps an existing runner and its settings: nothing stopped, moved or removed', () => {
    setup = shHome();
    const paths = oldInstall(setup.home);
    const r = runSh(setup, LEGACY_ONLY, { args: ['--legacy-only'] });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('LEGACY_RESULT=kept');
    expect(r.stdout).toContain('keeping it and its settings');
    expect(r.stdout).toContain('--legacy quarantine');
    for (const p of paths) expect(existsSync(p), p).toBe(true);
    expect(quarantineDirs(setup.home)).toEqual([]);
    expect(r.log).not.toContain('systemctl');
    expect(r.log).not.toContain('kill');
    expect(r.stdout).not.toContain('change this user');
  });

  it('quarantines it when the user asks (--legacy quarantine, or GUILDWISE_LEGACY=quarantine)', () => {
    for (const how of [
      { args: ['--legacy-only', '--legacy', 'quarantine'] },
      { env: { GUILDWISE_LEGACY: 'quarantine' } },
    ]) {
      setup = shHome();
      const paths = oldInstall(setup.home);
      const r = runSh(setup, LEGACY_ONLY, { args: ['--legacy-only'], ...how });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('LEGACY_RESULT=quarantined');
      for (const p of paths) expect(existsSync(p), p).toBe(false);
      expect(quarantineDirs(setup.home)).toHaveLength(1);
      setup.cleanup();
    }
  });

  it('removes it without a copy with --legacy remove', () => {
    setup = shHome();
    const paths = oldInstall(setup.home);
    const r = runSh(setup, LEGACY_ONLY, { args: ['--legacy-only', '--legacy=remove'] });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('LEGACY_RESULT=removed');
    for (const p of paths) expect(existsSync(p), p).toBe(false);
    expect(quarantineDirs(setup.home)).toEqual([]);
    expect(r.stdout).toContain("change this user's password now");
  });

  it('refuses an unknown --legacy value', () => {
    setup = shHome();
    oldInstall(setup.home);
    const r = runSh(setup, LEGACY_ONLY, { args: ['--legacy-only', '--legacy', 'keep'] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--legacy is quarantine or remove');
  });
});

describe('installer: an older runner on a server that requires signed runners', () => {
  const on = { requireSignedRunners: true, releasePubkey: TEST_PUB };

  it('stops a pre-1.10.0 runner and quarantines every path: one tar (600) in a 700 folder with a manifest', () => {
    setup = shHome();
    const paths = oldInstall(setup.home);
    const r = runSh(setup, LEGACY_ONLY, { args: ['--legacy-only'], params: on });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('LEGACY_RESULT=quarantined');
    expect(r.stdout).toContain('accepts only signed runners');
    // stopped: the user service is disabled
    expect(r.log).toContain('systemctl --user disable --now aom-runner');
    // nothing left behind, nothing reused
    for (const p of paths) expect(existsSync(p), p).toBe(false);
    const [dir] = quarantineDirs(setup.home);
    expect(dir).toMatch(/\.guildwise-quarantine\/\d{8}T\d{6}Z$/);
    expect(mode(join(setup.home, '.guildwise-quarantine'))).toBe(0o700);
    expect(mode(dir as string)).toBe(0o700);
    expect(readdirSync(dir as string).sort()).toEqual(['MANIFEST.txt', 'old-runner.tgz']);
    expect(mode(join(dir as string, 'old-runner.tgz'))).toBe(0o600);
    expect(mode(join(dir as string, 'MANIFEST.txt'))).toBe(0o600);
    // the manifest lists each file with its size and sha256, and the links
    const manifest = readFileSync(join(dir as string, 'MANIFEST.txt'), 'utf8');
    const cfg = join(setup.home, '.aom-runner/config.json');
    const cfgLine = manifest.split('\n').find((l) => l.endsWith(`\t${cfg}`)) ?? '';
    expect(cfgLine).toMatch(/^file\t\d+\t[0-9a-f]{64}\t/);
    expect(manifest).toContain(`link\t-\t-\t${join(setup.home, '.local/bin/guildwise-runner')} -> `);
    // the archive holds them with the execute bits stripped (and nothing for group or others)
    const list = spawnSync('tar', ['-tvzf', join(dir as string, 'old-runner.tgz')], {
      encoding: 'utf8',
    }).stdout;
    expect(list).toContain('.aom-runner/config.json');
    expect(list).toContain('.local/share/guildwise/runner/1.9.0/aom-runner/aom-runner');
    for (const line of list.split('\n').filter((l) => l.startsWith('-')))
      expect(line.slice(0, 10)).toBe('-rw-------');
    // the user is told about the sudo password and where the files are
    expect(r.stdout).toContain(
      "If sudo was granted to the old runner, change this user's password now: the old runner's sealed sudo password may be known.",
    );
    expect(r.stdout).toContain(`Old runner moved to ${dir}`);
    expect(r.stdout).toContain('Nothing from it is read or reused');
  });

  it('keeps the signed 1.10.0 runner it installed itself (a repair or upgrade, not an old install)', () => {
    setup = shHome();
    const root = signedInstall(setup.home);
    const r = runSh(setup, LEGACY_ONLY, { args: ['--legacy-only'], params: on });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('LEGACY_RESULT=kept');
    expect(existsSync(join(root, 'current/aom-runner'))).toBe(true);
    expect(quarantineDirs(setup.home)).toEqual([]);
  });

  it('quarantines a 1.10.0 runner whose kept proof is signed by another key, missing, or does not match it', () => {
    const cases: Array<(home: string) => void> = [
      (home) => signedInstall(home, 'manifest.json.other.minisig'),
      (home) => fakeRunner(home, '1.10.0', { sha256: MANIFEST_SHA }),
      (home) => {
        const root = signedInstall(home);
        writeFileSync(join(root, '1.10.0', '.sha256'), 'a'.repeat(64));
      },
    ];
    for (const make of cases) {
      setup = shHome();
      make(setup.home);
      const r = runSh(setup, LEGACY_ONLY, { args: ['--legacy-only'], params: on });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('LEGACY_RESULT=quarantined');
      expect(quarantineDirs(setup.home)).toHaveLength(1);
      setup.cleanup();
    }
  });

  it('a server that names no release key trusts no kept install', () => {
    setup = shHome();
    signedInstall(setup.home);
    const r = runSh(setup, LEGACY_ONLY, { args: ['--legacy-only'], params: { requireSignedRunners: true } });
    expect(r.stdout).toContain('LEGACY_RESULT=quarantined');
  });

  it('stops a running old runner, and refuses to go on while it keeps running', () => {
    setup = shHome();
    oldInstall(setup.home);
    writeFileSync(join(setup.home, 'pids'), '4194301\n');
    writeFileSync(join(setup.home, 'pids-left'), '3');
    const stops = runSh(setup, LEGACY_ONLY, { args: ['--legacy-only'], params: on });
    expect(stops.status, stops.stderr).toBe(0);
    expect(stops.log).toContain('kill 4194301');
    expect(stops.stdout).toContain('LEGACY_RESULT=quarantined');
    setup.cleanup();

    setup = shHome();
    const paths = oldInstall(setup.home);
    writeFileSync(join(setup.home, 'pids'), '4194301\n');
    const stuck = runSh(setup, LEGACY_ONLY, { args: ['--legacy-only'], params: on });
    expect(stuck.status).toBe(1);
    expect(stuck.log).toContain('kill -9 4194301');
    expect(stuck.stderr).toContain('The old runner is still running');
    // nothing was moved while it ran
    for (const p of paths) expect(existsSync(p), p).toBe(true);
    expect(quarantineDirs(setup.home)).toEqual([]);
  });

  it('never executes the old runner: its version comes from the folder current points at', () => {
    setup = shHome();
    const root = oldInstall(setup.home)[0] as string;
    const marker = join(setup.home, 'executed');
    writeFileSync(join(root, '1.9.0/aom-runner/aom-runner'), `#!/bin/sh\ntouch '${marker}'\necho 1.9.0\n`);
    const r = runSh(setup, LEGACY_ONLY, { args: ['--legacy-only'], params: on });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('runner 1.9.0');
    expect(r.stdout).toContain('LEGACY_RESULT=quarantined');
    expect(existsSync(marker)).toBe(false);
  });

  it('takes a custom AOM_RUNNER_HOME only when it holds runner data and not your home folder', () => {
    setup = shHome();
    const proj = join(setup.home, 'projects');
    mkdirSync(proj);
    writeFileSync(join(proj, 'notes.txt'), 'mine');
    const r = runSh(setup, 'legacy_paths', { env: { AOM_RUNNER_HOME: proj } });
    expect(r.stdout).not.toContain(proj);
    writeFileSync(join(proj, 'config.json'), '{}');
    expect(runSh(setup, 'legacy_paths', { env: { AOM_RUNNER_HOME: proj } }).stdout).toContain(proj);
    const up = runSh(setup, 'legacy_paths', { env: { AOM_RUNNER_HOME: join(setup.home, '..') } });
    expect(up.stdout).not.toContain(join(setup.home, '..'));
  });

  it('never moves the home folder itself away (a bad AOM_RUNNER_HOME)', () => {
    setup = shHome();
    oldInstall(setup.home);
    const r = runSh(setup, LEGACY_ONLY, {
      args: ['--legacy-only'],
      params: on,
      env: { AOM_RUNNER_HOME: setup.home },
    });
    // AOM_RUNNER_HOME holding the home folder is never taken; the rest of the old install is still quarantined.
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('LEGACY_RESULT=quarantined');
    expect(existsSync(join(setup.home, '.stub-bin'))).toBe(true);
    expect(existsSync(join(setup.home, '.local/share/guildwise/runner'))).toBe(false);
  });
});

describe('installer: the runner account after the older-runner step', () => {
  const choose = (extra = '') =>
    `${extra}\nkill() { :; }\ndedicated_supported() { :; }\nparse_flags "$@"; handle_legacy >/dev/null; choose_runner_user; echo "MODE=$RUNNER_MODE"`;

  it('a new install gets the dedicated user; a kept runner of your own user stays yours (upgrade unchanged)', () => {
    setup = shHome();
    expect(runSh(setup, choose()).stdout).toContain('MODE=dedicated');
    setup.cleanup();
    setup = shHome();
    oldInstall(setup.home);
    const kept = runSh(setup, choose());
    expect(kept.stdout).toContain('MODE=current');
    expect(kept.stdout).toContain('migrate-user');
  });

  it('--runner-user dedicated next to a kept runner of your own user stops with the three ways out', () => {
    setup = shHome();
    oldInstall(setup.home);
    const r = runSh(setup, choose(), { args: ['--runner-user', 'dedicated'] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--runner-user current');
    expect(r.stderr).toContain('migrate-user');
    expect(r.stderr).toContain('--legacy quarantine');
  });

  it('after a quarantine the new install gets the dedicated user', () => {
    setup = shHome();
    oldInstall(setup.home);
    const r = runSh(setup, choose(), {
      args: ['--legacy', 'quarantine'],
      params: { requireSignedRunners: true },
    });
    expect(r.stdout).toContain('MODE=dedicated');
  });
});
