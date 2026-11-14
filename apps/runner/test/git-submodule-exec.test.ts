import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git } from '../src/git/git.ts';
import {
  forgetTrustedSubmodules,
  inertGitConfig,
  protectedGitPaths,
  submoduleGitDirs,
  trustedSubmoduleGitDir,
  trustSubmodulesAtShiftStart,
} from '../src/git/harden.ts';
import { managedGitDir, modulesRoot } from '../src/git/submodule-drift.ts';

/**
 * A nested repository inside a card worktree is agent-made content, and its `config` can name programs (a `clean`
 * filter, a diff driver). The runner's git, on the workstation, must never run them: not through a superproject
 * command that looks into submodules, and not by running git inside a submodule whose configuration the agent could
 * write. Real git, real repositories; the "program" leaves a marker file.
 */

let dir: string;
let superRepo: string;
let marker: string;
let tick = 0;

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'a',
      GIT_AUTHOR_EMAIL: 'a@b',
      GIT_COMMITTER_NAME: 'a',
      GIT_COMMITTER_EMAIL: 'a@b',
    },
  }).toString();

/** Rewrites the nested file with the same size and a new time, so git has to read the content (and run the filter). */
function dirty(repo: string): void {
  tick += 1;
  writeFileSync(join(repo, 'data.bin'), `${String(tick % 10).repeat(4)}\n`);
  const t = new Date(Date.now() + tick * 5000);
  utimesSync(join(repo, 'data.bin'), t, t);
}

function plant(repo: string): void {
  sh(repo, 'config', 'filter.pwn.clean', `sh -c 'touch ${marker}; cat'`);
  sh(repo, 'config', 'diff.pwn.command', `sh -c 'touch ${marker}'`);
}

const ran = (): boolean => {
  const yes = existsSync(marker);
  rmSync(marker, { force: true });
  return yes;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aom-subexec-'));
  marker = join(dir, 'MARK');
  superRepo = join(dir, 'super');
  mkdirSync(superRepo);
  sh(superRepo, 'init', '-q', '-b', 'main');
  writeFileSync(join(superRepo, 'f.txt'), 'hi\n');
  sh(superRepo, 'add', 'f.txt');
  sh(superRepo, 'commit', '-qm', 'init');
  forgetTrustedSubmodules();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** `git init evil && git add evil` inside the worktree: a gitlink with an agent-owned repository behind it. */
function nestedRepo(): string {
  const evil = join(superRepo, 'evil');
  mkdirSync(evil);
  sh(evil, 'init', '-q', '-b', 'main');
  writeFileSync(join(evil, 'data.bin'), 'xxxx\n');
  writeFileSync(join(evil, '.gitattributes'), '*.bin filter=pwn diff=pwn\n');
  sh(evil, 'add', '.');
  sh(evil, 'commit', '-qm', 'e');
  plant(evil);
  sh(superRepo, 'add', 'evil');
  sh(superRepo, 'commit', '-qm', 'gitlink');
  return evil;
}

describe("the runner's git never runs a nested repository's programs", () => {
  it('control: plain git in the superproject does run the nested filter (the hole this closes)', () => {
    const evil = nestedRepo();
    dirty(evil);
    sh(superRepo, 'status', '--porcelain');
    expect(ran()).toBe(true);
  });

  it('status, diff, add -A, commit, stash, checkout, merge, rebase, reset and clean start nothing', async () => {
    const evil = nestedRepo();
    const commands: string[][] = [
      ['status', '--porcelain'],
      ['status', '--porcelain=v2', '-z', '--untracked-files=all'],
      ['status'],
      ['diff', 'HEAD'],
      ['diff', '--name-status', 'HEAD'],
      ['diff', '--cached', '-M', '--name-status', '-z', 'HEAD'],
      ['add', '-A'],
      ['add', '-A', '--', '.'],
      ['add', '-u'],
      ['commit', '--no-verify', '--allow-empty', '-m', 'wip'],
      ['stash'],
      ['checkout', '-q', '-B', 'other'],
      ['merge', '-q', 'main'],
      ['rebase', '-q', 'main'],
      ['checkout', 'HEAD', '--', 'f.txt'],
      ['reset', '--hard', '-q'],
      ['clean', '-fd'],
      ['clean', '-fdq', '--', 'evil'],
      ['ls-files', '--others', '--cached', '--exclude-standard'],
      ['write-tree'],
    ];
    const env = {
      GIT_AUTHOR_NAME: 'a',
      GIT_AUTHOR_EMAIL: 'a@b',
      GIT_COMMITTER_NAME: 'a',
      GIT_COMMITTER_EMAIL: 'a@b',
    };
    for (const c of commands) {
      dirty(evil);
      writeFileSync(join(superRepo, 'f.txt'), `change ${tick}\n`);
      await git(superRepo, c, { env });
      expect(ran(), `git ${c.join(' ')}`).toBe(false);
    }
  });

  it('a moved pin still shows in status, and add -A leaves the untrusted gitlink alone', async () => {
    const evil = nestedRepo();
    dirty(evil);
    sh(evil, '-c', 'filter.pwn.clean=cat', 'commit', '-qam', 'more');
    rmSync(marker, { force: true });
    expect((await git(superRepo, ['status', '--porcelain'])).stdout).toContain('M evil');
    await git(superRepo, ['add', '-A']);
    // the pin was not staged: the gitlink was excluded, so git never looked inside
    expect((await git(superRepo, ['diff', '--cached', '--name-only'])).stdout.trim()).toBe('');
    expect(ran()).toBe(false);
  });

  it('a new untracked nested repository is added as a gitlink without running its programs', async () => {
    const fresh = join(superRepo, 'fresh');
    mkdirSync(fresh);
    sh(fresh, 'init', '-q', '-b', 'main');
    writeFileSync(join(fresh, 'data.bin'), 'xxxx\n');
    writeFileSync(join(fresh, '.gitattributes'), '*.bin filter=pwn diff=pwn\n');
    sh(fresh, 'add', '.');
    sh(fresh, 'commit', '-qm', 'e');
    plant(fresh);
    dirty(fresh);
    await git(superRepo, ['add', '-A']);
    await git(superRepo, ['status', '--porcelain']);
    expect(ran()).toBe(false);
  });
});

describe('submodule repositories the runner trusts', () => {
  /** A real submodule: its repository lives under `<git dir>/modules/core`. */
  function realSubmodule(): { path: string; gitDir: string } {
    const origin = join(dir, 'origin');
    mkdirSync(origin);
    sh(origin, 'init', '-q', '-b', 'main');
    writeFileSync(join(origin, 'data.bin'), 'xxxx\n');
    writeFileSync(join(origin, '.gitattributes'), '*.bin filter=pwn diff=pwn\n');
    sh(origin, 'add', '.');
    sh(origin, 'commit', '-qm', 'o');
    sh(superRepo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', origin, 'core');
    sh(superRepo, 'commit', '-qm', 'submodule');
    return { path: join(superRepo, 'core'), gitDir: join(superRepo, '.git', 'modules', 'core') };
  }

  it('finds them, protects their config and hooks, and trusts an inert one', async () => {
    const sub = realSubmodule();
    expect(submoduleGitDirs(superRepo)).toEqual([sub.gitDir]);
    expect(protectedGitPaths(superRepo)).toEqual(expect.arrayContaining([join(sub.gitDir, 'config')]));
    expect(trustedSubmoduleGitDir(sub.gitDir)).toBe(false); // nothing is trusted before a shift start
    const modules = (await modulesRoot(superRepo)) as string;
    expect(managedGitDir(sub.path, modules)).toBeNull();
    expect(trustSubmodulesAtShiftStart(superRepo)).toEqual([sub.gitDir]);
    expect(managedGitDir(sub.path, modules)).not.toBeNull();
  });

  it('never trusts one whose configuration names a program, at the shift start or planted later', async () => {
    const sub = realSubmodule();
    plant(sub.path); // an earlier shift left a filter in modules/core/config
    expect(trustSubmodulesAtShiftStart(superRepo)).toEqual([]);
    const modules = (await modulesRoot(superRepo)) as string;
    expect(managedGitDir(sub.path, modules)).toBeNull();
    // add -A stays out of it too
    dirty(sub.path);
    await git(superRepo, ['add', '-A']);
    expect(ran()).toBe(false);
  });

  it('a repository made under modules/ after the shift start is not trusted', async () => {
    const sub = realSubmodule();
    trustSubmodulesAtShiftStart(superRepo);
    const forged = join(superRepo, '.git', 'modules', 'forged');
    execFileSync('cp', ['-r', sub.gitDir, forged]);
    expect(submoduleGitDirs(superRepo).sort()).toEqual([sub.gitDir, forged].sort());
    expect(trustedSubmoduleGitDir(forged)).toBe(false);
    expect(trustedSubmoduleGitDir(sub.gitDir)).toBe(true);
  });

  it('git add still stages a pin change of a trusted submodule', async () => {
    const sub = realSubmodule();
    trustSubmodulesAtShiftStart(superRepo);
    writeFileSync(join(sub.path, 'new.txt'), 'n\n');
    sh(sub.path, 'add', 'new.txt');
    sh(sub.path, 'commit', '-qm', 'pin moves');
    await git(superRepo, ['add', '-A']);
    expect((await git(superRepo, ['diff', '--cached', '--name-only'])).stdout.trim()).toBe('core');
  });
});

describe('inertGitConfig', () => {
  const write = (text: string): string => {
    const f = join(dir, `cfg-${++tick}`);
    writeFileSync(f, text);
    return f;
  };
  it('accepts what git writes for a submodule clone', () => {
    expect(
      inertGitConfig(
        write(
          '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n\tworktree = ../../../core\n[remote "origin"]\n\turl = /x/y\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n[submodule "inner"]\n\tactive = true\n\turl = /x/z\n',
        ),
      ),
    ).toBe(true);
  });
  it.each([
    ['a filter', '[filter "pwn"]\n\tclean = sh -c x\n'],
    ['a diff driver', '[diff "pwn"]\n\tcommand = x\n'],
    ['a merge driver', '[merge "pwn"]\n\tdriver = x\n'],
    ['an include', '[include]\n\tpath = /tmp/evil\n'],
    ['a conditional include', '[includeIf "gitdir:/"]\n\tpath = /tmp/evil\n'],
    ['an alias', '[alias]\n\tstatus = !x\n'],
    ['core.fsmonitor', '[core]\n\tfsmonitor = x\n'],
    ['core.sshCommand', '[core]\n\tsshCommand = x\n'],
    ['core.hooksPath', '[core]\n\thooksPath = /tmp\n'],
    ['a credential helper', '[credential]\n\thelper = x\n'],
    ['submodule update command', '[submodule "a"]\n\tupdate = !x\n'],
    ['remote uploadpack', '[remote "origin"]\n\tuploadpack = x\n'],
    ['a dotted section', '[filter.pwn]\n\tclean = x\n'],
    ['a key on the header line', '[core] fsmonitor = x\n'],
    ['a continued line', '[core]\n\tbare = false \\\n[filter "p"]\n'],
  ])('rejects %s', (_name, text) => {
    expect(inertGitConfig(write(`[core]\n\tbare = false\n${text}`))).toBe(false);
  });
  it('rejects a missing file', () => {
    expect(inertGitConfig(join(dir, 'nope'))).toBe(false);
  });
});
