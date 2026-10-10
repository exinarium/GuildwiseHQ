import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FinalizeExecutePayload } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import type { BranchRules } from '../src/forge/types.ts';
import { executeCompletion } from '../src/git/completion.ts';
import { isProtectedBranchRejection, type PrCreator, type PrInput } from '../src/git/gh.ts';
import { ensureWorktree } from '../src/git/worktrees.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();

const BRANCH = 'aom/toy-1-add-thing';
const ID = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';

async function cardWorktree() {
  const repo = makeRepo();
  const path = join(tmp(), 'wt');
  await ensureWorktree({
    repoPath: repo.clone,
    roots: ['/'],
    spec: {
      mode: 'create',
      repoId: ID,
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

const payload = (repo: { remoteNormalized: string }, path: string): FinalizeExecutePayload => ({
  cardId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c1',
  ref: 'TOY-1',
  title: 'Add thing',
  projectKey: 'TOY',
  action: 'merge',
  repoId: ID,
  remoteUrlNormalized: repo.remoteNormalized,
  baseBranch: 'main',
  branchName: BRANCH,
  worktreePath: path,
});

class FakePr implements PrCreator {
  calls: PrInput[] = [];
  constructor(private readonly url: string) {}
  async create(input: PrInput) {
    this.calls.push(input);
    return { url: this.url };
  }
}

/** What the repository's forge says about the working branch (`unknown`: the rules cannot be read). */
type Protection = 'protected' | 'open' | 'unknown';
const RULES: Record<Protection, BranchRules | null> = {
  protected: { directPushAllowed: false, requiresChange: true },
  open: { directPushAllowed: true, requiresChange: false },
  unknown: null,
};

const run = (
  repo: { clone: string; remoteNormalized: string },
  path: string,
  pr: PrCreator,
  protection?: Protection,
) =>
  executeCompletion({
    payload: payload(repo, path),
    repoPath: repo.clone,
    worktreePath: path,
    worktreesDir: '/',
    integrationDir: join(tmp(), 'integration'),
    pr,
    ...(protection ? { rules: async () => RULES[protection] } : {}),
  });

const HOOK =
  '#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = "refs/heads/main" ]; then echo "remote: error: GH006: Protected branch update failed for refs/heads/main." >&2; exit 1; fi\ndone\n';

describe('completion (project default merge): a protected working branch turns the merge into a pull request', () => {
  it('the host says it is protected: no merge is attempted, a PR is opened', async () => {
    const { repo, path } = await cardWorktree();
    const pr = new FakePr('https://example.test/pr/1');
    const before = sh(repo.origin, 'git', ['rev-parse', 'main']);
    const res = await run(repo, path, pr, 'protected');
    expect(res).toMatchObject({
      ok: true,
      action: 'pr',
      protectedBranch: true,
      prUrl: 'https://example.test/pr/1',
    });
    expect(sh(repo.origin, 'git', ['rev-parse', 'main'])).toBe(before);
    expect(sh(repo.origin, 'git', ['rev-parse', BRANCH])).toBeTruthy();
    expect(pr.calls).toHaveLength(1);
  });

  it('the host does not say, but rejects the push: falls back to a PR without changing main', async () => {
    const { repo, path } = await cardWorktree();
    writeFileSync(join(repo.origin, 'hooks', 'pre-receive'), HOOK, { mode: 0o755 });
    const pr = new FakePr('https://example.test/pr/2');
    const before = sh(repo.origin, 'git', ['rev-parse', 'main']);
    const res = await run(repo, path, pr, 'unknown');
    expect(res).toMatchObject({ ok: true, action: 'pr', protectedBranch: true });
    expect(sh(repo.origin, 'git', ['rev-parse', 'main'])).toBe(before);
    expect(sh(repo.origin, 'git', ['rev-parse', BRANCH])).toBeTruthy();
    expect(pr.calls).toHaveLength(1);
  });

  it('an unprotected branch still merges', async () => {
    const { repo, path } = await cardWorktree();
    const res = await run(repo, path, new FakePr('x'), 'open');
    expect(res).toMatchObject({ ok: true, action: 'merge' });
    expect(res.protectedBranch).toBeUndefined();
  });

  it('recognises the usual protected-branch rejections', () => {
    expect(isProtectedBranchRejection('remote: error: GH006: Protected branch update failed')).toBe(true);
    expect(
      isProtectedBranchRejection('! [remote rejected] main -> main (protected branch hook declined)'),
    ).toBe(true);
    expect(isProtectedBranchRejection('fatal: Authentication failed')).toBe(false);
    expect(isProtectedBranchRejection('! [rejected] main -> main (non-fast-forward)')).toBe(false);
  });
});
