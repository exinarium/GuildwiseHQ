import type { InstallerOs } from '@aom/shared';

/** Plain-language content of the "Add a workstation" wizard, kept as data so the wizard and its tests share it. */

export type LinuxFlavour = 'ubuntu' | 'fedora' | 'arch';

export const OS_OPTIONS: Array<{ value: InstallerOs; label: string; sub: string }> = [
  { value: 'windows', label: 'Windows', sub: 'Runs inside WSL2 (Ubuntu on Windows)' },
  { value: 'linux', label: 'Linux', sub: 'Ubuntu, Debian, Fedora, Arch' },
  { value: 'macos', label: 'macOS', sub: 'Intel and Apple silicon' },
];

export const LINUX_FLAVOURS: Array<{ value: LinuxFlavour; label: string; note: string }> = [
  {
    value: 'ubuntu',
    label: 'Ubuntu / Debian',
    note: 'The installer uses apt to add git, bubblewrap and socat.',
  },
  { value: 'fedora', label: 'Fedora', note: 'The installer uses dnf to add git, bubblewrap and socat.' },
  { value: 'arch', label: 'Arch', note: 'The installer uses pacman to add git, bubblewrap and socat.' },
];

/** Best guess of the visitor's system from the browser (the wizard lets them change it). */
export function detectOs(
  nav: Pick<Navigator, 'userAgent' | 'platform'> & { userAgentData?: { platform?: string } },
): InstallerOs {
  const raw =
    `${nav.userAgentData?.platform ?? ''} ${nav.platform ?? ''} ${nav.userAgent ?? ''}`.toLowerCase();
  if (/win/.test(raw) && !/darwin/.test(raw)) return 'windows';
  if (/mac|iphone|ipad|darwin/.test(raw)) return 'macos';
  if (/linux|x11|cros/.test(raw)) return 'linux';
  return 'windows';
}

export interface GuideStep {
  id: string;
  title: string;
  body: string;
  /** Which illustration to draw. */
  art: 'terminal' | 'paste' | 'shield' | 'restart' | 'user' | 'login' | 'done';
  /** The step shows the copy-able command. */
  command?: boolean;
}

const terminal: Record<InstallerOs, string> = {
  windows: 'Press the Windows key, type PowerShell and press Enter. A blue or black window opens.',
  linux: 'Open a terminal (on most systems: press Ctrl + Alt + T).',
  macos: 'Press Command + Space, type Terminal and press Enter. A window with a text prompt opens.',
};

const permission: Record<InstallerOs, string> = {
  windows:
    'Windows asks once whether the installer may make changes: answer Yes. It turns on Linux inside Windows (WSL2) and installs Ubuntu. If Windows asks to restart, say yes: the installer carries on by itself when you sign in again.',
  linux:
    'It may ask for your password once to install git and the sandbox tools. Nothing is typed on screen while you enter it; that is normal.',
  macos:
    'It may ask for your Mac password once to install Homebrew, the standard tool installer for Macs. Nothing shows while you type it; that is normal.',
};

export function guideSteps(os: InstallerOs): GuideStep[] {
  const steps: GuideStep[] = [
    { id: 'open', title: 'Open a terminal on that computer', body: terminal[os], art: 'terminal' },
    {
      id: 'paste',
      title: 'Paste the command and press Enter',
      body: 'Copy the command below, paste it into the window (right-click, or Ctrl + V) and press Enter. This page follows along.',
      art: 'paste',
      command: true,
    },
    {
      id: 'allow',
      title: 'Say yes when it asks',
      body: permission[os],
      art: os === 'windows' ? 'restart' : 'shield',
    },
  ];
  if (os === 'windows')
    steps.push({
      id: 'user',
      title: 'Choose an Ubuntu name and password',
      body: 'Only if asked. They are for the Linux inside your PC, not your Windows login. Write the password down: you need it when the installer adds tools.',
      art: 'user',
    });
  steps.push(
    {
      id: 'signin',
      title: 'Sign in to Claude when asked',
      body: 'Your agents run on Claude. A Claude subscription (Pro, Max, Team) signs in with your Claude account in a browser and counts against your plan. An API key is billed per use. The installer explains both; pick whichever your organization uses.',
      art: 'login',
    },
    {
      id: 'done',
      title: 'Wait for the green tick here',
      body: 'This computer appears in your list as soon as it connects, and the health checks show below. You can run the same command again at any time to upgrade or repair.',
      art: 'done',
    },
  );
  return steps;
}

/** What the installer changes on the computer, for people who want to know before they run it. */
export function whatItDoes(os: InstallerOs): string[] {
  const common = [
    'Downloads the runner from this server and checks its checksum.',
    'Pairs it with your account using a one-time code that expires in 30 minutes.',
    'Asks which folders hold your code (suggests ~/src).',
    'Starts the runner as a background service that comes back after a restart.',
    'Runs the runner health check (aom-runner doctor) and reports it to this page.',
  ];
  if (os === 'windows')
    return [
      'Turns on WSL2 and installs Ubuntu if they are missing (may restart Windows once).',
      'Sets systemd=true in Ubuntu, vmIdleTimeout=-1 in .wslconfig and adds a "Guildwise HQ runner" task so Ubuntu stays running (and removes the older "WSL Boot" task).',
      'Then runs the Linux installer inside Ubuntu: Node 22, git, Claude Code, bubblewrap and socat, optional yt-dlp and Docker (it asks first).',
      ...common,
    ];
  if (os === 'macos')
    return [
      'Installs Homebrew if missing (it asks first), then Node 22 and git.',
      'Installs Claude Code, and optionally yt-dlp and Docker Desktop (it asks first).',
      ...common.slice(0, -2),
      'Installs a launchd agent so the runner starts at login and restarts if it stops.',
      common[4] as string,
    ];
  return [
    'Installs git, bubblewrap and socat with your package manager (asks for your password).',
    'Installs Node 22 (with nvm) and Claude Code, and optionally yt-dlp and Docker (it asks first).',
    ...common.slice(0, -2),
    'Installs a systemd user service and turns on lingering so it keeps running when you log out.',
    common[4] as string,
  ];
}
