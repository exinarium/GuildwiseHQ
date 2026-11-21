import type { DevOpsAccess, EnvEnsurePayload } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { checkInstall } from '../src/devops/rights.ts';
import { ensureEnvironment, SYSTEM_DEPENDENCY } from '../src/toolchain/ensure.ts';
import type { ExecResult, Executor } from '../src/toolchain/exec.ts';
import { detectManagers } from '../src/toolchain/managers.ts';
import type { Platform } from '../src/toolchain/types.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

const ok = (stdout = ''): ExecResult => ({ exitCode: 0, stdout, stderr: '' });
const fail = (): ExecResult => ({ exitCode: 127, stdout: '', stderr: 'not found' });

/** A machine where only these commands (by exact command word) answer `--version`; records every call. */
function machine(present: string[], extra: Record<string, ExecResult> = {}) {
  const calls: string[] = [];
  const answers = new Map<string, ExecResult>(Object.entries(extra));
  const exec: Executor = {
    async run(cmd, args) {
      const line = [cmd, ...args].join(' ');
      calls.push(line);
      if (args.length === 1 && args[0] === '--version' && present.includes(cmd)) return ok(`${cmd} 1.0`);
      return answers.get(line) ?? fail();
    },
  };
  return { exec, calls, answers };
}

const access = (over: Partial<DevOpsAccess> = {}): DevOpsAccess => ({
  allowInstall: true,
  allowDocker: false,
  allowedPaths: [],
  sudo: false,
  ...over,
});
describe('package manager detection per distribution', () => {
  it.each([
    ['Debian/Ubuntu', ['apt-get'], 'apt'],
    ['Fedora', ['dnf'], 'dnf'],
    ['older RHEL', ['yum'], 'yum'],
    ['Arch/Manjaro', ['pacman'], 'pacman'],
    ['openSUSE', ['zypper'], 'zypper'],
    ['Alpine', ['apk'], 'apk'],
    ['Linux with Homebrew on PATH', ['brew'], 'brew'],
    ['Linux Homebrew outside PATH', ['/home/linuxbrew/.linuxbrew/bin/brew'], 'brew'],
  ])('%s', async (_name, present, id) => {
    const found = await detectManagers(machine(present).exec, 'linux', '/home/u');
    expect(found.map((m) => m.id)).toEqual([id]);
  });

  it('finds Homebrew in the user folder on Linux', async () => {
    const found = await detectManagers(machine(['/home/u/.linuxbrew/bin/brew']).exec, 'linux', '/home/u');
    expect(found[0]).toMatchObject({ id: 'brew', path: '/home/u/.linuxbrew/bin/brew' });
  });

  it('macOS: Apple Silicon and Intel locations are found when PATH lacks brew', async () => {
    const arm = await detectManagers(machine(['/opt/homebrew/bin/brew']).exec, 'darwin');
    expect(arm[0]).toMatchObject({ id: 'brew', path: '/opt/homebrew/bin/brew' });
    const intel = await detectManagers(machine(['/usr/local/bin/brew']).exec, 'darwin');
    expect(intel[0]).toMatchObject({ id: 'brew', path: '/usr/local/bin/brew' });
  });

  it('a manager on PATH is used by its plain name; the order keeps system managers before Linux Homebrew', async () => {
    const found = await detectManagers(machine(['brew', 'pacman']).exec, 'linux', '/home/u');
    expect(found.map((m) => [m.id, m.path])).toEqual([
      ['pacman', 'pacman'],
      ['brew', 'brew'],
    ]);
  });
});

describe('rights: install is user space on every distribution', () => {
  it.each(['apt-get', 'dnf', 'yum', 'pacman', 'zypper', 'apk', '/home/linuxbrew/.linuxbrew/bin/brew'])(
    'with %s present: verified against the toolchains folder, no package manager asked',
    async (cmd) => {
      const m = machine([cmd]);
      const r = await checkInstall({ exec: m.exec, platform: 'linux', toolchainsRoot: tmp('aom-tc-') });
      expect(r.status).toBe('verified');
      expect(r.reason).toContain('as the runner user');
      expect(m.calls).toEqual([]);
    },
  );

  it('Windows: the tools go into the WSL distro', async () => {
    const r = await checkInstall({
      exec: machine([]).exec,
      platform: 'win32',
      toolchainsRoot: tmp('aom-tc-'),
    });
    expect(r.status).toBe('failed');
    expect(r.fix).toContain('WSL');
  });
});

describe("env.ensure never runs a package manager: it names the owner's command", () => {
  async function run(present: string[], platform: Platform = 'linux') {
    const m = machine(present);
    const dir = tmp('aom-mgr-');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(`${dir}/Gemfile`, '');
    const payload: EnvEnsurePayload = {
      requestId: '0190aaaa-0000-7000-8000-00000000ffff',
      projectId: '0190aaaa-0000-7000-8000-000000000001',
      repos: [{ repoId: '0190aaaa-0000-7000-8000-0000000000a1', name: 'app', remoteUrlNormalized: 'x/y' }],
      access: access(),
    };
    const r = await ensureEnvironment(payload, {
      exec: m.exec,
      platform,
      userInstaller: { install: async () => ({ ok: false, detail: 'not in this test' }) },
      findRepo: async () => ({ localPath: dir }),
      installDependencies: false,
    });
    return { r, calls: m.calls, ruby: r.tools.find((t) => t.tool === 'Ruby') };
  }

  it.each([
    ['apt-get', 'sudo apt-get install -y ruby-full'],
    ['dnf', 'sudo dnf install -y ruby'],
    ['yum', 'sudo yum install -y ruby'],
    ['pacman', 'sudo pacman -S --noconfirm --needed ruby'],
    ['zypper', 'sudo zypper --non-interactive install ruby'],
    ['apk', 'sudo apk add ruby'],
  ])('%s: the owner is shown the command; it never runs', async (cmd, line) => {
    const { ruby, calls } = await run([cmd]);
    expect(ruby).toMatchObject({ status: 'failed', detail: SYSTEM_DEPENDENCY });
    expect(ruby?.fix).toContain(`Ask the machine owner to run: ${line}`);
    expect(
      calls.filter((c) => !c.endsWith('--version') && !c.startsWith('ruby') && !c.startsWith('bundle')),
    ).toEqual([]);
  });

  it('Linux Homebrew outside PATH: shown by its absolute path, without sudo, not run', async () => {
    const brew = '/home/linuxbrew/.linuxbrew/bin/brew';
    const { ruby, calls } = await run([brew]);
    expect(ruby?.fix).toContain(`run: ${brew} install ruby`);
    expect(ruby?.fix).not.toContain('sudo');
    expect(calls).not.toContain(`${brew} install ruby`);
  });

  it('macOS (not yet tested on hardware): brew from /opt/homebrew is advice only', async () => {
    const { ruby, calls } = await run(['/opt/homebrew/bin/brew'], 'darwin');
    expect(ruby?.fix).toContain('/opt/homebrew/bin/brew install ruby');
    expect(calls).not.toContain('/opt/homebrew/bin/brew install ruby');
  });

  it('no package manager: the manual text and that Guildwise does not install system packages', async () => {
    const { ruby } = await run([]);
    expect(ruby?.status).toBe('failed');
    expect(ruby?.fix).toContain('ruby-lang.org');
    expect(ruby?.fix).toContain('Guildwise does not install system packages');
  });
});
