import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Executor } from './exec.ts';
import type { Manager, Platform } from './types.ts';

/** One package manager the runner knows: how to find it and whether installing with it needs administrator rights. */
export interface ManagerDef {
  id: Manager;
  /** The command on PATH (also the first word of the install steps in `stacks.ts`). */
  cmd: string;
  needsRoot: boolean;
  /** Absolute locations tried when `cmd` is not on the service's PATH (Homebrew is installed outside it). */
  fallbackPaths?: (home: string) => string[];
}

const BREW_MAC = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];

/**
 * In detection order: the first working manager that can install a tool is used. Homebrew on Linux comes last and is
 * a fallback (needs no root).
 */
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
    return 'Install Homebrew (https://brew.sh); the official installers of .NET, Rust and Bun also work without it.';
  if (platform === 'win32')
    return 'Install winget (App Installer from the Microsoft Store) or Chocolatey; tool installers without one (dotnet-install, rustup) still work for those stacks.';
  return 'Install one of apt, dnf/yum (Fedora, RHEL), pacman (Arch, Manjaro), zypper (openSUSE), apk (Alpine) or Homebrew (https://brew.sh, no root needed); tool installers without one (dotnet-install, rustup) still work for those stacks.';
}
