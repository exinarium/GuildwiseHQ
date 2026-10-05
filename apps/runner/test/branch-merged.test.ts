import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkBranchMerged } from '../src/git/merged.ts';
import { cleanupTmp, makeRepo, sh, type TestRepo } from './helpers.ts';

cleanupTmp();

const U = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
const payload = (repo: TestRepo, over: Record<string, unknown> = {}) => ({
  cardId: U,
  ref: 'TOY-1',
  repoId: U,
  remoteUrlNormalized: repo.remoteNormalized,
  branchName: 'aom/toy-1-x',
  workingBranch: 'main',
  action: 'push_branch' as const,
  ...over,
});

/** A card branch with one commit, pushed to origin; the clone's HEAD stays on main. */
function cardBranch(repo: TestRepo, name = 'aom/toy-1-x') {
  sh(repo.clone, 'git', ['checkout', '-b', name]);
  writeFileSync(join(repo.clone, `${name.replace(/\W/g, '_')}.txt`), 'work');
  sh(repo.clone, 'git', ['add', '-A']);
  sh(repo.clone, 'git', ['commit', '-m', 'work']);
  sh(repo.clone, 'git', ['push', '-u', 'origin', name]);
  sh(repo.clone, 'git', ['checkout', 'main']);
}

describe('branch.check_merged', () => {
  it('an unmerged branch is left alone and says why', async () => {
    const repo = makeRepo();
    cardBranch(repo);
    const r = await checkBranchMerged({ repoPath: repo.clone, payload: payload(repo) });
    expect(r).toMatchObject({ merged: false, branchDeleted: false, remoteBranchDeleted: false });
    expect(r.reason).toContain('not merged');
    expect(sh(repo.clone, 'git', ['branch', '--list', 'aom/toy-1-x'])).toContain('aom/toy-1-x');
  });

  it('a branch merged into the working branch on the remote is deleted locally and (push_branch) on the remote', async () => {
    const repo = makeRepo();
    cardBranch(repo);
    // someone merges it into main on the remote (not in the clone's local main)
    sh(repo.clone, 'git', ['checkout', '-b', 'tmp-merge', 'origin/main']);
    sh(repo.clone, 'git', ['merge', '--no-ff', '-m', 'merge', 'aom/toy-1-x']);
    sh(repo.clone, 'git', ['push', 'origin', 'tmp-merge:main']);
    sh(repo.clone, 'git', ['checkout', 'main']);
    sh(repo.clone, 'git', ['branch', '-D', 'tmp-merge']);
    const r = await checkBranchMerged({ repoPath: repo.clone, payload: payload(repo) });
    expect(r).toMatchObject({ merged: true, branchDeleted: true, remoteBranchDeleted: true });
    expect(sh(repo.clone, 'git', ['branch', '--list', 'aom/toy-1-x'])).toBe('');
    expect(sh(repo.clone, 'git', ['ls-remote', '--heads', 'origin', 'aom/toy-1-x'])).toBe('');
    // idempotent: the branch is gone now, which is reported (not an error)
    const again = await checkBranchMerged({ repoPath: repo.clone, payload: payload(repo) });
    expect(again.merged).toBe(false);
    expect(again.reason).toContain('not found');
  });

  it("a merged pr branch is deleted locally only (the remote branch is the host's to clean up)", async () => {
    const repo = makeRepo();
    cardBranch(repo);
    sh(repo.clone, 'git', ['merge', '--no-ff', '-m', 'merge', 'aom/toy-1-x']);
    sh(repo.clone, 'git', ['push', 'origin', 'main']);
    const r = await checkBranchMerged({ repoPath: repo.clone, payload: payload(repo, { action: 'pr' }) });
    expect(r).toMatchObject({ merged: true, branchDeleted: true, remoteBranchDeleted: false });
    expect(sh(repo.clone, 'git', ['ls-remote', '--heads', 'origin', 'aom/toy-1-x'])).toContain('aom/toy-1-x');
  });

  it('works from the remote branch alone when the local branch is gone', async () => {
    const repo = makeRepo();
    cardBranch(repo);
    sh(repo.clone, 'git', ['branch', '-D', 'aom/toy-1-x']);
    const before = await checkBranchMerged({ repoPath: repo.clone, payload: payload(repo) });
    expect(before.merged).toBe(false);
    sh(repo.clone, 'git', ['fetch', 'origin']);
    sh(repo.clone, 'git', ['merge', '--no-ff', '-m', 'merge', 'origin/aom/toy-1-x']);
    sh(repo.clone, 'git', ['push', 'origin', 'main']);
    const after = await checkBranchMerged({ repoPath: repo.clone, payload: payload(repo) });
    expect(after).toMatchObject({ merged: true, branchDeleted: false, remoteBranchDeleted: true });
  });

  it('refuses unsafe branch names and reports a missing working branch', async () => {
    const repo = makeRepo();
    const unsafe = await checkBranchMerged({
      repoPath: repo.clone,
      payload: payload(repo, { branchName: '--force' }),
    });
    expect(unsafe).toMatchObject({ merged: false });
    expect(unsafe.reason).toContain('unsafe');
    const missing = await checkBranchMerged({
      repoPath: repo.clone,
      payload: payload(repo, { workingBranch: 'nope' }),
    });
    expect(missing.reason).toContain('working branch nope was not found');
  });
});
