import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git } from '../src/git/git.ts';
import { protectedGitPaths, submoduleGitDirs } from '../src/git/harden.ts';

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

  it('a moved pin still shows in status, and add -A leaves the gitlink alone', async () => {
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

describe('an agent-written .gitmodules cannot switch the looking-inside back on (submodule.<name>.ignore = none)', () => {
  it('status, diff, checkout and add start nothing', async () => {
    const evil = nestedRepo();
    writeFileSync(
      join(superRepo, '.gitmodules'),
      '[submodule "evil"]\n\tpath = evil\n\turl = ./evil\n\tignore = none\n',
    );
    sh(superRepo, 'add', '.gitmodules');
    sh(superRepo, 'commit', '-qm', 'hostile .gitmodules');
    // control: the config default alone is overridden by .gitmodules
    dirty(evil);
    sh(superRepo, '-c', 'diff.ignoreSubmodules=dirty', 'status', '--porcelain');
    expect(ran()).toBe(true);
    const commands: string[][] = [
      ['status', '--porcelain'],
      ['status', '--porcelain=v2', '-z', '--untracked-files=all'],
      ['-c', 'protocol.allow=never', 'status'],
      ['diff', 'HEAD'],
      ['diff', '--name-status', 'HEAD'],
      ['add', '-A'],
      ['add', '-u'],
      ['add', '--all', '--', '.'],
      ['commit', '--no-verify', '--allow-empty', '-m', 'wip'],
      ['checkout', '-B', 'other'],
      ['checkout', '-f', 'main'],
      ['checkout', 'HEAD', '--', 'f.txt'],
      ['merge', 'other'],
      ['rebase', 'other'],
      ['reset', '--hard'],
      ['clean', '-fd'],
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
});

describe('fetch does not go into a nested repository (its remote settings name programs too)', () => {
  it('a fetch that brings a moved pin starts nothing, even when .gitmodules asks for recursion', async () => {
    const evil = nestedRepo();
    // the nested repository has a remote whose "upload-pack" is a program of the agent's choosing
    sh(evil, 'remote', 'add', 'origin', join(dir, 'nowhere'));
    sh(evil, 'config', 'remote.origin.uploadpack', `sh -c 'touch ${marker}'`);
    writeFileSync(
      join(superRepo, '.gitmodules'),
      '[submodule "evil"]\n\tpath = evil\n\turl = ./evil\n\tfetchRecurseSubmodules = true\n\tignore = none\n',
    );
    sh(superRepo, 'add', '.gitmodules');
    sh(superRepo, 'commit', '-qm', 'hostile .gitmodules');
    // an origin for the superproject that is one commit ahead, with the gitlink moved
    const origin = join(dir, 'origin.git');
    sh(dir, 'clone', '-q', '--bare', superRepo, origin);
    sh(superRepo, 'remote', 'add', 'origin', origin);
    const other = join(dir, 'other');
    sh(dir, 'clone', '-q', origin, other);
    sh(other, 'update-index', '--cacheinfo', `160000,${'a'.repeat(40)},evil`);
    sh(other, 'commit', '-qm', 'move the pin');
    sh(other, 'push', '-q', 'origin', 'HEAD:main');
    // control: plain git recurses and runs the program
    try {
      sh(superRepo, 'fetch', '-q', 'origin');
    } catch {
      // the nested fetch fails after it ran the "upload-pack" program: that it ran is the point
    }
    expect(ran()).toBe(true);
    // again one commit ahead, now through the runner's git
    sh(other, 'update-index', '--cacheinfo', `160000,${'b'.repeat(40)},evil`);
    sh(other, 'commit', '-qm', 'move the pin again');
    sh(other, 'push', '-q', 'origin', 'HEAD:main');
    const r = await git(superRepo, ['fetch', 'origin']);
    expect(r.exitCode).toBe(0);
    expect(ran()).toBe(false);
    sh(other, 'update-index', '--cacheinfo', `160000,${'c'.repeat(40)},evil`);
    sh(other, 'commit', '-qm', 'and again');
    sh(other, 'push', '-q', 'origin', 'HEAD:main');
    await git(superRepo, ['pull', '--ff-only', 'origin', 'main']);
    expect(ran()).toBe(false);
  });
});

describe('git add never stages a gitlink, and the submodule repositories are protected', () => {
  /** A real submodule: its repository lives under `<git dir>/modules/core`. */
  function realSubmodule(): { path: string; gitDir: string } {
    const origin = join(dir, 'origin');
    mkdirSync(origin);
    sh(origin, 'init', '-q', '-b', 'main');
    writeFileSync(join(origin, 'data.bin'), 'xxxx\n');
    sh(origin, 'add', '.');
    sh(origin, 'commit', '-qm', 'o');
    sh(superRepo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', origin, 'core');
    sh(superRepo, 'commit', '-qm', 'submodule');
    return { path: join(superRepo, 'core'), gitDir: join(superRepo, '.git', 'modules', 'core') };
  }

  it('lists the submodule repositories and protects their config and hooks', () => {
    const sub = realSubmodule();
    expect(submoduleGitDirs(superRepo)).toEqual([sub.gitDir]);
    expect(protectedGitPaths(superRepo)).toEqual(expect.arrayContaining([join(sub.gitDir, 'config')]));
  });

  it("the runner's add leaves a moved pin unstaged (the agent commits a pin change itself), other files are staged", async () => {
    const sub = realSubmodule();
    writeFileSync(join(sub.path, 'new.txt'), 'n\n');
    sh(sub.path, 'add', 'new.txt');
    sh(sub.path, 'commit', '-qm', 'pin moves');
    writeFileSync(join(superRepo, 'f.txt'), 'changed\n');
    await git(superRepo, ['add', '-A']);
    expect((await git(superRepo, ['diff', '--cached', '--name-only'])).stdout.trim()).toBe('f.txt');
    expect((await git(superRepo, ['status', '--porcelain'])).stdout).toContain(' M core');
    // the agent's own commit of the pin (plain git, as in its sandbox) is kept by later runner commands
    sh(superRepo, 'add', 'core');
    sh(superRepo, 'commit', '-qm', 'bump core');
    await git(superRepo, ['add', '-A']);
    expect(sh(superRepo, 'rev-parse', 'HEAD:core').trim()).toBe(sh(sub.path, 'rev-parse', 'HEAD').trim());
  });

  it('the add is refused, not run unguarded, when the index cannot be read', async () => {
    realSubmodule();
    writeFileSync(join(superRepo, '.git', 'index'), 'not an index');
    const r = await git(superRepo, ['add', '-A']);
    expect(r.exitCode).toBe(128);
    expect(r.stderr).toContain('refusing to run git');
  });
});
