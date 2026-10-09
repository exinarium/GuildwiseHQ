import { accessSync, constants, statSync } from 'node:fs';
import type { DevOpsAccess, RightCheck, RightsReport } from '@aom/shared';
import type { RootRunner } from '../toolchain/ensure.ts';
import type { Executor } from '../toolchain/exec.ts';
import type { Platform } from '../toolchain/types.ts';

export interface RightsDeps {
  exec: Executor;
  root: RootRunner;
  platform: Platform;
  sudoPasswordStored: boolean;
}

const ok = (reason: string): RightCheck => ({ status: 'verified', reason });
const bad = (reason: string, fix: string): RightCheck => ({ status: 'failed', reason, fix });
const clip = (s: string): string => s.trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300);

/** `docker info` as the runner user: what the DevOps engineer's Docker access really is. */
export async function checkDocker(deps: RightsDeps): Promise<RightCheck> {
  const r = await deps.exec.run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 20_000 });
  if (r.exitCode === 0) return ok(`docker info answers (server ${r.stdout.trim() || 'running'})`);
  const out = `${r.stderr}\n${r.stdout}`;
  if (r.exitCode === 127 || /not found|no such file|not recognized/i.test(out))
    return bad(
      'Docker is not installed on this workstation',
      'Install Docker (the DevOps engineer can, with "Install packages and tools" ticked), or install it yourself: https://docs.docker.com/engine/install/',
    );
  if (/permission denied/i.test(out))
    return bad(
      `the runner user may not use Docker: ${clip(out)}`,
      deps.platform === 'linux'
        ? 'Add the runner user to the docker group: sudo usermod -aG docker $USER, then log in again and restart the runner.'
        : 'Start Docker Desktop with the same user that runs the runner.',
    );
  if (/cannot connect|is the docker daemon running|daemon/i.test(out))
    return bad(
      `the Docker daemon is not running: ${clip(out)}`,
      deps.platform === 'linux'
        ? 'Start it: sudo systemctl enable --now docker'
        : 'Start Docker Desktop and wait until it says it is running.',
    );
  return bad(
    `docker info failed: ${clip(out)}`,
    'Run `docker info` as the runner user and fix what it reports.',
  );
}

export async function checkSudo(deps: RightsDeps): Promise<RightCheck> {
  const m = await deps.root.mode();
  if (m.mode === 'root' || m.mode === 'passwordless' || m.mode === 'password') return ok(m.detail);
  if (deps.platform === 'win32')
    return bad(
      'the runner is not elevated',
      'Run the runner as Administrator (an elevated terminal, or a service running as an administrator account). Windows has no sudo password to store.',
    );
  return bad(
    m.detail,
    m.detail.includes('not accepted')
      ? 'Enter the sudo password again below.'
      : 'Enter the sudo password below (it is encrypted for this workstation and stored only there), or allow passwordless sudo for the runner user (a NOPASSWD line in /etc/sudoers.d).',
  );
}

const PACKAGE_MANAGERS: Record<Platform, Array<{ id: string; cmd: string; needsRoot: boolean }>> = {
  linux: [
    { id: 'apt', cmd: 'apt-get', needsRoot: true },
    { id: 'dnf', cmd: 'dnf', needsRoot: true },
  ],
  darwin: [{ id: 'brew', cmd: 'brew', needsRoot: false }],
  win32: [
    { id: 'winget', cmd: 'winget', needsRoot: false },
    { id: 'choco', cmd: 'choco', needsRoot: true },
  ],
};

export async function checkInstall(deps: RightsDeps, access: DevOpsAccess): Promise<RightCheck> {
  const found: Array<{ id: string; needsRoot: boolean }> = [];
  for (const m of PACKAGE_MANAGERS[deps.platform]) {
    if ((await deps.exec.run(m.cmd, ['--version'], { timeoutMs: 15_000 })).exitCode === 0) found.push(m);
  }
  if (!found.length)
    return bad(
      `no package manager found (looked for ${PACKAGE_MANAGERS[deps.platform].map((m) => m.id).join(', ')})`,
      deps.platform === 'darwin'
        ? 'Install Homebrew (https://brew.sh); the official installers of .NET, Rust and Bun also work without it.'
        : 'Install a package manager; tool installers without one (dotnet-install, rustup) still work for those stacks.',
    );
  const mode = (await deps.root.mode()).mode;
  const rootUsable = mode === 'root' || (access.sudo && (mode === 'passwordless' || mode === 'password'));
  const usable = found.filter((m) => !m.needsRoot || rootUsable);
  if (!usable.length)
    return bad(
      `${found.map((m) => m.id).join(', ')} found, but installing system packages needs administrator rights`,
      deps.platform === 'win32'
        ? 'Run the runner elevated.'
        : 'Also tick "Administrator (sudo)" and make sure it is verified; user-level installers (dotnet-install, rustup, npm -g) work without it.',
    );
  return ok(
    `${usable.map((m) => m.id).join(', ')} available${rootUsable ? ' with administrator rights' : ''}`,
  );
}

export function checkPaths(paths: string[]): RightCheck {
  const problems: string[] = [];
  for (const p of paths) {
    try {
      if (!statSync(p).isDirectory()) problems.push(`${p} is not a directory`);
      else accessSync(p, constants.W_OK);
    } catch (err) {
      problems.push(
        `${p}: ${(err as NodeJS.ErrnoException).code === 'ENOENT' ? 'does not exist' : 'not writable'}`,
      );
    }
  }
  return problems.length
    ? bad(problems.join('; '), 'Create the folder or give the runner user write access to it.')
    : ok(`${paths.length} folder${paths.length === 1 ? '' : 's'} writable`);
}

/** Checks each right the manager ticked. A right that is off has no entry. */
export async function verifyRights(access: DevOpsAccess, deps: RightsDeps): Promise<RightsReport> {
  const checks: Record<string, RightCheck> = {};
  if (access.allowDocker) checks.docker = await checkDocker(deps);
  if (access.sudo) checks.sudo = await checkSudo(deps);
  if (access.allowInstall) checks.install = await checkInstall(deps, access);
  if (access.allowedPaths.length) checks.paths = checkPaths(access.allowedPaths);
  return {
    checkedAt: new Date().toISOString(),
    platform: deps.platform,
    checks,
    sudoPasswordStored: deps.sudoPasswordStored,
  };
}
