import type { CommitAs } from '@aom/shared';
import { isSafeGitRef } from '@aom/shared';
import { git, hasRemote, revParse } from './git.ts';
import { committerEnv, requireCommitIdentity } from './identity.ts';

/**
 * Rebasing rewrites commits, which needs a committer; the author of each commit is kept. The committer is the resolved
 * commit identity (project setting, repository, workstation; see identity.ts); with none set this throws
 * `NoCommitIdentityError`, there is no fallback to a product name.
 */
export async function rebaseEnv(
  worktree: string,
  commitAs?: CommitAs | null,
): Promise<Record<string, string>> {
  return committerEnv(await requireCommitIdentity(worktree, commitAs));
}

/** A merge commit needs an author too: the same identity as the committer of a rebase. */
const authorEnv = (env: Record<string, string>) => ({
  GIT_AUTHOR_NAME: env.GIT_COMMITTER_NAME as string,
  GIT_AUTHOR_EMAIL: env.GIT_COMMITTER_EMAIL as string,
});

export class RebaseConflictError extends Error {
  constructor(readonly conflictedFiles: string[]) {
    super(`rebase conflict in ${conflictedFiles.join(', ')}`);
  }
}

/** `origin/<base>` when the remote branch exists in this repo, else `<base>`. */
export async function baseTarget(worktree: string, baseBranch: string): Promise<string> {
  return (await revParse(worktree, `refs/remotes/origin/${baseBranch}`))
    ? `origin/${baseBranch}`
    : baseBranch;
}

/**
 * Runner-side rebase before test and finalize (docs/ARCHITECTURE.md section 13.6): `git fetch origin <base>`, then
 * `git rebase origin/<base>`. On a conflict the conflicted files are collected, the rebase is aborted (never leaves a
 * half-done rebase behind) and `RebaseConflictError` is thrown: the card becomes Rework, no agent resolves it.
 */
export async function rebaseOntoBase(
  worktree: string,
  baseBranch: string,
  commitAs?: CommitAs | null,
): Promise<'up_to_date' | 'rebased' | 'merged'> {
  if (!isSafeGitRef(baseBranch)) throw new Error(`refusing unsafe base branch ${JSON.stringify(baseBranch)}`);
  if (await hasRemote(worktree)) await git(worktree, ['fetch', '--', 'origin', baseBranch]);
  const target = await baseTarget(worktree, baseBranch);
  // Already contains the base (for example the builder merged it and resolved a conflict there): nothing to do.
  if ((await git(worktree, ['merge-base', '--is-ancestor', target, 'HEAD'])).exitCode === 0)
    return 'up_to_date';
  const renv = await rebaseEnv(worktree, commitAs);
  // A card branch with merge commits of its own is brought up to date with a merge: a plain rebase would drop those
  // merges and replay the card's commits, hitting the conflicts their resolution already settled.
  const mergeBase = (await git(worktree, ['merge-base', target, 'HEAD'])).stdout.trim();
  const merges = mergeBase
    ? (await git(worktree, ['rev-list', '--merges', '--count', `${mergeBase}..HEAD`])).stdout.trim()
    : '0';
  if (merges !== '' && merges !== '0') {
    const m = await git(worktree, ['merge', '--no-edit', '--', target], {
      env: { ...renv, ...authorEnv(renv) },
    });
    if (m.exitCode === 0) return 'merged';
    const conflictedMerge = (await git(worktree, ['diff', '--name-only', '--diff-filter=U'])).stdout
      .split('\n')
      .filter(Boolean);
    await git(worktree, ['merge', '--abort']);
    if (conflictedMerge.length === 0)
      throw new Error(`git merge ${target} failed: ${(m.stderr || m.stdout).trim()}`);
    throw new RebaseConflictError(conflictedMerge);
  }
  const r = await git(worktree, ['rebase', target], { env: renv });
  if (r.exitCode === 0) return 'rebased';
  const conflicted = (await git(worktree, ['diff', '--name-only', '--diff-filter=U'])).stdout
    .split('\n')
    .filter(Boolean);
  await git(worktree, ['rebase', '--abort']);
  if (conflicted.length === 0)
    throw new Error(`git rebase ${target} failed: ${(r.stderr || r.stdout).trim()}`);
  throw new RebaseConflictError(conflicted);
}
