import { type BranchCheckMergedPayload, type BranchCheckMergedResult, isSafeGitRef } from '@aom/shared';
import { git, hasRemote, revParse } from './git.ts';
import { baseTarget } from './rebase.ts';

/** Is `a` an ancestor of (or the same commit as) `b`? Pure git; deletes nothing. */
export async function isAncestor(repoPath: string, a: string, b: string): Promise<boolean> {
  return (await git(repoPath, ['merge-base', '--is-ancestor', a, b])).exitCode === 0;
}

/**
 * `branch.check_merged` (docs/design/phases.md A2 and the worktree/branch cleanup addendum): is the card branch's head
 * an ancestor of the working branch? Pure git, no GitHub. A branch that is merged is deleted, locally and (for
 * `push_branch`, which pushed it) on the remote; an unmerged one is left alone. Idempotent.
 */
export async function checkBranchMerged(input: {
  repoPath: string;
  payload: BranchCheckMergedPayload;
}): Promise<BranchCheckMergedResult> {
  const { repoPath, payload: p } = input;
  const result = (
    merged: boolean,
    extra: Partial<BranchCheckMergedResult> = {},
  ): BranchCheckMergedResult => ({
    merged,
    branchDeleted: false,
    remoteBranchDeleted: false,
    ...extra,
  });
  for (const ref of [p.branchName, p.workingBranch])
    if (!isSafeGitRef(ref))
      return result(false, { reason: `refusing unsafe branch name ${JSON.stringify(ref)}` });
  const remote = await hasRemote(repoPath);
  if (remote) {
    // Best effort: the working branch is the one that matters; the card branch may only exist locally or be gone.
    await git(repoPath, ['fetch', '--prune', '--', 'origin', p.workingBranch]);
    await git(repoPath, ['fetch', '--', 'origin', p.branchName]);
  }
  const target = await baseTarget(repoPath, p.workingBranch);
  if (!(await revParse(repoPath, target)))
    return result(false, { reason: `the working branch ${p.workingBranch} was not found` });

  const hasLocal = !!(await revParse(repoPath, `refs/heads/${p.branchName}`));
  const hasRemoteRef = !!(await revParse(repoPath, `refs/remotes/origin/${p.branchName}`));
  const head = hasLocal
    ? `refs/heads/${p.branchName}`
    : hasRemoteRef
      ? `refs/remotes/origin/${p.branchName}`
      : null;
  if (!head)
    return result(false, { reason: `the branch ${p.branchName} was not found, locally or on the remote` });

  if (!(await isAncestor(repoPath, head, target)))
    return result(false, { reason: `${p.branchName} is not merged into ${p.workingBranch} yet` });

  let branchDeleted = false;
  let remoteBranchDeleted = false;
  if (hasLocal) {
    // Never delete the branch the main checkout is on.
    const current = (await git(repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
    if (current !== p.branchName)
      branchDeleted = (await git(repoPath, ['branch', '-D', '--', p.branchName])).exitCode === 0;
  }
  if (remote && hasRemoteRef && p.action === 'push_branch') {
    remoteBranchDeleted =
      (await git(repoPath, ['push', 'origin', '--delete', '--', p.branchName])).exitCode === 0;
  }
  return result(true, { branchDeleted, remoteBranchDeleted });
}
