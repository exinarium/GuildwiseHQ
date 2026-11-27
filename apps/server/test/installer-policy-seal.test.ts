import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runSh, type ShSetup, shHome } from './helpers/installer-sh.ts';

/**
 * installer-policy-seal (Combined-QA blocker 3): with a shared Docker daemon, root (guildwise-admin) no longer writes the
 * runner's sealed policy.json; after root's checks and group join the installer runs `guildwise-runner policy
 * record-shared-docker` as the runner, in a fresh login, so the runner seals the acceptance with its existing key.
 */
let setup: ShSetup;
afterEach(() => setup?.cleanup());

const SOCK = '/run/docker-svc/docker.sock';
const FLAGS = ['--docker', 'shared', '--docker-socket', SOCK, '--accept-shared-daemon'];
const STUBS = [
  'as_root() { echo "as_root $*" >> "$STUB_LOG"; }',
  'install_admin_tools() { :; }',
  'install_docker_binaries() { :; }',
  `policy_value() { case "$1" in docker) echo shared ;; dockerHost) echo ${SOCK} ;; esac; }`,
].join('\n');
const DEDICATED =
  'RUNNER_MODE=dedicated; RUNNER_AS=guildwise-runner; RUNNER_NAME=guildwise-runner; RUNNER_HOME=/home/guildwise-runner; RUNNER_ROOT=/home/guildwise-runner/r';
const lines = (log: string) => log.split('\n').filter(Boolean);

describe('the shared Docker daemon is recorded by the runner, after root', () => {
  it('dedicated user: guildwise-admin docker shared first, then the record step as the runner', () => {
    setup = shHome();
    const r = runSh(
      setup,
      `parse_flags "$@"; ${STUBS}; ${DEDICATED}
record_supported() { return 0; }
runner() { echo "runner $*" >> "$STUB_LOG"; }
apply_root_choices`,
      { args: FLAGS },
    );
    expect(r.status, r.stderr).toBe(0);
    const log = lines(r.log);
    const adminAt = log.findIndex((l) => l.includes('guildwise-admin docker shared'));
    const recordAt = log.indexOf('runner policy record-shared-docker');
    expect(adminAt).toBeGreaterThanOrEqual(0);
    expect(recordAt).toBeGreaterThan(adminAt);
    // root writes nothing of the policy: no root step touches it
    expect(log.filter((l) => l.startsWith('as_root')).join('\n')).not.toContain('policy.json');
  });

  it('a failed record step stops the install with the manual command (never a runner that refuses to start)', () => {
    setup = shHome();
    const r = runSh(
      setup,
      `parse_flags "$@"; ${STUBS}; ${DEDICATED}
record_supported() { return 0; }
runner() { echo "runner $*" >> "$STUB_LOG"; return 1; }
apply_root_choices; echo "not reached"`,
      { args: FLAGS },
    );
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('not reached');
    expect(r.stderr).toContain('could not record the shared Docker daemon');
    expect(r.stderr).toContain(
      'sudo -u guildwise-runner -H /home/guildwise-runner/.local/bin/guildwise-runner policy record-shared-docker',
    );
  });

  it('your own account: a fresh login through sudo -n -u <you>, with the runner folders passed on', () => {
    setup = shHome();
    const r = runSh(
      setup,
      `parse_flags "$@"; ${STUBS}
RUNNER_MODE=current; RUNNER_AS=""; RUNNER_NAME="$(id -un)"; RUNNER_HOME="$HOME"; RUNNER_ROOT="$HOME/r"
record_supported() { return 0; }
sudo() { echo "sudo $*" >> "$STUB_LOG"; }
apply_root_choices`,
      {
        args: [...FLAGS, '--runner-user', 'current'],
        env: { AOM_RUNNER_HOME: '/data/runner-x', AOM_RUNNER_POLICY_DIR: '/data/policy-x' },
      },
    );
    expect(r.status, r.stderr).toBe(0);
    const record = lines(r.log).find((l) => l.endsWith('policy record-shared-docker')) ?? '';
    expect(record).toMatch(/^sudo -n -u \S+ -H env HOME=\S+ PATH=\S+ /);
    expect(record).toContain('AOM_RUNNER_HOME=/data/runner-x');
    expect(record).toContain('AOM_RUNNER_POLICY_DIR=/data/policy-x');
    expect(record).toContain(`${r.home}/r/current/aom-runner policy record-shared-docker`);
    // the group is joined first
    expect(r.log.indexOf('guildwise-admin docker shared')).toBeLessThan(r.log.indexOf(record));
  });

  it('your own account: unset runner folders are not passed on', () => {
    setup = shHome();
    const r = runSh(
      setup,
      `parse_flags "$@"; ${STUBS}
RUNNER_MODE=current; RUNNER_AS=""; RUNNER_NAME="$(id -un)"; RUNNER_HOME="$HOME"; RUNNER_ROOT="$HOME/r"
record_supported() { return 0; }
sudo() { echo "sudo $*" >> "$STUB_LOG"; }
apply_root_choices`,
      { args: [...FLAGS, '--runner-user', 'current'] },
    );
    expect(r.status, r.stderr).toBe(0);
    const record = lines(r.log).find((l) => l.endsWith('policy record-shared-docker')) ?? '';
    expect(record).not.toContain('AOM_RUNNER_HOME');
    expect(record).not.toContain('AOM_RUNNER_POLICY_DIR');
  });

  it('your own account: sudo refusing -u <you> stops with "log out and in again" and the manual command', () => {
    setup = shHome();
    const r = runSh(
      setup,
      `parse_flags "$@"; ${STUBS}
RUNNER_MODE=current; RUNNER_AS=""; RUNNER_NAME="$(id -un)"; RUNNER_HOME="$HOME"; RUNNER_ROOT="$HOME/r"
record_supported() { return 0; }
sudo() { echo "sudo $*" >> "$STUB_LOG"; return 1; }
apply_root_choices; echo "not reached"`,
      { args: [...FLAGS, '--runner-user', 'current'] },
    );
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('not reached');
    expect(r.stderr).toContain('Log out and in again, then run:');
    expect(r.stderr).toContain(`${r.home}/.local/bin/guildwise-runner policy record-shared-docker`);
    // only the probe ran: the record step itself never started
    expect(r.log).not.toContain('aom-runner policy record-shared-docker');
  });

  it('a runner release without the verb: the install stops with a clear message (never a quiet skip)', () => {
    setup = shHome();
    const r = runSh(
      setup,
      `parse_flags "$@"; ${STUBS}; ${DEDICATED}
record_supported() { return 1; }
runner() { echo "runner $*" >> "$STUB_LOG"; }
apply_root_choices; echo "not reached"`,
      { args: FLAGS },
    );
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('not reached');
    expect(r.stderr).toContain('cannot record the shared Docker daemon in its sealed policy');
    expect(r.stderr).toContain('the runner would refuse to start');
    expect(r.stderr).toContain('Install the current runner release');
    expect(r.log).not.toContain('runner policy record-shared-docker');
  });

  it.each([
    [
      'an older runner (commander prints the parent help for an unknown verb)',
      'Usage: guildwise-runner policy [options] [command]\n\nCommands:\n  accept  seal it\n',
      false,
    ],
    ['this runner', 'Usage: guildwise-runner policy record-shared-docker [options]\n', true],
    // REVIEW nit 1: a large help (many pipe chunks) still counts; it is captured whole, never cut short by grep -q
    [
      'this runner with a long help text',
      `Usage: guildwise-runner policy record-shared-docker [options]\n${'x'.repeat(200_000)}\n`,
      true,
    ],
  ])('record_supported: %s', (_name, help, supported) => {
    setup = shHome();
    const bin = join(setup.home, 'r', 'current');
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, 'aom-runner'),
      `#!/bin/bash\nprintf '%s' '${help.replaceAll("'", '')}'\nexit 0\n`,
    );
    chmodSync(join(bin, 'aom-runner'), 0o755);
    const r = runSh(
      setup,
      `RUNNER_AS=""; RUNNER_ROOT="$HOME/r"; RUNNER_CA=""
if record_supported; then echo yes; else echo no; fi`,
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(supported ? 'yes' : 'no');
  });

  it('record_supported: no runner at all is "not supported" (and so the install stops)', () => {
    setup = shHome();
    const r = runSh(
      setup,
      `RUNNER_AS=""; RUNNER_ROOT="$HOME/missing"; RUNNER_CA=""
if record_supported; then echo yes; else echo no; fi`,
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('no');
  });
});
