import { accessSync, constants, mkdirSync, statSync } from 'node:fs';
import type { DevOpsAccess, RightCheck, RightsReport } from '@aom/shared';
import type { Executor } from '../toolchain/exec.ts';
import type { Platform } from '../toolchain/types.ts';
import { toolchainsRoot } from '../toolchain/user-install.ts';

export interface RightsDeps {
  exec: Executor;
  platform: Platform;
  /** Test hook: the toolchains folder (default: under the runner account's passwd home). */
  toolchainsRoot?: string;
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
      'The installer sets up Docker for the runner (rootless by default): run the installer again.',
    );
  if (/permission denied/i.test(out))
    return bad(
      `the runner user may not use Docker: ${clip(out)}`,
      deps.platform === 'linux'
        ? 'The runner uses its own rootless Docker: run the installer again to set it up (the docker group is root-equivalent and refused at start-up).'
        : 'Start Docker Desktop with the same user that runs the runner.',
    );
  if (/cannot connect|is the docker daemon running|daemon/i.test(out))
    return bad(
      `the Docker daemon is not running: ${clip(out)}`,
      deps.platform === 'linux'
        ? "Start the runner's own daemon as the runner user: systemctl --user start docker (or run the installer again)"
        : 'Start Docker Desktop and wait until it says it is running.',
    );
  return bad(
    `docker info failed: ${clip(out)}`,
    'Run `docker info` as the runner user and fix what it reports.',
  );
}

/**
 * "Install packages and tools" (1.10.0): stack tools go into the runner account's own toolchains folder, checksum
 * checked; nothing runs as root and no package manager is run. System packages stay the machine owner's job.
 */
export async function checkInstall(deps: RightsDeps): Promise<RightCheck> {
  const root = deps.toolchainsRoot ?? toolchainsRoot();
  if (deps.platform === 'win32')
    return bad(
      'stack tools are installed inside the dedicated WSL distro, not on Windows itself',
      'Run the runner in its WSL distro (the Windows installer sets it up).',
    );
  try {
    mkdirSync(root, { recursive: true, mode: 0o755 });
    accessSync(root, constants.W_OK);
  } catch (err) {
    return bad(
      `${root} is not writable (${(err as NodeJS.ErrnoException).code ?? 'error'})`,
      "Give the runner user its own home folder back (the toolchains live under the runner's own home only).",
    );
  }
  return ok(
    `stack tools install into ${root} as the runner user (checksum checked); system packages are the machine owner's job`,
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
  if (access.allowInstall) checks.install = await checkInstall(deps);
  if (access.allowedPaths.length) checks.paths = checkPaths(access.allowedPaths);
  return {
    checkedAt: new Date().toISOString(),
    platform: deps.platform,
    checks,
  };
}
