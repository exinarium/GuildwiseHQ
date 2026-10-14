import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FinalizeExecutePayload } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { executeCompletion } from '../src/git/completion.ts';
import type { PrCreator } from '../src/git/gh.ts';
import { ensureWorktree, removeWorktree } from '../src/git/worktrees.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();

/**
 * Manual QA sends a merged card back to rework (docs/design/manual-qa.md, D13). The server keeps the card's worktree
 * path and branch name after the merge, so the first claim of the rework round is a `reuse`: the card branch (deleted
 * with the merge) is cut afresh from the working branch, which already holds the merged work, and the second finalize
 * merges only what the rework added.
 */
const BRANCH = 'aom/toy-1-add-thing';
const REPO_ID = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';

const spec = (repo: { remoteNormalized: string }, mode: 'create' | 'reuse', path?: string) => ({
  mode,
  repoId: REPO_ID,
  remoteUrlNormalized: repo.remoteNormalized,
  baseBranch: 'main',
  branchName: BRANCH,
  ...(path ? { path } : {}),
});

const commit = (path: string, file: string, text: string, message: string) => {
  writeFileSync(join(path, file), text);
  sh(path, 'git', ['add', '-A']);
  sh(path, 'git', ['commit', '-m', message]);
};

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
  repoId: REPO_ID,
  remoteUrlNormalized: repo.remoteNormalized,
  baseBranch: 'main',
  branchName: BRANCH,
  worktreePath: path,
});

const finalize = (repo: { clone: string; remoteNormalized: string }, path: string) => {
  const pr: PrCreator = { create: async () => ({}) };
  return executeCompletion({
    payload: payload(repo, path, 'merge'),
    repoPath: repo.clone,
    worktreePath: path,
    worktreesDir: '/',
    integrationDir: join(tmp(), 'integration'),
    pr,
  });
};
const originLog = (repo: { origin: string }) => sh(repo.origin, 'git', ['log', '--format=%s', 'main']);

describe('rework after a merged finalize (manual QA send back)', () => {
  it('cuts the card branch afresh from the working branch, and the second finalize merges only the new commits', async () => {
    const repo = makeRepo();
    const path = join(tmp(), 'wt');
    await ensureWorktree({
      repoPath: repo.clone,
      roots: ['/'],
      spec: spec(repo, 'create'),
      defaultPath: path,
    });
    commit(path, 'thing.txt', 'v1\n', 'add thing');

    // round 1: finalize merges and the runner removes the worktree and the merged branch (what the server asks for)
    const first = await finalize(repo, path);
    expect(first.ok).toBe(true);
    await removeWorktree({ path, branchName: BRANCH, deleteBranch: true, roots: ['/'] });
    expect(sh(repo.clone, 'git', ['branch', '--list', BRANCH])).toBe('');

    // QA sends it back: the next claim is a reuse of the recorded path and branch
    const again = await ensureWorktree({
      repoPath: repo.clone,
      roots: ['/'],
      spec: spec(repo, 'reuse', path),
      defaultPath: path,
    });
    expect(again).toMatchObject({ branchRecreated: true, created: true, path });
    // the new branch already holds the merged work: the builder sees the file QA tested
    expect(readFileSync(join(path, 'thing.txt'), 'utf8')).toBe('v1\n');
    expect(sh(path, 'git', ['rev-parse', 'HEAD'])).toBe(first.mergeCommit);
    commit(path, 'thing.txt', 'v2 (fixed after QA)\n', 'fix after QA');

    // round 2: the second finalize merges the fix, once, on top of the first merge
    const second = await finalize(repo, path);
    expect(second.ok).toBe(true);
    expect(second.mergeCommit).not.toBe(first.mergeCommit);
    const log = originLog(repo);
    expect(log).toContain('fix after QA');
    expect(log.match(/add thing/g)).toHaveLength(1);
    expect(log.match(/Merge TOY-1/g)).toHaveLength(2);
    expect(sh(repo.origin, 'git', ['show', 'main:thing.txt'])).toBe('v2 (fixed after QA)');
    // the card branch still never reached origin
    expect(sh(repo.origin, 'git', ['for-each-ref', '--format=%(refname)', 'refs/heads'])).toBe(
      'refs/heads/main',
    );
  });

  it('a rework round that changed nothing finalizes to the same merge instead of failing', async () => {
    const repo = makeRepo();
    const path = join(tmp(), 'wt');
    await ensureWorktree({
      repoPath: repo.clone,
      roots: ['/'],
      spec: spec(repo, 'create'),
      defaultPath: path,
    });
    commit(path, 'thing.txt', 'v1\n', 'add thing');
    const first = await finalize(repo, path);
    await removeWorktree({ path, branchName: BRANCH, deleteBranch: true, roots: ['/'] });
    await ensureWorktree({
      repoPath: repo.clone,
      roots: ['/'],
      spec: spec(repo, 'reuse', path),
      defaultPath: path,
    });
    const second = await finalize(repo, path);
    expect(second.ok).toBe(true);
    expect(originLog(repo).match(/Merge TOY-1/g)).toHaveLength(1);
    expect(second.mergeCommit).toBe(first.mergeCommit);
  });
});
