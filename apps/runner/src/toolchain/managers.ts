import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Executor } from './exec.ts';
import type { Manager, Platform } from './types.ts';

/**
 * One package manager the runner knows: how to find it and whether installing with it needs administrator rights.
 * 1.10.0: managers are never run to install; they only name the owner's command for a system package.
 */
export interface ManagerDef {
  id: Manager;
  /** The command on PATH (also the first word of the install steps in `stacks.ts`). */
  cmd: string;
  needsRoot: boolean;
  /** Absolute locations tried when `cmd` is not on the service's PATH (Homebrew is installed outside it). */
  fallbackPaths?: (home: string) => string[];
}

const BREW_MAC = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];

/** In detection order: the first manager found names the owner's command. Homebrew on Linux comes last. */
export const MANAGER_DEFS: Record<Platform, ManagerDef[]> = {
  linux: [
    { id: 'apt', cmd: 'apt-get', needsRoot: true },
    { id: 'dnf', cmd: 'dnf', needsRoot: true },
    { id: 'yum', cmd: 'yum', needsRoot: true },
    { id: 'pacman', cmd: 'pacman', needsRoot: true },
    { id: 'zypper', cmd: 'zypper', needsRoot: true },
    { id: 'apk', cmd: 'apk', needsRoot: true },
    {
      id: 'brew',
      cmd: 'brew',
      needsRoot: false,
      fallbackPaths: (home) => [
        '/home/linuxbrew/.linuxbrew/bin/brew',
        join(home, '.linuxbrew', 'bin', 'brew'),
      ],
    },
  ],
  darwin: [{ id: 'brew', cmd: 'brew', needsRoot: false, fallbackPaths: () => BREW_MAC }],
  win32: [
    { id: 'winget', cmd: 'winget', needsRoot: false },
    { id: 'choco', cmd: 'choco', needsRoot: true },
  ],
};

export interface DetectedManager extends ManagerDef {
  /** What to run: `cmd`, or the absolute path it was found at. */
  path: string;
}

/** Probes each manager of the platform (`--version`), then its fallback locations. Missing ones are left out. */
export async function detectManagers(
  exec: Executor,
  platform: Platform,
  home: string = homedir(),
): Promise<DetectedManager[]> {
  const out: DetectedManager[] = [];
  for (const def of MANAGER_DEFS[platform]) {
    for (const path of [def.cmd, ...(def.fallbackPaths?.(home) ?? [])]) {
      if ((await exec.run(path, ['--version'], { timeoutMs: 15_000 })).exitCode === 0) {
        out.push({ ...def, path });
        break;
      }
    }
  }
  return out;
}

/** The commands a platform is searched for, for messages ("looked for apt-get, dnf, ..."). */
export const managerCommands = (platform: Platform): string[] => MANAGER_DEFS[platform].map((m) => m.cmd);

/** The message for a workstation where no package manager is found, with how to get one. */
export function noManagerAdvice(platform: Platform): string {
  if (platform === 'darwin')
    return 'Install it yourself (for example with Homebrew, https://brew.sh); Guildwise does not install system packages.';
  if (platform === 'win32')
    return 'Install it yourself (for example with winget); Guildwise does not install system packages.';
  return 'Install it yourself with the package manager of this machine; Guildwise does not install system packages.';
}
