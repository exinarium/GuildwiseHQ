import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FinalizeExecutePayload } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { executeCompletion } from '../src/git/completion.ts';
import type { PrCreator, PrInput } from '../src/git/gh.ts';
import { ensureWorktree } from '../src/git/worktrees.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();

const BRANCH = 'aom/toy-1-add-thing';

class FakePr implements PrCreator {
  calls: PrInput[] = [];
  constructor(private readonly result: Awaited<ReturnType<PrCreator['create']>>) {}
  async create(input: PrInput) {
    this.calls.push(input);
    return this.result;
  }
}

/** A card whose working branch `develop` does not exist yet: the worktree creates it from `main` and pushes it. */
async function developCard() {
  const repo = makeRepo();
  const path = join(tmp(), 'wt');
  const w = await ensureWorktree({
    repoPath: repo.clone,
    roots: ['/'],
    spec: {
      mode: 'create',
      repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
      remoteUrlNormalized: repo.remoteNormalized,
      baseBranch: 'develop',
      mainBranch: 'main',
      branchName: BRANCH,
    },
    defaultPath: path,
  });
  expect(w.createdBranch).toEqual({ base: 'develop', from: 'main', pushed: true });
  writeFileSync(join(path, 'thing.txt'), 'thing\n');
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
  baseBranch: 'develop',
  branchName: BRANCH,
  worktreePath: path,
});

const run = (repo: { clone: string }, p: FinalizeExecutePayload, pr: PrCreator = new FakePr({})) =>
  executeCompletion({
    payload: p,
    repoPath: repo.clone,
    worktreePath: p.worktreePath as string,
    worktreesDir: '/',
    integrationDir: join(tmp(), 'integration'),
    pr,
  });

describe('completion with a working branch that differs from the main branch', () => {
  it('"commit and push to the working branch" (merge) pushes the working branch; main and the card branch stay untouched', async () => {
    const { repo, path } = await developCard();
    const mainBefore = sh(repo.origin, 'git', ['rev-parse', 'main']);
    const res = await run(repo, payload(repo, path, 'merge'));
    expect(res.ok).toBe(true);
    expect(res.mergeCommit).toBe(sh(repo.origin, 'git', ['rev-parse', 'develop']));
    expect(sh(repo.origin, 'git', ['log', '--format=%s', 'develop'])).toContain('add thing');
    expect(sh(repo.origin, 'git', ['rev-parse', 'main'])).toBe(mainBefore);
    expect(sh(repo.origin, 'git', ['branch', '--list'])).not.toContain('aom/');
  });

  it('a pull request from a card goes into the working branch, not the main branch', async () => {
    const { repo, path } = await developCard();
    const pr = new FakePr({ url: 'https://example.test/acme/toy/pull/8' });
    const res = await run(repo, payload(repo, path, 'pr'), pr);
    expect(res.ok).toBe(true);
    expect(pr.calls[0]).toMatchObject({ base: 'develop', branch: BRANCH });
  });

  it('pushing only the card branch leaves both the working branch and the main branch alone', async () => {
    const { repo, path } = await developCard();
    const developBefore = sh(repo.origin, 'git', ['rev-parse', 'develop']);
    const res = await run(repo, payload(repo, path, 'push_branch'));
    expect(res).toMatchObject({ ok: true, pushedBranch: BRANCH });
    expect(sh(repo.origin, 'git', ['rev-parse', 'develop'])).toBe(developBefore);
  });
});
