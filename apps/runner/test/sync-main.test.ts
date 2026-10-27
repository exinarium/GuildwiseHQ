import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { git } from '../src/git/git.ts';
import { withRepoLock } from '../src/git/repo-lock.ts';
import { abortMerge, mergeInProgress, mergeMainIntoCard, syncMainIntoWorking } from '../src/git/sync-main.ts';
import { ensureWorktree } from '../src/git/worktrees.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();

const REPO_ID = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';

/** origin with `main` and a `work` branch cut from it, plus a second clone other people push from. */
function setup() {
  const repo = makeRepo();
  sh(repo.clone, 'git', ['checkout', '-b', 'work']);
  sh(repo.clone, 'git', ['push', '-u', 'origin', 'work']);
  sh(repo.clone, 'git', ['checkout', 'main']);
  const other = join(tmp(), 'other');
  sh(repo.root, 'git', ['clone', repo.origin, other]);
  sh(other, 'git', ['checkout', 'main']);
  const push = (branch: string, file: string, text: string, message: string) => {
    sh(other, 'git', ['fetch', 'origin']);
    sh(other, 'git', ['checkout', branch]);
    sh(other, 'git', ['reset', '--hard', `origin/${branch}`]);
    mkdirSync(join(other, file, '..'), { recursive: true });
    writeFileSync(join(other, file), text);
    sh(other, 'git', ['add', '-A']);
    sh(other, 'git', ['commit', '-m', message]);
    sh(other, 'git', ['push', 'origin', branch]);
  };
  const input = (over = {}) => ({
    repoPath: repo.clone,
    mainBranch: 'main',
    workingBranch: 'work',
    ref: 'TOY-1',
    integrationDir: join(tmp(), 'integration'),
    ...over,
  });
  const cardWorktree = async () => {
    const path = join(tmp(), 'wt');
    const w = await ensureWorktree({
      repoPath: repo.clone,
      roots: ['/'],
      spec: {
        mode: 'create',
        repoId: REPO_ID,
        remoteUrlNormalized: repo.remoteNormalized,
        baseBranch: 'work',
        branchName: 'aom/toy-1-x',
      },
      defaultPath: path,
    });
    return { path, w };
  };
  return { repo, other, push, input, cardWorktree };
}

const originFile = (repo: { origin: string }, branch: string, file: string) =>
  sh(repo.origin, 'git', ['show', `${branch}:${file}`]);

describe('merge latest main first: into the working branch', () => {
  it('merges origin/main into the working branch, pushes it, and the card branch is cut from it', async () => {
    const t = setup();
    t.push('main', 'main-only.txt', 'from main\n', 'main moves');
    const out = await syncMainIntoWorking(t.input());
    expect(out.kind).toBe('merged_into_working');
    // pushed: origin/work has main's file and a merge commit
    expect(originFile(t.repo, 'work', 'main-only.txt')).toBe('from main');
    expect(sh(t.repo.origin, 'git', ['log', '-1', '--format=%s', 'work'])).toBe('Merge main into work');
    expect(out.kind === 'merged_into_working' && out.commit).toBe(
      sh(t.repo.origin, 'git', ['rev-parse', 'work']),
    );
    // the card branch is cut from the new working branch
    const { path } = await t.cardWorktree();
    expect(readFileSync(join(path, 'main-only.txt'), 'utf8')).toBe('from main\n');
    // the throwaway integration worktree is gone
    expect(sh(t.repo.clone, 'git', ['worktree', 'list'])).not.toContain('aom-integration');
  });

  it('does nothing when main is already in the working branch, or main is the working branch', async () => {
    const t = setup();
    expect((await syncMainIntoWorking(t.input())).kind).toBe('nothing');
    t.push('main', 'm.txt', 'm\n', 'main moves');
    expect((await syncMainIntoWorking(t.input({ workingBranch: 'main' }))).kind).toBe('nothing');
    // the working branch ahead of main (a card landed there) with nothing new in main is also nothing to do
    t.push('work', 'w.txt', 'w\n', 'work moves');
    sh(t.repo.origin, 'git', [
      'update-ref',
      'refs/heads/main',
      sh(t.repo.origin, 'git', ['rev-parse', 'work']),
    ]);
    expect((await syncMainIntoWorking(t.input())).kind).toBe('nothing');
  });

  it('does nothing without a remote or when a branch is not on origin', async () => {
    const t = setup();
    t.push('main', 'm.txt', 'm\n', 'main moves');
    expect((await syncMainIntoWorking(t.input({ workingBranch: 'not-there' }))).kind).toBe('nothing');
    const lonely = tmp();
    sh(lonely, 'git', ['init', '-b', 'main']);
    expect((await syncMainIntoWorking(t.input({ repoPath: lonely }))).kind).toBe('nothing');
  });

  it('resolves an unset main branch from origin/HEAD', async () => {
    const t = setup();
    t.push('main', 'm.txt', 'm\n', 'main moves');
    sh(t.repo.clone, 'git', ['remote', 'set-head', 'origin', 'main']);
    const out = await syncMainIntoWorking(t.input({ mainBranch: undefined }));
    expect(out.kind).toBe('merged_into_working');
  });

  it('retries once when the working branch moved while merging', async () => {
    const t = setup();
    t.push('main', 'main-only.txt', 'from main\n', 'main moves');
    let calls = 0;
    // The credentials callback runs right before each push: the first time somebody else pushes to the working branch.
    const auth = async () => {
      calls++;
      if (calls === 1) t.push('work', 'raced.txt', 'raced\n', 'work moves under us');
      return { args: [], env: {} };
    };
    const out = await syncMainIntoWorking(t.input({ auth }));
    expect(out.kind).toBe('merged_into_working');
    expect(calls).toBe(2);
    expect(originFile(t.repo, 'work', 'raced.txt')).toBe('raced');
    expect(originFile(t.repo, 'work', 'main-only.txt')).toBe('from main');
  });

  it('falls back to the card branch when the working branch is protected; origin is untouched', async () => {
    const t = setup();
    t.push('main', 'main-only.txt', 'from main\n', 'main moves');
    const hook = join(t.repo.origin, 'hooks', 'pre-receive');
    writeFileSync(
      hook,
      '#!/bin/sh\nwhile read old new ref; do if [ "$ref" = "refs/heads/work" ]; then echo "protected branch: GH006 changes must be made through a pull request" >&2; exit 1; fi; done\n',
    );
    chmodSync(hook, 0o755);
    const before = sh(t.repo.origin, 'git', ['rev-parse', 'work']);
    const out = await syncMainIntoWorking(t.input());
    expect(out).toMatchObject({ kind: 'needs_card_merge', reason: 'protected' });
    expect(sh(t.repo.origin, 'git', ['rev-parse', 'work'])).toBe(before);
    // the card branch takes the merge instead
    const { path } = await t.cardWorktree();
    const r = await mergeMainIntoCard(path, { mainBranch: 'main', ref: 'TOY-1' });
    expect(r).toMatchObject({ result: 'merged_into_card' });
    expect(readFileSync(join(path, 'main-only.txt'), 'utf8')).toBe('from main\n');
    expect(sh(path, 'git', ['log', '-1', '--format=%s'])).toBe('Merge main into the card branch');
  });

  it('a conflict leaves the working branch alone; the merge is left in the card worktree, or aborted', async () => {
    const t = setup();
    t.push('work', 'shared.txt', 'work side\n', 'work edits shared');
    t.push('main', 'shared.txt', 'main side\n', 'main edits shared');
    const before = sh(t.repo.origin, 'git', ['rev-parse', 'work']);
    const out = await syncMainIntoWorking(t.input());
    expect(out).toMatchObject({ kind: 'needs_card_merge', reason: 'conflict', files: ['shared.txt'] });
    expect(sh(t.repo.origin, 'git', ['rev-parse', 'work'])).toBe(before);
    expect(sh(t.repo.clone, 'git', ['worktree', 'list'])).not.toContain('aom-integration');

    const { path } = await t.cardWorktree();
    const r = await mergeMainIntoCard(path, { mainBranch: 'main', ref: 'TOY-1' });
    expect(r).toMatchObject({ result: 'conflict_in_card', files: ['shared.txt'] });
    expect(await mergeInProgress(path)).toBe(true);
    expect(readFileSync(join(path, 'shared.txt'), 'utf8')).toContain('<<<<<<<');
    // nobody can resolve it (a builder holds the shift): the merge is aborted and the tree is clean again
    await abortMerge(path);
    expect(await mergeInProgress(path)).toBe(false);
    expect(sh(path, 'git', ['status', '--porcelain'])).toBe('');
  });
});

describe('repo lock', () => {
  it('runs calls for one clone one after the other, in order', async () => {
    const order: string[] = [];
    const slow = withRepoLock('/tmp/some-clone', async () => {
      order.push('a:start');
      await new Promise((r) => setTimeout(r, 50));
      order.push('a:end');
    });
    const fast = withRepoLock('/tmp/some-clone', async () => {
      order.push('b');
    });
    const other = withRepoLock('/tmp/another-clone', async () => {
      order.push('c');
    });
    await Promise.all([slow, fast, other]);
    expect(order.indexOf('a:end')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('a:end')); // another clone does not wait
  });

  it('a failing call does not block the next one', async () => {
    await expect(withRepoLock('/tmp/x', async () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    await expect(withRepoLock('/tmp/x', async () => 'fine')).resolves.toBe('fine');
  });
});

describe('integration worktree hygiene', () => {
  it('leaves no temporary branch behind', async () => {
    const t = setup();
    t.push('main', 'm.txt', 'm\n', 'main moves');
    await syncMainIntoWorking(t.input());
    const branches = (
      await git(t.repo.clone, ['branch', '--list', 'aom-integration/*', 'guildwise/integration/*'])
    ).stdout.trim();
    expect(branches).toBe('');
    expect(existsSync(join(t.input().integrationDir, 'TOY-1-sync'))).toBe(false);
  });
});
