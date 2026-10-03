import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FinalizeExecutePayload } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { executeCompletion } from '../src/git/completion.ts';
import type { PrCreator, PrInput } from '../src/git/gh.ts';
import { ensureWorktree } from '../src/git/worktrees.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();

const BRANCH = 'aom/toy-1-add-thing';

/** A card branch with one commit in a worktree; bare-origin fixtures live in tmp, nothing leaves the machine. */
async function cardWorktree(repo = makeRepo(), file = 'thing.txt') {
  const path = join(tmp(), 'wt');
  await ensureWorktree({
    repoPath: repo.clone,
    spec: {
      mode: 'create',
      repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
      remoteUrlNormalized: repo.remoteNormalized,
      baseBranch: 'main',
      branchName: BRANCH,
    },
    defaultPath: path,
  });
  writeFileSync(join(path, file), 'thing\n');
  sh(path, 'git', ['add', '-A']);
  sh(path, 'git', ['commit', '-m', 'add thing']);
  return { repo, path };
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

class FakePr implements PrCreator {
  calls: PrInput[] = [];
  constructor(private readonly result: Awaited<ReturnType<PrCreator['create']>> | Error) {}
  async create(input: PrInput) {
    this.calls.push(input);
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

const run = (repo: { clone: string }, p: FinalizeExecutePayload, pr: PrCreator = new FakePr({})) =>
  executeCompletion({
    payload: p,
    repoPath: repo.clone,
    worktreePath: p.worktreePath as string,
    integrationDir: join(tmp(), 'integration'),
    pr,
  });

const originLog = (repo: { origin: string }) => sh(repo.origin, 'git', ['log', '--format=%s', 'main']);

describe('completion: merge', () => {
  it('merges with --no-ff into the working branch and pushes it; the clone follows', async () => {
    const { repo, path } = await cardWorktree();
    const res = await run(repo, payload(repo, path, 'merge'));
    expect(res.ok).toBe(true);
    expect(res.mergeCommit).toBe(sh(repo.origin, 'git', ['rev-parse', 'main']));
    expect(originLog(repo).split('\n')[0]).toBe('Merge aom/toy-1-add-thing (TOY-1: Add thing)');
    expect(originLog(repo)).toContain('add thing');
    // a real merge commit (two parents)
    expect(sh(repo.origin, 'git', ['rev-list', '--parents', '-n', '1', 'main']).split(' ')).toHaveLength(3);
    // the card branch was not pushed anywhere
    expect(sh(repo.origin, 'git', ['branch', '--list'])).not.toContain('aom/');
    // the local clone's main (checked out, clean) fast-forwarded; no integration worktree is left behind
    expect(readFileSync(join(repo.clone, 'thing.txt'), 'utf8')).toBe('thing\n');
    expect(sh(repo.clone, 'git', ['worktree', 'list'])).not.toContain('integration');
    expect(sh(repo.clone, 'git', ['branch', '--list', 'aom-integration/*'])).toBe('');
  });

  it('is idempotent: running it again reports the same merge commit', async () => {
    const { repo, path } = await cardWorktree();
    const first = await run(repo, payload(repo, path, 'merge'));
    const second = await run(repo, payload(repo, path, 'merge'));
    expect(second).toMatchObject({ ok: true, mergeCommit: first.mergeCommit });
    expect(originLog(repo).match(/Merge aom/g)).toHaveLength(1);
  });

  it('rebases onto a moved working branch first, so a divergent main still merges', async () => {
    const { repo, path } = await cardWorktree();
    const other = join(tmp(), 'other');
    sh(repo.root, 'git', ['clone', repo.origin, other]);
    writeFileSync(join(other, 'other.txt'), 'o');
    sh(other, 'git', ['add', '-A']);
    sh(other, 'git', ['commit', '-m', 'someone else']);
    sh(other, 'git', ['push', 'origin', 'main']);
    const res = await run(repo, payload(repo, path, 'merge'));
    expect(res.ok).toBe(true);
    expect(originLog(repo)).toContain('someone else');
    expect(originLog(repo)).toContain('add thing');
  });

  it('a conflict with the moved working branch is reported, not resolved; nothing is pushed', async () => {
    const repo = makeRepo();
    const { path } = await cardWorktree(repo, 'README.md');
    const other = join(tmp(), 'other');
    sh(repo.root, 'git', ['clone', repo.origin, other]);
    writeFileSync(join(other, 'README.md'), 'conflicting\n');
    sh(other, 'git', ['add', '-A']);
    sh(other, 'git', ['commit', '-m', 'conflicting']);
    sh(other, 'git', ['push', 'origin', 'main']);
    const before = sh(repo.origin, 'git', ['rev-parse', 'main']);
    const res = await run(repo, payload(repo, path, 'merge'));
    expect(res).toMatchObject({ ok: false, conflict: true, conflictedFiles: ['README.md'] });
    expect(sh(repo.origin, 'git', ['rev-parse', 'main'])).toBe(before);
  });

  it('refuses a worktree with uncommitted changes', async () => {
    const { repo, path } = await cardWorktree();
    writeFileSync(join(path, 'dirty.txt'), 'x');
    const res = await run(repo, payload(repo, path, 'merge'));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/uncommitted/);
  });

  it('works without an origin: updates the local working branch', async () => {
    const repo = makeRepo();
    sh(repo.clone, 'git', ['remote', 'remove', 'origin']);
    const { path } = await cardWorktree(repo);
    const res = await run(repo, payload(repo, path, 'merge'));
    expect(res.ok).toBe(true);
    expect(sh(repo.clone, 'git', ['rev-parse', 'main'])).toBe(res.mergeCommit);
  });

  it('recreates a missing worktree from the card branch', async () => {
    const { repo, path } = await cardWorktree();
    sh(repo.clone, 'git', ['worktree', 'remove', '--force', path]);
    expect(existsSync(path)).toBe(false);
    const res = await run(repo, payload(repo, path, 'merge'));
    expect(res.ok).toBe(true);
  });
});

describe('completion: push_branch and pr', () => {
  it('push_branch pushes the card branch with upstream and does not touch main', async () => {
    const { repo, path } = await cardWorktree();
    const mainBefore = sh(repo.origin, 'git', ['rev-parse', 'main']);
    const res = await run(repo, payload(repo, path, 'push_branch'));
    expect(res).toMatchObject({ ok: true, pushedBranch: BRANCH });
    expect(sh(repo.origin, 'git', ['rev-parse', BRANCH])).toBe(sh(path, 'git', ['rev-parse', 'HEAD']));
    expect(sh(repo.origin, 'git', ['rev-parse', 'main'])).toBe(mainBefore);
    expect(sh(path, 'git', ['rev-parse', '--abbrev-ref', '@{upstream}'])).toBe(`origin/${BRANCH}`);
  });

  it('pr pushes, then asks the PR adapter; the URL is returned', async () => {
    const { repo, path } = await cardWorktree();
    const pr = new FakePr({ url: 'https://example.test/acme/toy/pull/7' });
    const res = await run(repo, payload(repo, path, 'pr'), pr);
    expect(res).toMatchObject({
      ok: true,
      prUrl: 'https://example.test/acme/toy/pull/7',
      pushedBranch: BRANCH,
    });
    expect(pr.calls).toEqual([
      expect.objectContaining({ base: 'main', branch: BRANCH, title: 'TOY-1: Add thing' }),
    ]);
    expect(sh(repo.origin, 'git', ['rev-parse', '--verify', BRANCH])).toBeTruthy();
  });

  it('pr without gh pushes the branch and returns a notice instead of failing', async () => {
    const { repo, path } = await cardWorktree();
    const res = await run(
      repo,
      payload(repo, path, 'pr'),
      new FakePr({ unavailable: 'gh is not available' }),
    );
    expect(res.ok).toBe(true);
    expect(res.prUrl).toBeUndefined();
    expect(res.notice).toContain('gh is not available');
    expect(res.pushedBranch).toBe(BRANCH);
  });

  it('a failing PR adapter is a failure (the branch stays pushed)', async () => {
    const { repo, path } = await cardWorktree();
    const res = await run(
      repo,
      payload(repo, path, 'pr'),
      new FakePr(new Error('gh pr create failed: boom')),
    );
    expect(res).toMatchObject({ ok: false, error: 'gh pr create failed: boom' });
  });

  it('push without an origin remote fails clearly', async () => {
    const repo = makeRepo();
    sh(repo.clone, 'git', ['remote', 'remove', 'origin']);
    const { path } = await cardWorktree(repo);
    const res = await run(repo, payload(repo, path, 'push_branch'));
    expect(res).toMatchObject({ ok: false });
    expect(res.error).toMatch(/no origin/);
  });
});
