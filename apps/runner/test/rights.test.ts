import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DevOpsAccess } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { checkDocker, checkInstall, checkPaths, verifyRights } from '../src/devops/rights.ts';
import type { RootRunner } from '../src/toolchain/ensure.ts';
import type { ExecResult, Executor } from '../src/toolchain/exec.ts';
import type { Platform } from '../src/toolchain/types.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

const ok = (stdout = ''): ExecResult => ({ exitCode: 0, stdout, stderr: '' });
const fail = (stderr: string, exitCode = 1): ExecResult => ({ exitCode, stdout: '', stderr });

const exec = (answers: Record<string, ExecResult>): Executor => ({
  async run(cmd, args) {
    return answers[[cmd, ...args].join(' ')] ?? fail('not found', 127);
  },
});
const root = (mode: Awaited<ReturnType<RootRunner['mode']>>['mode'], detail: string = mode): RootRunner => ({
  mode: async () => ({ mode, detail }),
  run: async () => ok(),
});
const deps = (
  answers: Record<string, ExecResult>,
  platform: Platform = 'linux',
  mode: 'root' | 'none' = 'none',
) => ({
  exec: exec(answers),
  root: root(mode),
  platform,
  sudoPasswordStored: false,
});
const access = (over: Partial<DevOpsAccess> = {}): DevOpsAccess => ({
  allowInstall: false,
  allowDocker: false,
  allowedPaths: [],
  sudo: false,
  ...over,
});
const DOCKER_INFO = 'docker info --format {{.ServerVersion}}';

describe('rights: docker', () => {
  it('verified when docker info answers', async () => {
    const r = await checkDocker(deps({ [DOCKER_INFO]: ok('27.1.1') }));
    expect(r).toMatchObject({ status: 'verified' });
    expect(r.reason).toContain('27.1.1');
  });

  it.each([
    [fail('', 127), 'not installed', 'Install Docker'],
    [
      fail('permission denied while trying to connect to the Docker daemon socket'),
      'may not use Docker',
      'usermod -aG docker',
    ],
    [
      fail(
        'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
      ),
      'not running',
      'systemctl enable --now docker',
    ],
    [fail('something odd'), 'docker info failed', 'Run `docker info`'],
  ])('failed with a reason and a fix: %#', async (res, reason, fix) => {
    const r = await checkDocker(deps({ [DOCKER_INFO]: res }));
    expect(r.status).toBe('failed');
    expect(r.reason).toContain(reason);
    expect(r.fix).toContain(fix);
  });

  it('on macOS and Windows the fix is Docker Desktop, not systemctl', async () => {
    const r = await checkDocker(
      deps({ [DOCKER_INFO]: fail('Cannot connect to the Docker daemon') }, 'darwin'),
    );
    expect(r.fix).toContain('Docker Desktop');
  });
});

describe('rights: install', () => {
  it('apt needs administrator rights: failed without them, verified with root', async () => {
    const answers = { 'apt-get --version': ok('apt 2.7') };
    const a = await checkInstall(deps(answers), access({ allowInstall: true }));
    expect(a.status).toBe('failed');
    expect(a.fix).toContain('Administrator (sudo)');
    const b = await checkInstall(deps(answers, 'linux', 'root'), access({ allowInstall: true }));
    expect(b).toMatchObject({ status: 'verified' });
  });

  it('brew and winget need none', async () => {
    expect(
      (await checkInstall(deps({ 'brew --version': ok('Homebrew 4') }, 'darwin'), access())).status,
    ).toBe('verified');
    expect((await checkInstall(deps({ 'winget --version': ok('v1.7') }, 'win32'), access())).status).toBe(
      'verified',
    );
  });

  it('no package manager at all fails and says what still works', async () => {
    const r = await checkInstall(deps({}, 'darwin'), access());
    expect(r.status).toBe('failed');
    expect(r.fix).toContain('Homebrew');
  });
});

describe('rights: paths', () => {
  it('writable folders verify; missing or unwritable ones fail by name', () => {
    const dir = tmp('aom-rights-');
    const sub = join(dir, 'deploy');
    mkdirSync(sub);
    writeFileSync(join(dir, 'file'), '');
    expect(checkPaths([sub]).status).toBe('verified');
    const r = checkPaths([sub, join(dir, 'nope'), join(dir, 'file')]);
    expect(r.status).toBe('failed');
    expect(r.reason).toContain('nope: does not exist');
    expect(r.reason).toContain('file is not a directory');
  });
});

describe('verifyRights', () => {
  it('checks only the rights that are ticked, and says whether a sudo password is stored', async () => {
    const report = await verifyRights(access({ allowDocker: true, sudo: true }), {
      ...deps({ [DOCKER_INFO]: ok('27') }, 'linux', 'root'),
      sudoPasswordStored: true,
    });
    expect(Object.keys(report.checks).sort()).toEqual(['docker', 'sudo']);
    expect(report.checks.sudo?.status).toBe('verified');
    expect(report.sudoPasswordStored).toBe(true);
    expect(report.platform).toBe('linux');
    expect(await verifyRights(access(), deps({}))).toMatchObject({ checks: {} });
  });

  it('sudo without a working way says to enter the password; on Windows to run elevated', async () => {
    const lin = await verifyRights(access({ sudo: true }), {
      ...deps({}),
      root: root('none', 'sudo needs a password and none is stored'),
    });
    expect(lin.checks.sudo?.status).toBe('failed');
    expect(lin.checks.sudo?.fix).toContain('Enter the sudo password');
    const win = await verifyRights(access({ sudo: true }), {
      ...deps({}, 'win32'),
      root: root('unsupported', 'the runner is not elevated'),
    });
    expect(win.checks.sudo?.fix).toContain('Administrator');
  });
});
