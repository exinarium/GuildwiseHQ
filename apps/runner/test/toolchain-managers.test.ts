import type { DevOpsAccess, EnvEnsurePayload } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { checkInstall } from '../src/devops/rights.ts';
import { ensureEnvironment, type RootRunner } from '../src/toolchain/ensure.ts';
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
const root = (mode: 'root' | 'passwordless' | 'none'): RootRunner => ({
  mode: async () => ({ mode, detail: mode }),
  run: async () => ok(),
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

describe('rights: install on each distribution', () => {
  const linux = (present: string[], mode: 'root' | 'none') => ({
    exec: machine(present).exec,
    root: root(mode),
    platform: 'linux' as Platform,
    sudoPasswordStored: false,
  });

  it.each(['apt-get', 'dnf', 'yum', 'pacman', 'zypper', 'apk'])(
    '%s is found and needs administrator rights',
    async (cmd) => {
      const a = await checkInstall(linux([cmd], 'none'), access());
      expect(a.status).toBe('failed');
      expect(a.reason).toContain('administrator rights');
      const b = await checkInstall(linux([cmd], 'root'), access());
      expect(b).toMatchObject({ status: 'verified' });
    },
  );

  it('Arch: pacman found, verified as root', async () => {
    const r = await checkInstall(linux(['pacman'], 'root'), access());
    expect(r.reason).toContain('pacman');
  });

  it('Homebrew on Linux needs no administrator rights', async () => {
    expect(
      (await checkInstall(linux(['/home/linuxbrew/.linuxbrew/bin/brew'], 'none'), access())).status,
    ).toBe('verified');
  });

  it('no manager: names everything it looked for and how to get one', async () => {
    const r = await checkInstall(linux([], 'none'), access());
    expect(r.status).toBe('failed');
    for (const c of ['apt-get', 'dnf', 'yum', 'pacman', 'zypper', 'apk', 'brew'])
      expect(r.reason).toContain(c);
    expect(r.fix).toContain('pacman');
    expect(r.fix).toContain('Homebrew');
  });

  it('macOS: Homebrew found at /opt/homebrew even though PATH lacks it', async () => {
    const r = await checkInstall(
      {
        exec: machine(['/opt/homebrew/bin/brew']).exec,
        root: root('none'),
        platform: 'darwin',
        sudoPasswordStored: false,
      },
      access(),
    );
    expect(r.status).toBe('verified');
  });
});

describe('env.ensure installs with the detected manager', () => {
  async function run(
    present: string[],
    rootMode: 'passwordless' | 'none' = 'passwordless',
    platform: Platform = 'linux',
  ) {
    const m = machine(present);
    const dir = tmp('aom-mgr-');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(`${dir}/go.mod`, 'go 1.22\n');
    const rootCalls: string[] = [];
    const rr: RootRunner = {
      mode: async () => ({ mode: rootMode, detail: rootMode }),
      run: async (cmd, args) => {
        rootCalls.push([cmd, ...args].join(' '));
        return ok();
      },
    };
    const payload: EnvEnsurePayload = {
      requestId: '0190aaaa-0000-7000-8000-00000000ffff',
      projectId: '0190aaaa-0000-7000-8000-000000000001',
      repos: [{ repoId: '0190aaaa-0000-7000-8000-0000000000a1', name: 'app', remoteUrlNormalized: 'x/y' }],
      access: access({ sudo: true }),
    };
    const r = await ensureEnvironment(payload, {
      exec: m.exec,
      platform,
      root: rr,
      findRepo: async () => ({ localPath: dir }),
      installDependencies: false,
    });
    return { r, calls: m.calls, rootCalls };
  }

  it.each([
    ['apt-get', 'apt-get install -y golang-go'],
    ['dnf', 'dnf install -y golang'],
    ['yum', 'yum install -y golang'],
    ['pacman', 'pacman -S --noconfirm --needed go'],
    ['zypper', 'zypper --non-interactive install go'],
    ['apk', 'apk add go'],
  ])('%s installs Go as root', async (cmd, line) => {
    const { rootCalls } = await run([cmd]);
    expect(rootCalls).toEqual([line]);
  });

  it('Linux Homebrew is a fallback with no root, run by its absolute path', async () => {
    const brew = '/home/linuxbrew/.linuxbrew/bin/brew';
    const { calls, rootCalls } = await run([brew], 'none');
    expect(rootCalls).toEqual([]);
    expect(calls).toContain(`${brew} install go`);
  });

  it('with administrator rights missing, a system manager is skipped for Homebrew', async () => {
    const { calls, rootCalls } = await run(['pacman', 'brew'], 'none');
    expect(rootCalls).toEqual([]);
    expect(calls).toContain('brew install go');
  });

  it('macOS: brew from /opt/homebrew is run by path', async () => {
    const { calls } = await run(['/opt/homebrew/bin/brew'], 'none', 'darwin');
    expect(calls).toContain('/opt/homebrew/bin/brew install go');
  });

  it('no package manager: a clear message that lists what was looked for', async () => {
    const { r } = await run([]);
    const go = r.tools.find((t) => t.tool === 'Go');
    expect(go?.status).toBe('failed');
    expect(go?.detail).toContain('no package manager found');
    expect(go?.detail).toContain('pacman');
    expect(go?.fix).toContain('Install one of');
  });
});
