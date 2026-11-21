import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DevOpsAccess } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { checkDocker, checkInstall, checkPaths, verifyRights } from '../src/devops/rights.ts';
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
const deps = (
  answers: Record<string, ExecResult>,
  platform: Platform = 'linux',
  toolchainsRoot?: string,
) => ({
  exec: exec(answers),
  platform,
  ...(toolchainsRoot ? { toolchainsRoot } : {}),
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
    [fail('', 127), 'not installed', 'run the installer again'],
    [
      fail('permission denied while trying to connect to the Docker daemon socket'),
      'may not use Docker',
      'own rootless Docker',
    ],
    [
      fail(
        'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
      ),
      'not running',
      'systemctl --user start docker',
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

describe('rights: install (user space only since 1.10.0)', () => {
  it("verified when the runner's toolchains folder is writable; never asks for administrator rights", async () => {
    const dir = join(tmp('aom-rights-'), 'toolchains');
    const r = await checkInstall(deps({}, 'linux', dir));
    expect(r.status).toBe('verified');
    expect(r.reason).toContain(dir);
    expect(`${r.reason} ${r.fix ?? ''}`).not.toMatch(/sudo|Administrator/);
  });

  it('fails when the folder cannot be written', async () => {
    const base = tmp('aom-rights-');
    writeFileSync(join(base, 'file'), '');
    const r = await checkInstall(deps({}, 'linux', join(base, 'file', 'toolchains')));
    expect(r.status).toBe('failed');
  });

  it('on Windows the tools live in the WSL distro', async () => {
    expect((await checkInstall(deps({}, 'win32'))).fix).toContain('WSL');
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
  it('checks only the rights that are ticked; a sudo tick from the server is never checked (removed)', async () => {
    const report = await verifyRights(
      access({ allowDocker: true, sudo: true }),
      deps({ [DOCKER_INFO]: ok('27') }),
    );
    expect(Object.keys(report.checks).sort()).toEqual(['docker']);
    expect(report).not.toHaveProperty('sudoPasswordStored');
    expect(report.platform).toBe('linux');
    expect(await verifyRights(access(), deps({}))).toMatchObject({ checks: {} });
  });
});
