import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { git } from '../src/git/git.ts';
import { syncWorkingBranch } from '../src/git/sync-branch.ts';
import { ensureWorktree } from '../src/git/worktrees.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();

/** origin with `main` and `work`; the clone is on `main`; a second clone pushes to `work`. */
function setup() {
  const repo = makeRepo();
  sh(repo.clone, 'git', ['checkout', '-b', 'work']);
  sh(repo.clone, 'git', ['push', '-u', 'origin', 'work']);
  sh(repo.clone, 'git', ['checkout', 'main']);
  const other = join(tmp(), 'other');
  sh(repo.root, 'git', ['clone', repo.origin, other]);
  const pushWork = (file: string) => {
    sh(other, 'git', ['fetch', 'origin']);
    sh(other, 'git', ['checkout', '-B', 'work', 'origin/work']);
    writeFileSync(join(other, file), file);
    sh(other, 'git', ['add', '-A']);
    sh(other, 'git', ['commit', '-m', file]);
    sh(other, 'git', ['push', 'origin', 'work']);
  };
  const tip = (ref: string) => sh(repo.clone, 'git', ['rev-parse', ref]).trim();
  return { repo, pushWork, tip };
}

describe('syncWorkingBranch', () => {
  it('moves the ref when the branch is not checked out and local is an ancestor', async () => {
    const { repo, pushWork, tip } = setup();
    pushWork('a.txt');
    const r = await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'work' });
    expect(r).toMatchObject({
      state: 'updated',
      ahead: 0,
      behind: 0,
      onBranch: false,
      checkedOutBranch: 'main',
    });
    expect(tip('work')).toBe(tip('origin/work'));
  });

  it('fast-forwards the checkout when it is on the branch and clean', async () => {
    const { repo, pushWork, tip } = setup();
    sh(repo.clone, 'git', ['checkout', 'work']);
    pushWork('b.txt');
    const r = await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'work' });
    expect(r).toMatchObject({ state: 'updated', onBranch: true, dirty: false });
    expect(tip('HEAD')).toBe(tip('origin/work'));
  });

  it('fast-forwards past unrelated local changes (an untracked file) and keeps them', async () => {
    const { repo, pushWork, tip } = setup();
    sh(repo.clone, 'git', ['checkout', 'work']);
    pushWork('c.txt');
    writeFileSync(join(repo.clone, 'mine.txt'), 'wip');
    const r = await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'work' });
    expect(r).toMatchObject({ state: 'updated', behind: 0, dirty: true, onBranch: true });
    expect(tip('HEAD')).toBe(tip('origin/work'));
    expect(sh(repo.clone, 'git', ['status', '--short'])).toContain('mine.txt');
  });

  it('leaves the checkout alone when a local change would be overwritten, and names the file', async () => {
    const { repo, pushWork, tip } = setup();
    sh(repo.clone, 'git', ['checkout', 'work']);
    const before = tip('HEAD');
    pushWork('c.txt');
    writeFileSync(join(repo.clone, 'c.txt'), 'my own version');
    const r = await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'work' });
    expect(r).toMatchObject({ state: 'dirty', behind: 1, dirty: true, onBranch: true });
    expect(r.detail).toContain('c.txt');
    expect(tip('HEAD')).toBe(before);
  });

  it('does nothing when diverged', async () => {
    const { repo, pushWork, tip } = setup();
    sh(repo.clone, 'git', ['checkout', 'work']);
    writeFileSync(join(repo.clone, 'local.txt'), 'x');
    sh(repo.clone, 'git', ['add', '-A']);
    sh(repo.clone, 'git', ['commit', '-m', 'local']);
    const before = tip('HEAD');
    pushWork('d.txt');
    const r = await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'work' });
    expect(r).toMatchObject({ state: 'diverged', ahead: 1, behind: 1 });
    expect(tip('HEAD')).toBe(before);
  });

  it('reports synced and ahead', async () => {
    const { repo } = setup();
    expect((await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'work' })).state).toBe('synced');
    sh(repo.clone, 'git', ['checkout', 'work']);
    writeFileSync(join(repo.clone, 'l.txt'), 'x');
    sh(repo.clone, 'git', ['add', '-A']);
    sh(repo.clone, 'git', ['commit', '-m', 'l']);
    expect(await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'work' })).toMatchObject({
      state: 'ahead',
      ahead: 1,
    });
  });

  it('defers while a card shift works in the repository', async () => {
    const { repo, pushWork, tip } = setup();
    const wt = join(tmp(), 'wt');
    await ensureWorktree({
      repoPath: repo.clone,
      roots: ['/'],
      spec: {
        mode: 'create',
        repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
        remoteUrlNormalized: repo.remoteNormalized,
        baseBranch: 'work',
        branchName: 'aom/TOY-1',
      },
      defaultPath: wt,
    });
    const before = tip('work');
    pushWork('e.txt');
    const r = await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'work', busyWorktrees: [wt] });
    expect(r).toMatchObject({ state: 'busy', behind: 1 });
    expect(tip('work')).toBe(before);
    const again = await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'work' });
    expect(again.state).toBe('updated');
  });

  it('leaves a branch checked out in another worktree alone; a stale expected value is refused', async () => {
    const { repo, pushWork, tip } = setup();
    const wt = join(tmp(), 'wt2');
    sh(repo.clone, 'git', ['worktree', 'add', wt, 'work']);
    pushWork('f.txt');
    const before = tip('work');
    const r = await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'work' });
    expect(r.state).toBe('behind');
    expect(tip('work')).toBe(before);
    const stale = await git(repo.clone, [
      'update-ref',
      'refs/heads/work',
      tip('origin/work'),
      tip('origin/work'),
    ]);
    expect(stale.exitCode).not.toBe(0);
  });

  it('without an origin it says so', async () => {
    const dir = tmp();
    sh(dir, 'git', ['init', '-b', 'work']);
    expect((await syncWorkingBranch({ repoPath: dir, workingBranch: 'work' })).state).toBe('no_remote');
  });
});
