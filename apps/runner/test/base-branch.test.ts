import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorktreeSpec } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { defaultBranchOf, git, resolveDefaultBranch } from '../src/git/git.ts';
import { withRepoLock } from '../src/git/repo-lock.ts';
import { createWorkingBranch, ensureWorktree, WorktreeError } from '../src/git/worktrees.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();

/** A repo whose origin has `main` (its HEAD) and a stale `master`, and whose clone's origin/HEAD still says master. */
function staleHeadRepo() {
  const repo = makeRepo();
  sh(repo.clone, 'git', ['branch', 'master', 'HEAD~0']);
  sh(repo.clone, 'git', ['push', 'origin', 'master']);
  sh(repo.clone, 'git', ['remote', 'set-head', 'origin', 'master']);
  expect(sh(repo.clone, 'git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).toBe('origin/master');
  return repo;
}

const spec = (o: Partial<WorktreeSpec> = {}): WorktreeSpec => ({
  mode: 'create',
  repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
  remoteUrlNormalized: 'x',
  baseBranch: 'main',
  branchName: 'aom/toy-1-add-greeting',
  ...o,
});

describe('default branch resolution', () => {
  it('asks the remote and repairs a stale local origin/HEAD', async () => {
    const repo = staleHeadRepo();
    expect(await defaultBranchOf(repo.clone)).toBe('main');
    expect(sh(repo.clone, 'git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).toBe('origin/main');
  });

  it('refuses to guess between main and master when the remote cannot be asked', async () => {
    const repo = staleHeadRepo();
    sh(repo.clone, 'git', ['remote', 'set-url', 'origin', join(tmp(), 'gone.git')]);
    const r = await resolveDefaultBranch(repo.clone);
    expect(r).toMatchObject({ branch: null, ambiguous: ['main', 'master'] });
    expect(await defaultBranchOf(repo.clone)).toBeNull();
  });

  it('falls back to the local origin/HEAD when the remote is unreachable and nothing is ambiguous', async () => {
    const repo = makeRepo();
    sh(repo.clone, 'git', ['remote', 'set-url', 'origin', join(tmp(), 'gone.git')]);
    expect(await resolveDefaultBranch(repo.clone)).toMatchObject({ branch: 'main', ambiguous: [] });
  });

  it('createWorkingBranch branches from the remote default, not the stale origin/HEAD', async () => {
    const repo = staleHeadRepo();
    // master is stale: main moves ahead on origin.
    const other = join(tmp(), 'other');
    sh(repo.root, 'git', ['clone', repo.origin, other]);
    writeFileSync(join(other, 'new.txt'), 'x');
    sh(other, 'git', ['add', '-A']);
    sh(other, 'git', ['commit', '-m', 'main moved']);
    sh(other, 'git', ['push', 'origin', 'main']);

    const made = await createWorkingBranch(repo.clone, 'dev');
    expect(made).toMatchObject({ ok: true, created: { base: 'dev', from: 'main', mainBranchSet: false } });
    const tip = sh(repo.origin, 'git', ['rev-parse', 'dev']);
    expect(tip).toBe(sh(repo.origin, 'git', ['rev-parse', 'main']));
  });

  it('createWorkingBranch with an explicit main branch reports it as set', async () => {
    const repo = makeRepo();
    const made = await createWorkingBranch(repo.clone, 'dev', { mainBranch: 'main' });
    expect(made).toMatchObject({ ok: true, created: { from: 'main', mainBranchSet: true } });
  });

  it('refuses to create the working branch when the main branch is unset and ambiguous', async () => {
    const repo = staleHeadRepo();
    sh(repo.clone, 'git', ['remote', 'set-url', 'origin', join(tmp(), 'gone.git')]);
    const made = await createWorkingBranch(repo.clone, 'dev');
    expect(made).toMatchObject({ ok: false });
    expect(made.ok ? '' : made.refusal).toContain('Set the main branch for toy in Project settings');
    expect(made.ok ? '' : made.refusal).toContain('both main and master');

    await expect(
      ensureWorktree({
        repoPath: repo.clone,
        roots: ['/'],
        spec: spec({ baseBranch: 'dev' }),
        defaultPath: join(tmp(), 'wt', 'TOY-9'),
      }),
    ).rejects.toThrow(WorktreeError);
    expect(sh(repo.clone, 'git', ['branch', '--list', 'dev'])).toBe('');
  });
});

describe('per-clone serialization', () => {
  it('creates worktrees for four shifts started at the same moment in one clone', async () => {
    const repo = makeRepo();
    const results = await Promise.all(
      [1, 2, 3, 4].map((n) =>
        ensureWorktree({
          repoPath: repo.clone,
          roots: ['/'],
          spec: spec({ branchName: `aom/toy-${n}-work` }),
          defaultPath: join(tmp(), 'wt', `TOY-${n}`),
        }),
      ),
    );
    expect(results.map((r) => r.created)).toEqual([true, true, true, true]);
    for (const r of results) expect(existsSync(r.path)).toBe(true);
  });

  it('runs locked sections of one clone one after the other, and may nest', async () => {
    const order: string[] = [];
    const a = withRepoLock('/x/clone', async () => {
      order.push('a1');
      await new Promise((r) => setTimeout(r, 30));
      await withRepoLock('/x/clone', async () => void order.push('nested'));
      order.push('a2');
    });
    const b = withRepoLock('/x/clone', async () => void order.push('b'));
    await Promise.all([a, b]);
    expect(order).toEqual(['a1', 'nested', 'a2', 'b']);
  });

  it('retries a command that hit a lock another git process held', async () => {
    const repo = makeRepo();
    const lock = join(repo.clone, '.git', 'config.lock');
    writeFileSync(lock, '');
    setTimeout(() => rmSync(lock, { force: true }), 150);
    const r = await git(repo.clone, ['config', 'aom.test', 'yes']);
    expect(r.exitCode).toBe(0);
    expect(sh(repo.clone, 'git', ['config', 'aom.test'])).toBe('yes');
  });
});
