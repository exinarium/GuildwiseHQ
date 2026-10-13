import { isSafeGitRef } from '@aom/shared';
import { git, hasRemote } from './git.ts';
import { mergeInProgress, mergeMainIntoCard } from './sync-main.ts';
import type { GitAuth } from './worktrees.ts';

/**
 * The git commands the architect may use through `aom git ...`, run by the runner in the card's worktree (the agent's
 * own shell keeps `git push`, `git fetch`, `git pull` and `git remote` denied: the credentials stay out of the sandbox).
 * Nothing here accepts a path or a ref from the agent except to check it is the card branch.
 */

export interface ArchitectGitContext {
  /** The card worktree. */
  worktree: string;
  /** The card branch: the only ref that may be pushed. */
  branchName: string;
  /** The repository's main branch when the server named it. */
  mainBranch?: string;
  ref: string;
  /**
   * The card's completion action. Only a card that ends in a pull request or a pushed branch publishes its card branch;
   * with `merge` (or none yet) the branch stays local and the runner pushes just the working branch at finalize.
   */
  completionAction?: 'pr' | 'push_branch' | 'merge' | null;
  auth?: GitAuth;
  /** Remembers the `origin/<main>` SHA merged into the card branch (the post-shift guard exempts what it changed). */
  recordMainSha: (sha: string) => void;
  /** The `origin/<main>` SHA the "merge latest main first" step recorded before the shift (may be unset). */
  startMainSha?: () => string | undefined;
}

export type GitReply = { ok: true; message: string } | { ok: false; error: string };

const remoteUrl = async (cwd: string): Promise<string> =>
  (await git(cwd, ['remote', 'get-url', 'origin'])).stdout.trim();

/** `aom git push [<branch>]`: pushes the card branch (`git push -u origin <branch>`), nothing else. */
export async function architectPush(ctx: ArchitectGitContext, requested?: string): Promise<GitReply> {
  if (requested !== undefined && requested !== ctx.branchName)
    return {
      ok: false,
      error: `only the card branch (${ctx.branchName}) can be pushed; '${requested}' was refused`,
    };
  if (!isSafeGitRef(ctx.branchName)) return { ok: false, error: 'the card branch name is not a safe ref' };
  if (ctx.completionAction !== 'pr' && ctx.completionAction !== 'push_branch')
    return {
      ok: false,
      error: `this card ${ctx.completionAction === 'merge' ? 'is merged into the working branch when it finishes' : 'has no completion action that publishes its branch'}, so the card branch is not pushed: it stays on this workstation and your commits are used from here. Commit your work and continue`,
    };
  if (!(await hasRemote(ctx.worktree))) return { ok: false, error: 'the repository has no origin remote' };
  const dirty = (await git(ctx.worktree, ['status', '--porcelain', '--untracked-files=no'])).stdout.trim();
  if (dirty) return { ok: false, error: 'commit your changes first; the branch has uncommitted edits' };
  if (await mergeInProgress(ctx.worktree))
    return { ok: false, error: 'a merge is in progress: finish it (`git commit --no-edit`) before pushing' };
  const url = await remoteUrl(ctx.worktree);
  const a = ctx.auth && url ? await ctx.auth(url) : { args: [], env: {} };
  const push = await git(ctx.worktree, [...a.args, 'push', '-u', 'origin', '--', ctx.branchName], {
    env: a.env,
  });
  if (push.exitCode !== 0)
    return { ok: false, error: `git push failed: ${(push.stderr || push.stdout).trim().slice(0, 500)}` };
  return { ok: true, message: `Pushed ${ctx.branchName} to origin.` };
}

/** `aom git fetch`: fetches origin (every branch) so `origin/<main>` and `origin/<working>` can be compared. */
export async function architectFetch(ctx: ArchitectGitContext): Promise<GitReply> {
  if (!(await hasRemote(ctx.worktree))) return { ok: false, error: 'the repository has no origin remote' };
  const url = await remoteUrl(ctx.worktree);
  const a = ctx.auth && url ? await ctx.auth(url) : { args: [], env: {} };
  const f = await git(ctx.worktree, [...a.args, 'fetch', '--prune', 'origin'], { env: a.env });
  if (f.exitCode !== 0)
    return { ok: false, error: `git fetch failed: ${(f.stderr || f.stdout).trim().slice(0, 500)}` };
  return { ok: true, message: 'Fetched origin. Compare with origin/<main> and origin/<working branch>.' };
}

/**
 * `aom git merge-main`: fetches and merges the latest `origin/<main>` into the card branch (`--no-ff`). A conflict is
 * left in the worktree for the architect to resolve; the SHA of main is recorded for the post-shift guard.
 */
export async function architectMergeMain(ctx: ArchitectGitContext): Promise<GitReply> {
  if (await mergeInProgress(ctx.worktree))
    return { ok: false, error: 'a merge is already in progress: resolve it first' };
  const dirty = (await git(ctx.worktree, ['status', '--porcelain', '--untracked-files=no'])).stdout.trim();
  if (dirty) return { ok: false, error: 'commit your changes first; the branch has uncommitted edits' };
  if (ctx.auth && (await hasRemote(ctx.worktree))) {
    const a = await ctx.auth(await remoteUrl(ctx.worktree));
    const main = ctx.mainBranch;
    if (main && isSafeGitRef(main))
      await git(ctx.worktree, [...a.args, 'fetch', 'origin', main], { env: a.env });
  }
  const r = await mergeMainIntoCard(ctx.worktree, {
    ...(ctx.mainBranch ? { mainBranch: ctx.mainBranch } : {}),
    ref: ctx.ref,
    ...(ctx.auth ? { auth: ctx.auth } : {}),
  });
  if ('error' in r) return { ok: false, error: r.error };
  ctx.recordMainSha(r.main);
  if (r.result === 'up_to_date')
    return { ok: true, message: 'The card branch already contains the latest main.' };
  if (r.result === 'merged_into_card')
    return { ok: true, message: `Merged the latest main into the card branch (${r.commit.slice(0, 10)}).` };
  return {
    ok: true,
    message: `The merge conflicts in: ${r.files.join(', ')}. Resolve the files (keep both sides' intent, no behaviour change), \`git add\` them, run \`git commit --no-edit\` and then \`aom git verify-merge\`.`,
  };
}

/**
 * `aom git verify-merge`: a conflict resolution is done when no merge is in progress, nothing is unmerged or uncommitted,
 * no conflict marker is left in a tracked file, and HEAD is a merge commit that has the recorded main commit as parent.
 */
export async function architectVerifyMerge(ctx: ArchitectGitContext): Promise<GitReply> {
  if (await mergeInProgress(ctx.worktree))
    return { ok: false, error: 'the merge is still in progress: `git commit --no-edit` finishes it' };
  const unmerged = (await git(ctx.worktree, ['diff', '--name-only', '--diff-filter=U'])).stdout
    .split('\n')
    .filter(Boolean);
  if (unmerged.length) return { ok: false, error: `unmerged files: ${unmerged.join(', ')}` };
  const dirty = (await git(ctx.worktree, ['status', '--porcelain', '--untracked-files=no'])).stdout.trim();
  if (dirty) return { ok: false, error: `uncommitted changes remain:\n${dirty.slice(0, 400)}` };
  const markers = await git(ctx.worktree, ['grep', '-I', '-n', '-E', '^(<{7}|>{7}) ', 'HEAD', '--']);
  if (markers.exitCode === 0 && markers.stdout.trim())
    return {
      ok: false,
      error: `conflict markers are still in the files:\n${markers.stdout.trim().slice(0, 400)}`,
    };
  const parents = (await git(ctx.worktree, ['rev-list', '--parents', '-n', '1', 'HEAD'])).stdout
    .trim()
    .split(' ')
    .slice(1);
  const main = ctx.startMainSha?.();
  if (parents.length < 2)
    return { ok: false, error: 'HEAD is not a merge commit: finish the merge with `git commit --no-edit`' };
  if (main && !parents.includes(main) && !(await isAncestor(ctx.worktree, main, 'HEAD')))
    return { ok: false, error: 'the merge does not contain the main commit the runner recorded' };
  return { ok: true, message: 'The merge of the main branch is complete.' };
}

async function isAncestor(cwd: string, a: string, b: string): Promise<boolean> {
  return (await git(cwd, ['merge-base', '--is-ancestor', a, b])).exitCode === 0;
}
