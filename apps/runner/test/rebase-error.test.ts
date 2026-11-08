import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lockRetry } from '../src/git/git.ts';
import {
  abortInProgress,
  gitMessage,
  RebaseConflictError,
  RebaseError,
  rebaseOntoBase,
} from '../src/git/rebase.ts';
import { ensureWorktree } from '../src/git/worktrees.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();

const spec = {
  mode: 'create' as const,
  repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
  remoteUrlNormalized: 'x',
  baseBranch: 'main',
  branchName: 'aom/toy-1-x',
};

const savedDelays = lockRetry.delaysMs;
beforeEach(() => {
  lockRetry.delaysMs = [];
});
afterEach(() => {
  lockRetry.delaysMs = savedDelays;
});

function advanceOrigin(root: string, origin: string, file: string, content: string) {
  const other = join(tmp(), 'other');
  sh(root, 'git', ['clone', origin, other]);
  writeFileSync(join(other, file), content);
  sh(other, 'git', ['add', '-A']);
  sh(other, 'git', ['commit', '-m', `change ${file}`]);
  sh(other, 'git', ['push', 'origin', 'main']);
}

async function cardWorktree(file = 'mine.txt', content = 'mine') {
  const repo = makeRepo();
  const path = join(tmp(), 'wt');
  await ensureWorktree({ repoPath: repo.clone, roots: ['/'], spec, defaultPath: path });
  writeFileSync(join(path, file), content);
  sh(path, 'git', ['add', '-A']);
  sh(path, 'git', ['commit', '-m', 'mine']);
  return { repo, path };
}

const gitPath = (wt: string, name: string) => resolve(wt, sh(wt, 'git', ['rev-parse', '--git-path', name]));
const head = (wt: string) => sh(wt, 'git', ['rev-parse', 'HEAD']);
const noRebaseInProgress = (wt: string) => {
  expect(existsSync(gitPath(wt, 'rebase-merge'))).toBe(false);
  expect(existsSync(gitPath(wt, 'rebase-apply'))).toBe(false);
  expect(existsSync(gitPath(wt, 'MERGE_HEAD'))).toBe(false);
};

const SANDBOX_FILES: Record<string, string> = {
  '.bashrc': 'export A=1\n',
  '.claude/settings.json': '{"x":1}\n',
  '.mcp.json': '{}\n',
  '.gitconfig': '[user]\n',
};

describe('rebaseOntoBase: a branch that already contains its base', () => {
  it('is a no-op: up_to_date, git rebase never runs, head unchanged, no rebase state', async () => {
    const { path } = await cardWorktree();
    const before = head(path);
    expect(await rebaseOntoBase(path, 'main')).toBe('up_to_date');
    expect(head(path)).toBe(before);
    expect(sh(path, 'git', ['reflog', '--format=%gs'])).not.toMatch(/rebase/);
    noRebaseInProgress(path);
  });

  it('untracked, never-tracked sandbox files do not make it fail and stay untouched and untracked', async () => {
    const { path } = await cardWorktree();
    mkdirSync(join(path, '.claude'), { recursive: true });
    for (const [f, c] of Object.entries(SANDBOX_FILES)) writeFileSync(join(path, f), c);
    const before = head(path);
    expect(await rebaseOntoBase(path, 'main')).toBe('up_to_date');
    expect(head(path)).toBe(before);
    for (const [f, c] of Object.entries(SANDBOX_FILES)) expect(readFileSync(join(path, f), 'utf8')).toBe(c);
    const status = sh(path, 'git', ['status', '--porcelain', '--untracked-files=all']).split('\n').sort();
    expect(status).toEqual(
      Object.keys(SANDBOX_FILES)
        .map((f) => `?? ${f}`)
        .sort(),
    );
  });

  it('untracked sandbox files also survive a real rebase (branch behind the base)', async () => {
    const { repo, path } = await cardWorktree();
    mkdirSync(join(path, '.claude'), { recursive: true });
    for (const [f, c] of Object.entries(SANDBOX_FILES)) writeFileSync(join(path, f), c);
    advanceOrigin(repo.root, repo.origin, 'theirs.txt', 'theirs');
    expect(await rebaseOntoBase(path, 'main')).toBe('rebased');
    for (const [f, c] of Object.entries(SANDBOX_FILES)) expect(readFileSync(join(path, f), 'utf8')).toBe(c);
    expect(sh(path, 'git', ['status', '--porcelain'])).toContain('?? .bashrc');
  });
});

describe('rebaseOntoBase: behind the base without overlap', () => {
  it('rebases as before: the base becomes an ancestor of the new head', async () => {
    const { repo, path } = await cardWorktree();
    const before = head(path);
    advanceOrigin(repo.root, repo.origin, 'theirs.txt', 'theirs');
    expect(await rebaseOntoBase(path, 'main')).toBe('rebased');
    expect(head(path)).not.toBe(before);
    expect(sh(path, 'git', ['merge-base', '--is-ancestor', 'origin/main', 'HEAD'])).toBe('');
    expect(existsSync(join(path, 'theirs.txt'))).toBe(true);
    noRebaseInProgress(path);
  });
});

describe('rebaseOntoBase: conflict vs error', () => {
  it('a real conflict lists the files, aborts and leaves the head where it was', async () => {
    const { repo, path } = await cardWorktree('README.md', '# mine\n');
    const before = head(path);
    advanceOrigin(repo.root, repo.origin, 'README.md', '# theirs\n');
    const err = await rebaseOntoBase(path, 'main').catch((e) => e);
    expect(err).toBeInstanceOf(RebaseConflictError);
    expect(err).not.toBeInstanceOf(RebaseError);
    expect((err as RebaseConflictError).conflictedFiles).toEqual(['README.md']);
    expect(head(path)).toBe(before);
    noRebaseInProgress(path);
  });

  it('a conflict without files cannot be built', () => {
    expect(() => new RebaseConflictError([])).toThrow(/at least one/);
    expect(new RebaseConflictError(['a.txt']).conflictedFiles).toEqual(['a.txt']);
  });

  it('a held index.lock is an error with base ref, command, exit code and stderr; nothing left in progress', async () => {
    const { repo, path } = await cardWorktree();
    const before = head(path);
    advanceOrigin(repo.root, repo.origin, 'theirs.txt', 'theirs');
    const lock = gitPath(path, 'index.lock');
    writeFileSync(lock, '');
    const err = await rebaseOntoBase(path, 'main').catch((e) => e);
    rmSync(lock, { force: true });
    expect(err).toBeInstanceOf(RebaseError);
    expect(err).not.toBeInstanceOf(RebaseConflictError);
    const info = (err as RebaseError).info;
    expect(info.baseRef).toBe('origin/main');
    expect(info.command).toBe('git rebase origin/main');
    expect(info.exitCode).not.toBe(0);
    expect(info.stderr).toMatch(/index\.lock/);
    expect((err as Error).message).toMatch(
      /^rebase onto origin\/main failed: git rebase origin\/main exited/,
    );
    expect((err as Error).message).not.toMatch(/conflict/i);
    expect(head(path)).toBe(before);
    noRebaseInProgress(path);
    // With the lock gone the next attempt starts from the original head and rebases.
    expect(await rebaseOntoBase(path, 'main')).toBe('rebased');
  });

  it('an untracked file in the way of the base is an error, never a conflict, and the file is kept', async () => {
    const { repo, path } = await cardWorktree();
    advanceOrigin(repo.root, repo.origin, '.mcp.json', '{"theirs":true}\n');
    writeFileSync(join(path, '.mcp.json'), '{"mine":true}\n');
    const err = await rebaseOntoBase(path, 'main').catch((e) => e);
    expect(err).toBeInstanceOf(RebaseError);
    expect((err as RebaseError).info.stderr).toMatch(/\.mcp\.json/);
    expect(readFileSync(join(path, '.mcp.json'), 'utf8')).toBe('{"mine":true}\n');
    noRebaseInProgress(path);
  });

  it('a base ref that exists nowhere is an error naming rev-parse', async () => {
    const { path } = await cardWorktree();
    const err = await rebaseOntoBase(path, 'no-such-branch').catch((e) => e);
    expect(err).toBeInstanceOf(RebaseError);
    const info = (err as RebaseError).info;
    expect(info.baseRef).toBe('no-such-branch');
    expect(info.command).toBe('git rev-parse --verify no-such-branch');
    expect(info.exitCode).toBe(128);
    expect(info.stderr).toMatch(/not found/);
  });
});

describe('rebase helpers', () => {
  it('gitMessage redacts credentials and cuts long output', () => {
    const msg = gitMessage({
      stderr: 'fatal: unable to access https://user:s3cretpass@example.com/r.git/',
      stdout: '',
    });
    expect(msg).not.toContain('s3cretpass');
    expect(msg).toContain('https://***@example.com');
    expect(gitMessage({ stderr: '', stdout: 'only stdout' })).toBe('only stdout');
    expect(gitMessage({ stderr: 'x'.repeat(5000), stdout: '' }).length).toBeLessThanOrEqual(2000);
  });

  it('abortInProgress does nothing when nothing is in progress', async () => {
    const { path } = await cardWorktree();
    const before = head(path);
    expect(await abortInProgress(path)).toBe('');
    expect(head(path)).toBe(before);
  });

  it('abortInProgress aborts a stopped rebase and returns the branch to its head', async () => {
    const { repo, path } = await cardWorktree('README.md', '# mine\n');
    const before = head(path);
    advanceOrigin(repo.root, repo.origin, 'README.md', '# theirs\n');
    sh(path, 'git', ['fetch', 'origin', 'main']);
    try {
      sh(path, 'git', ['rebase', 'origin/main']);
    } catch {
      // stopped on the conflict
    }
    expect(existsSync(gitPath(path, 'rebase-merge')) || existsSync(gitPath(path, 'rebase-apply'))).toBe(true);
    expect(await abortInProgress(path)).toBe('');
    expect(head(path)).toBe(before);
    noRebaseInProgress(path);
  });
});
