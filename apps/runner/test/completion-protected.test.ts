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

const payload = (repo: { remoteNormalized: string }, path: string): FinalizeExecutePayload => ({
  cardId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c1',
  ref: 'TOY-1',
  title: 'Add thing',
  projectKey: 'TOY',
  action: 'merge',
  repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
  remoteUrlNormalized: repo.remoteNormalized,
  baseBranch: 'main',
  branchName: BRANCH,
  worktreePath: path,
});

class FakePr implements PrCreator {
  calls: PrInput[] = [];
  constructor(private readonly result: Awaited<ReturnType<PrCreator['create']>>) {}
  async create(input: PrInput) {
    this.calls.push(input);
    return this.result;
  }
}

type Rules = NonNullable<Parameters<typeof executeCompletion>[0]['rules']>;

const run = (repo: { clone: string }, p: FinalizeExecutePayload, pr: PrCreator, rules: Rules) =>
  executeCompletion({
    payload: p,
    repoPath: repo.clone,
    worktreePath: p.worktreePath as string,
    worktreesDir: '/',
    integrationDir: join(tmp(), 'integration'),
    pr,
    rules,
  });

const blocked: Rules = async () => ({ directPushAllowed: false, requiresChange: true });

describe('completion: merge on a protected working branch (owner decision C9)', () => {
  it('opens a pull request instead of merging when the host says direct pushes are not allowed', async () => {
    const { repo, path } = await cardWorktree();
    const before = sh(repo.origin, 'git', ['rev-parse', 'main']);
    const pr = new FakePr({ url: 'https://host/acme/web/pull/3' });
    const res = await run(repo, payload(repo, path), pr, blocked);
    // Reported as a pull request (with protectedBranch), so the server records a PR and switches the project default.
    expect(res).toMatchObject({
      ok: true,
      action: 'pr',
      protectedBranch: true,
      pushedBranch: BRANCH,
      prUrl: 'https://host/acme/web/pull/3',
    });
    expect(res.mergeCommit).toBeUndefined();
    expect(res.notice).toMatch(/protected/);
    expect(sh(repo.origin, 'git', ['rev-parse', 'main'])).toBe(before);
    expect(sh(repo.origin, 'git', ['branch', '--list'])).toContain(BRANCH);
    expect(pr.calls[0]).toMatchObject({ base: 'main', branch: BRANCH });
  });

  it('plain git (no pull requests) pushes the branch and says to open the change by hand', async () => {
    const { repo, path } = await cardWorktree();
    const res = await run(
      repo,
      payload(repo, path),
      new FakePr({ unavailable: 'plain git has no pull requests' }),
      blocked,
    );
    expect(res).toMatchObject({ ok: true, action: 'pr', protectedBranch: true });
    expect(res.notice).toMatch(/open the pull request by hand/);
    expect(sh(repo.origin, 'git', ['branch', '--list'])).toContain(BRANCH);
  });

  it('unknown rules (null) and allowed pushes merge directly, as before', async () => {
    const a = await cardWorktree();
    expect(
      (await run(a.repo, payload(a.repo, a.path), new FakePr({}), async () => null)).mergeCommit,
    ).toBeTruthy();
    const b = await cardWorktree();
    const allowed: Rules = async () => ({ directPushAllowed: true, requiresChange: false });
    expect((await run(b.repo, payload(b.repo, b.path), new FakePr({}), allowed)).mergeCommit).toBeTruthy();
  });

  it('a host that refuses the push (a policy we could not read) falls back to a pull request', async () => {
    const { repo, path } = await cardWorktree();
    writeFileSync(
      join(repo.origin, 'hooks', 'pre-receive'),
      '#!/bin/sh\nwhile read old new ref; do if [ "$ref" = "refs/heads/main" ]; then echo "remote: error: GH006: Protected branch update failed" >&2; exit 1; fi; done\nexit 0\n',
      { mode: 0o755 },
    );
    const res = await run(
      repo,
      payload(repo, path),
      new FakePr({ url: 'https://host/pull/1' }),
      async () => null,
    );
    expect(res).toMatchObject({
      ok: true,
      action: 'pr',
      protectedBranch: true,
      prUrl: 'https://host/pull/1',
    });
    expect(res.mergeCommit).toBeUndefined();
    expect(res.notice).toMatch(/refused a direct push/);
  });
});
