import { rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FinalizeExecutePayload } from '@aom/shared';
import { FinalizeResultSchema } from '@aom/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeCompletion } from '../src/git/completion.ts';
import type { PrCreator } from '../src/git/gh.ts';
import { lockRetry } from '../src/git/git.ts';
import { ensureWorktree } from '../src/git/worktrees.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();

const BRANCH = 'aom/toy-1-add-thing';

const savedDelays = lockRetry.delaysMs;
beforeEach(() => {
  lockRetry.delaysMs = [];
});
afterEach(() => {
  lockRetry.delaysMs = savedDelays;
});

async function cardWorktree() {
  const repo = makeRepo();
  const path = join(tmp(), 'wt');
  await ensureWorktree({
    repoPath: repo.clone,
    roots: ['/'],
    spec: {
      mode: 'create',
      repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
      remoteUrlNormalized: repo.remoteNormalized,
      baseBranch: 'main',
      branchName: BRANCH,
    },
    defaultPath: path,
  });
  writeFileSync(join(path, 'thing.txt'), 'thing\n');
  sh(path, 'git', ['add', '-A']);
  sh(path, 'git', ['commit', '-m', 'add thing']);
  return { repo, path };
}

function advanceOrigin(root: string, origin: string, file: string) {
  const other = join(tmp(), 'other');
  sh(root, 'git', ['clone', origin, other]);
  writeFileSync(join(other, file), file);
  sh(other, 'git', ['add', '-A']);
  sh(other, 'git', ['commit', '-m', `change ${file}`]);
  sh(other, 'git', ['push', 'origin', 'main']);
}

const payload = (
  repo: { remoteNormalized: string },
  path: string,
  action: FinalizeExecutePayload['action'],
): FinalizeExecutePayload => ({
  cardId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c1',
  ref: 'TOY-1',
  title: 'Add thing',
  projectKey: 'TOY',
  action,
  repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
  remoteUrlNormalized: repo.remoteNormalized,
  baseBranch: 'main',
  branchName: BRANCH,
  worktreePath: path,
});

const noPr: PrCreator = {
  async create() {
    throw new Error('no PR expected');
  },
};

const run = (repo: { clone: string }, p: FinalizeExecutePayload) =>
  executeCompletion({
    payload: p,
    repoPath: repo.clone,
    worktreePath: p.worktreePath as string,
    worktreesDir: '/',
    integrationDir: join(tmp(), 'integration'),
    pr: noPr,
  });

describe('completion: the rebase before landing (completion path)', () => {
  it('a branch that already contains its base is not rebased: the card head is unchanged and it merges', async () => {
    const { repo, path } = await cardWorktree();
    // The sandbox's dotfiles are empty, untracked stubs (what the finalize dirty check already leaves out).
    writeFileSync(join(path, '.bashrc'), '');
    writeFileSync(join(path, '.gitconfig'), '');
    const before = sh(path, 'git', ['rev-parse', 'HEAD']);
    const res = await run(repo, payload(repo, path, 'merge'));
    expect(res.error).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(res.conflict).toBeUndefined();
    expect(sh(path, 'git', ['rev-parse', 'HEAD'])).toBe(before);
    expect(sh(path, 'git', ['reflog', '--format=%gs'])).not.toMatch(/rebase/);
    expect(sh(path, 'git', ['status', '--porcelain'])).toBe('?? .bashrc\n?? .gitconfig');
    expect(sh(repo.origin, 'git', ['merge-base', '--is-ancestor', before, 'main'])).toBe('');
  });

  it('a held index.lock while behind: ok false with rebaseError, never conflict, nothing pushed', async () => {
    const { repo, path } = await cardWorktree();
    advanceOrigin(repo.root, repo.origin, 'theirs.txt');
    const originBefore = sh(repo.origin, 'git', ['rev-parse', 'main']);
    const before = sh(path, 'git', ['rev-parse', 'HEAD']);
    const lock = resolve(path, sh(path, 'git', ['rev-parse', '--git-path', 'index.lock']));
    writeFileSync(lock, '');
    const res = await run(repo, payload(repo, path, 'merge'));
    rmSync(lock, { force: true });
    expect(res.ok).toBe(false);
    expect(res.conflict).toBeUndefined();
    expect(res.conflictedFiles).toBeUndefined();
    expect(res.rebaseError).toMatchObject({ baseRef: 'origin/main', command: 'git rebase origin/main' });
    expect(res.rebaseError?.exitCode).not.toBe(0);
    expect(res.rebaseError?.stderr).toMatch(/index\.lock/);
    expect(res.error).toMatch(/^rebase onto origin\/main failed/);
    // the wire schema accepts it as it is
    expect(FinalizeResultSchema.parse(res).rebaseError?.baseRef).toBe('origin/main');
    expect(sh(repo.origin, 'git', ['rev-parse', 'main'])).toBe(originBefore);
    expect(sh(path, 'git', ['rev-parse', 'HEAD'])).toBe(before);
    expect(sh(path, 'git', ['rev-parse', '--git-path', 'rebase-merge'])).toBeTruthy();
  });
});
