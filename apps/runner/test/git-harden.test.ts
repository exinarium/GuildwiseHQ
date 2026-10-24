import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { execa } from 'execa';
import { afterAll, describe, expect, it } from 'vitest';
import { buildShiftSettings, ruleAbs } from '../src/adapters/claude-policy.ts';
import { git } from '../src/git/git.ts';
import { GIT_HARDEN_ARGS, gitPointerProblem, protectedGitPaths } from '../src/git/harden.ts';
import { type HarnessSandboxInput, proxyEnv, wrapInHarnessSandbox } from '../src/sandbox/harness-sandbox.ts';
import { POLICY_PATHS, policyCtx } from './policy-fixtures.ts';

/**
 * Security review finding 9: the agent's sandbox writes `<cwd>/.git` and the worktree's admin folder, and the runner (or the
 * owner) later runs git there. A `core.fsmonitor` or a hook the agent planted would run on the host. Three layers are tested: the
 * sandboxes make the pointers and the configuration read-only, the runner's git refuses a redirected worktree, and every git the
 * runner starts overrides fsmonitor and hooks on the command line.
 */
const root = realpathSync(mkdtempSync(join(userInfo().homedir, '.aom-git-harden-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.test',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.test',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const sh = (cwd: string, args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A repository with one commit and a linked worktree `wt`. */
function fixture(name: string) {
  const dir = join(root, name);
  const repo = join(dir, 'repo');
  const wt = join(dir, 'wt');
  mkdirSync(repo, { recursive: true });
  sh(repo, ['init', '-b', 'main']);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  sh(repo, ['add', '-A']);
  sh(repo, ['commit', '-m', 'one']);
  sh(repo, ['worktree', 'add', '-b', 'feat', wt]);
  const admin = join(repo, '.git', 'worktrees', 'wt');
  return { dir, repo, wt, admin, common: join(repo, '.git') };
}

describe('the runner refuses a worktree that points somewhere it should not', () => {
  it('accepts a worktree git made, a plain clone and a folder without .git', () => {
    const f = fixture('sane');
    expect(gitPointerProblem(f.wt)).toBeUndefined();
    expect(gitPointerProblem(f.repo)).toBeUndefined();
    expect(gitPointerProblem(f.dir)).toBeUndefined();
  });

  it('refuses a .git file that points into the working folder, at a folder of the wrong shape, or through a link', () => {
    const f = fixture('pointer');
    // a fake admin folder the agent built inside its worktree
    const fake = join(f.wt, 'evil', '.git', 'worktrees', 'x');
    mkdirSync(fake, { recursive: true });
    writeFileSync(join(fake, 'commondir'), '../..');
    writeFileSync(join(fake, 'gitdir'), join(f.wt, '.git'));
    writeFileSync(join(f.wt, '.git'), `gitdir: ${fake}\n`);
    expect(gitPointerProblem(f.wt)).toMatch(/inside the working folder/);
    writeFileSync(join(f.wt, '.git'), `gitdir: ${f.repo}\n`);
    expect(gitPointerProblem(f.wt)).toMatch(/not a worktree/);
    writeFileSync(join(f.wt, '.git'), 'nonsense\n');
    expect(gitPointerProblem(f.wt)).toMatch(/does not name/);
    rmSync(join(f.wt, '.git'));
    symlinkSync(f.admin, join(f.wt, '.git'));
    expect(gitPointerProblem(f.wt)).toMatch(/symbolic link/);
  });

  it('refuses a redirected commondir or a gitdir that does not lead back', () => {
    const f = fixture('commondir');
    const evilCommon = join(f.wt, 'cfg');
    mkdirSync(evilCommon);
    writeFileSync(join(f.admin, 'commondir'), evilCommon);
    expect(gitPointerProblem(f.wt)).toMatch(/commondir/);
    writeFileSync(join(f.admin, 'commondir'), '../..\n');
    expect(gitPointerProblem(f.wt)).toBeUndefined();
    writeFileSync(join(f.admin, 'gitdir'), join(f.dir, 'elsewhere', '.git'));
    expect(gitPointerProblem(f.wt)).toMatch(/lead back/);
  });

  it('git() returns a failure instead of running in a redirected worktree', async () => {
    const f = fixture('refuse');
    const marker = join(f.dir, 'PWNED');
    const evil = join(f.wt, 'evil');
    mkdirSync(join(evil, 'worktrees', 'x'), { recursive: true });
    writeFileSync(
      join(evil, 'config'),
      `[core]\n\trepositoryformatversion = 0\n\tfsmonitor = touch ${marker}\n`,
    );
    writeFileSync(join(f.wt, '.git'), `gitdir: ${join(evil, 'worktrees', 'x')}\n`);
    const r = await git(f.wt, ['status']);
    expect(r.exitCode).toBe(128);
    expect(r.stderr).toMatch(/refusing to run git/);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('every git the runner starts overrides fsmonitor and hooks', () => {
  it('a core.fsmonitor in the repository config does not run (and does run for a plain git: the control)', async () => {
    const f = fixture('fsmonitor');
    const marker = join(f.dir, 'FSMONITOR-RAN');
    const script = join(f.dir, 'fsm.sh');
    writeFileSync(script, `#!/bin/sh\ntouch ${marker}\nprintf '\\0'\n`, { mode: 0o755 });
    sh(f.repo, ['config', 'core.fsmonitor', script]);
    // control: git without the flags runs it on `status` (this is the exploit)
    await execa('git', ['status'], { cwd: f.wt, env, extendEnv: false, reject: false });
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    const r = await git(f.wt, ['status', '--porcelain']);
    expect(r.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it('a hook in the repository does not run (core.hooksPath is /dev/null)', async () => {
    const f = fixture('hook');
    const marker = join(f.dir, 'HOOK-RAN');
    mkdirSync(join(f.common, 'hooks'), { recursive: true });
    writeFileSync(join(f.common, 'hooks', 'post-checkout'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    // control
    await execa('git', ['checkout', '-b', 'control'], { cwd: f.wt, env, extendEnv: false, reject: false });
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    const r = await git(f.wt, ['checkout', '-b', 'hardened']);
    expect(r.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it('puts the flags before the subcommand', () => {
    expect(GIT_HARDEN_ARGS).toEqual(
      expect.arrayContaining(['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null']),
    );
  });
});

describe('the sandboxes keep the pointers and the configuration read-only', () => {
  it('lists the .git file and the admin entries of a worktree, and config and hooks of a plain clone', () => {
    const f = fixture('paths');
    expect(protectedGitPaths(f.wt).sort()).toEqual(
      [
        join(f.wt, '.git'),
        join(f.admin, 'commondir'),
        join(f.admin, 'gitdir'),
        // `config` and `hooks` of the admin folder only when they exist
      ].sort(),
    );
    expect(protectedGitPaths(f.repo).sort()).toEqual(
      [join(f.common, 'config'), join(f.common, 'hooks')].filter((p) => existsSync(p)).sort(),
    );
    expect(protectedGitPaths(f.dir)).toEqual([]);
  });

  it("Claude Code's sandbox settings deny writes to them, and the Edit tool too", () => {
    const f = fixture('claude');
    const role = BUILTIN_ROLES.find((r) => r.key === 'builder');
    if (!role) throw new Error('builder');
    const settings = buildShiftSettings(
      role.permissions,
      policyCtx({ cwd: f.wt, gitDirs: [f.common] }),
      POLICY_PATHS,
      'builder',
    );
    const denyWrite = settings.sandbox?.filesystem.denyWrite ?? [];
    for (const p of [join(f.wt, '.git'), join(f.admin, 'commondir'), join(f.admin, 'gitdir')])
      expect(denyWrite, p).toContain(p);
    const deny = settings.permissions.deny;
    expect(deny).toContain(`Edit(${ruleAbs(join(f.wt, '.git'))})`);
    expect(deny).toContain(`Edit(${ruleAbs(join(f.admin, 'commondir'))})`);
  });
});

const have = (bin: string) => spawnSync(bin, ['--version'], { encoding: 'utf8' }).status === 0;
const bwrapOk =
  process.platform === 'linux' &&
  have('bwrap') &&
  spawnSync('socat', ['-V']).status === 0 &&
  spawnSync('bwrap', [
    '--unshare-user',
    '--ro-bind',
    '/usr',
    '/usr',
    '--symlink',
    'usr/bin',
    '/bin',
    '--symlink',
    'usr/lib',
    '/lib',
    '--symlink',
    'usr/lib64',
    '/lib64',
    '--',
    '/usr/bin/true',
  ]).status === 0;

describe.skipIf(!bwrapOk)('in the real harness box (bubblewrap)', () => {
  const boxed = async (f: ReturnType<typeof fixture>, script: string) => {
    const agent = join(f.dir, 'agent');
    const dirs = { home: join(agent, 'home'), scratch: join(agent, 'scratch'), tmp: join(agent, 'tmp') };
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
    const sockDir = join(f.dir, 'run');
    mkdirSync(sockDir, { recursive: true });
    const input: HarnessSandboxInput = {
      cwd: f.wt,
      readOnlyCwd: false,
      ...dirs,
      writable: [],
      readonly: [],
      readDirs: [],
      gitDirs: [f.common],
      mayCommit: true,
      proxySocket: join(sockDir, 'p.sock'),
      bridgePort: 3128,
      hiddenFromShell: [],
    };
    const w = wrapInHarnessSandbox(input, {
      bin: '/bin/sh',
      args: ['-c', script],
      env: {
        PATH: '/usr/bin:/bin',
        HOME: dirs.home,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.test',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.test',
        ...proxyEnv(3128),
      },
    });
    const r = await execa(w.bin, w.args, {
      cwd: f.wt,
      env: w.env,
      extendEnv: false,
      reject: false,
      timeout: 30_000,
      all: true,
    });
    return String(r.all ?? '');
  };

  it('cannot rewrite or remove the .git file, commondir or gitdir, and cannot plant a config in the admin folder; git still commits', async () => {
    const f = fixture('box');
    const marker = join(f.dir, 'PWNED');
    const out = await boxed(
      f,
      [
        `echo 'gitdir: /tmp/x' > .git 2>&1 || echo GITFILE-RO`,
        `rm -f .git 2>&1 || echo GITFILE-NO-RM`,
        `mv .git .git.bak 2>&1 || echo GITFILE-NO-MV`,
        `echo /tmp > ${f.admin}/commondir 2>&1 || echo COMMONDIR-RO`,
        `echo /tmp > ${f.admin}/gitdir 2>&1 || echo GITDIR-RO`,
        `printf '[core]\\n\\tfsmonitor = touch ${marker}\\n' >> ${f.common}/config 2>&1 || echo CONFIG-RO`,
        `mkdir -p ${f.common}/hooks 2>/dev/null; echo '#!/bin/sh' > ${f.common}/hooks/post-checkout 2>&1 || echo HOOKS-RO`,
        `echo hello > file.txt && git add file.txt && git commit -q -m boxed && echo COMMIT-OK`,
        `git -c core.hooksPath=/dev/null log --oneline | head -3`,
      ].join('; '),
    );
    for (const s of [
      'GITFILE-RO',
      'GITFILE-NO-RM',
      'GITFILE-NO-MV',
      'COMMONDIR-RO',
      'GITDIR-RO',
      'CONFIG-RO',
      'COMMIT-OK',
    ])
      expect(out, out).toContain(s);
    // the host side is untouched
    expect(readFileSync(join(f.wt, '.git'), 'utf8')).toContain(`gitdir: ${f.admin}`);
    expect(readFileSync(join(f.admin, 'commondir'), 'utf8').trim()).toBe('../..');
    expect(readFileSync(join(f.common, 'config'), 'utf8')).not.toContain('fsmonitor');
    expect(existsSync(marker)).toBe(false);
    expect(gitPointerProblem(f.wt)).toBeUndefined();
    // and the commit made in the box is there
    expect(sh(f.wt, ['log', '--oneline', '-1'])).toContain('boxed');
  });
});
