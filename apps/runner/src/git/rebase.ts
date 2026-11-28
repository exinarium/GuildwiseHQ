import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CommitAs, RebaseErrorInfo } from '@aom/shared';
import { isSafeGitRef, REBASE_ERROR_STDERR_MAX } from '@aom/shared';
import { restoreTrackedSandboxStubs, withWorktreeHeld } from '../adapters/sandbox-placeholders.ts';
import { redactSecrets } from '../secrets/redact.ts';
import { recordCardConflict } from './conflict-record.ts';
import {
  GitError,
  type GitResult,
  git,
  hasCommit,
  hasRemote,
  moveBranchAt,
  originAuth,
  originTip,
  type RemoteAuth,
  revParse,
} from './git.ts';
import { type BoundPostAs, committerEnv, requireCommitIdentity } from './identity.ts';
import { knowClone, latestTip, recordTip } from './pushable-tips.ts';

/**
 * Rebasing rewrites commits, which needs a committer; the author of each commit is kept. The committer is the resolved
 * commit identity (project setting, repository, workstation; see identity.ts); with none set this throws
 * `NoCommitIdentityError`, there is no fallback to a product name.
 */
export async function rebaseEnv(
  worktree: string,
  commitAs?: CommitAs | null,
  postAs?: BoundPostAs | null,
): Promise<Record<string, string>> {
  return committerEnv(await requireCommitIdentity(worktree, commitAs, postAs));
}

/** A merge commit needs an author too: the same identity as the committer of a rebase. */
const authorEnv = (env: Record<string, string>) => ({
  GIT_AUTHOR_NAME: env.GIT_COMMITTER_NAME as string,
  GIT_AUTHOR_EMAIL: env.GIT_COMMITTER_EMAIL as string,
});

/** The rebase stopped on conflicting paths; always carries at least one file (an empty list is not a conflict). */
export class RebaseConflictError extends Error {
  constructor(readonly conflictedFiles: string[]) {
    if (conflictedFiles.length === 0)
      throw new Error('a rebase conflict needs at least one conflicting file');
    super(`rebase conflict in ${conflictedFiles.join(', ')}`);
  }
}

/**
 * The rebase (or the merge that replaces it) failed without conflicting paths: a held `index.lock`, a read-only git dir,
 * an untracked file in the way, a missing base ref, a broken repository. Carries what the owner needs to fix it.
 */
export class RebaseError extends Error {
  constructor(readonly info: RebaseErrorInfo) {
    super(
      `rebase onto ${info.baseRef} failed: ${info.command} exited ${info.exitCode}: ${info.stderr || '(no output)'}`,
    );
  }
}

/** Git's message for a report: stderr (stdout when empty), secrets redacted, cut to the protocol's length. */
export function gitMessage(r: Pick<GitResult, 'stderr' | 'stdout'>): string {
  const text = redactSecrets((r.stderr || r.stdout).trim());
  return text.length > REBASE_ERROR_STDERR_MAX ? `${text.slice(0, REBASE_ERROR_STDERR_MAX - 3)}...` : text;
}

function rebaseError(baseRef: string, args: string[], r: GitResult, extra = ''): RebaseError {
  const message = gitMessage(r);
  const stderr = extra ? `${message}${message ? '; ' : ''}${extra}` : message;
  return new RebaseError({
    baseRef,
    command: `git ${args.join(' ')}`.slice(0, 500),
    exitCode: r.exitCode,
    stderr: stderr.length > REBASE_ERROR_STDERR_MAX ? stderr.slice(-REBASE_ERROR_STDERR_MAX) : stderr,
  });
}

const gitPathExists = async (worktree: string, name: string): Promise<boolean> => {
  const r = await git(worktree, ['rev-parse', '--git-path', name]);
  if (r.exitCode !== 0 || !r.stdout.trim()) return false;
  return existsSync(resolve(worktree, r.stdout.trim()));
};

const rebaseInProgress = async (worktree: string): Promise<boolean> =>
  (await gitPathExists(worktree, 'rebase-merge')) || (await gitPathExists(worktree, 'rebase-apply'));

const mergeInProgress = async (worktree: string): Promise<boolean> =>
  (await git(worktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).exitCode === 0;

/**
 * Aborts a rebase or merge only when one is in progress (git may have refused before starting, e.g. on `index.lock`),
 * and checks that it is gone. Returns what went wrong, or '' when the worktree is back on its original head. Never
 * resets, cleans, stashes or checks out: untracked files in the worktree stay exactly as they are.
 */
export async function abortInProgress(worktree: string): Promise<string> {
  const problems: string[] = [];
  if (await rebaseInProgress(worktree)) {
    const a = await git(worktree, ['rebase', '--abort']);
    if (a.exitCode !== 0) problems.push(`git rebase --abort failed: ${gitMessage(a)}`);
    if (await rebaseInProgress(worktree)) problems.push('a rebase is still in progress in the card worktree');
  }
  if (await mergeInProgress(worktree)) {
    const a = await git(worktree, ['merge', '--abort']);
    if (a.exitCode !== 0) problems.push(`git merge --abort failed: ${gitMessage(a)}`);
    if (await mergeInProgress(worktree)) problems.push('a merge is still in progress in the card worktree');
  }
  return problems.join('; ');
}

const unmergedPaths = async (worktree: string): Promise<string[]> => {
  const r = await git(worktree, ['diff', '--name-only', '--diff-filter=U']);
  return r.exitCode === 0 ? r.stdout.split('\n').filter(Boolean) : [];
};

/**
 * After a failed rebase or merge: the conflicting files (if git stopped on any), then abort what is in progress. A
 * conflict throws `RebaseConflictError` with the files; anything else throws `RebaseError` with git's message.
 */
async function failRebase(worktree: string, target: string, args: string[], r: GitResult): Promise<never> {
  const files = await unmergedPaths(worktree);
  const abortProblem = await abortInProgress(worktree);
  if (files.length && !abortProblem) throw new RebaseConflictError(files);
  throw rebaseError(
    target,
    args,
    r,
    [files.length ? `conflicting files: ${files.join(', ')}` : '', abortProblem].filter(Boolean).join('; '),
  );
}

/** `origin/<base>` when the remote branch exists in this repo, else `<base>`. */
export async function baseTarget(worktree: string, baseBranch: string): Promise<string> {
  return (await revParse(worktree, `refs/remotes/origin/${baseBranch}`))
    ? `origin/${baseBranch}`
    : baseBranch;
}

/**
 * Runner-side rebase before test and finalize (docs/ARCHITECTURE.md section 13.6): `git fetch origin <base>`, then
 * `git rebase origin/<base>`. A branch that already contains the base is left alone (no rebase, head unchanged). On a
 * conflict the conflicted files are collected, the rebase is aborted (never leaves a half-done rebase behind) and
 * `RebaseConflictError` is thrown: the card becomes Rework. Any other git failure throws `RebaseError` (base ref,
 * command, exit code, git's message), also after aborting what was in progress: that is a workstation problem, not a
 * conflict. Untracked files in the worktree are never touched.
 */
/** {@link rebaseOntoBaseUnheld}, with the worktree registered as the runner's own work (REVIEW B1). */
export function rebaseOntoBase(
  worktree: string,
  ...rest: Parameters<typeof rebaseOntoBaseUnheld> extends [string, ...infer R] ? R : never
): Promise<'up_to_date' | 'rebased' | 'merged'> {
  return withWorktreeHeld(worktree, 'rebase', () => rebaseOntoBaseUnheld(worktree, ...rest));
}

async function rebaseOntoBaseUnheld(
  worktree: string,
  baseBranch: string,
  commitAs?: CommitAs | null,
  postAs?: BoundPostAs | null,
  /** The host's credentials for origin (the project's app when it posts as one); absent: git's own. */
  auth?: RemoteAuth,
): Promise<'up_to_date' | 'rebased' | 'merged'> {
  if (!isSafeGitRef(baseBranch)) throw new Error(`refusing unsafe base branch ${JSON.stringify(baseBranch)}`);
  // a committed placeholder the sandbox took away is an unstaged deletion git rebase refuses on (REVIEW S2)
  await restoreTrackedSandboxStubs(worktree).catch(() => []);
  // gate-fixes-2 Rule B: the base is origin's tip from ls-remote (fetched, then checked to be here), used as a sha; never
  // `origin/<base>` or `FETCH_HEAD`, which an agent session can change. Without a remote: the local base branch.
  let target = baseBranch;
  if (await hasRemote(worktree)) {
    const a = await originAuth(worktree, auth);
    if (a) await git(worktree, [...a.args, 'fetch', '--', 'origin', baseBranch], { env: a.env });
    const ruleB = await originTip(worktree, baseBranch, a ?? undefined).catch((err: unknown) => {
      throw new RebaseError({
        baseRef: `origin/${baseBranch}`,
        command: `git ls-remote origin refs/heads/${baseBranch}`,
        exitCode: err instanceof GitError ? err.result.exitCode : 128,
        stderr: err instanceof Error ? err.message.slice(0, REBASE_ERROR_STDERR_MAX) : String(err),
      });
    });
    if (ruleB && !(await hasCommit(worktree, ruleB)))
      throw new RebaseError({
        baseRef: `origin/${baseBranch}`,
        command: `git cat-file -e ${ruleB}`,
        exitCode: 128,
        stderr: `origin's ${baseBranch} (${ruleB}) is not in this clone after the fetch`,
      });
    if (ruleB) target = ruleB;
  }
  // what messages show: `origin/<base>` (its tip from ls-remote is what git ran with)
  const label = target === baseBranch ? baseBranch : `origin/${baseBranch}`;
  const shown = (args: string[]) => args.map((a) => (a === target ? label : a));
  if (!(await revParse(worktree, target)))
    throw new RebaseError({
      baseRef: target,
      command: `git rev-parse --verify ${target}`,
      exitCode: 128,
      stderr: `base ref ${target} not found`,
    });
  // Already contains the base (for example the builder merged it and resolved a conflict there): nothing to do. Exit 1
  // is "not an ancestor"; anything else is git failing (bad object, broken repository), which is not a reason to rebase.
  const ancestorArgs = ['merge-base', '--is-ancestor', target, 'HEAD'];
  const anc = await git(worktree, ancestorArgs);
  if (anc.exitCode === 0) return 'up_to_date';
  if (anc.exitCode !== 1) throw rebaseError(label, shown(ancestorArgs), anc);
  const renv = await rebaseEnv(worktree, commitAs, postAs);
  // T7: a conflict the runner saw itself is recorded with the head it had, for the later runner-run fast-forward
  const headBefore = (await git(worktree, ['rev-parse', 'HEAD'])).stdout.trim();
  // gate-fixes-2 B3: the move is detached at the head read here and compare-and-swap; the result is recorded only when
  // that head was the branch's latest record (a runner move never makes an untrusted tip trusted)
  const branch = (await git(worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
  if (!branch || !isSafeGitRef(branch))
    throw rebaseError(label, ['symbolic-ref', 'HEAD'], {
      stdout: '',
      stderr: 'the card worktree is not on a branch',
      exitCode: 128,
    });
  await knowClone(worktree);
  const trustedBefore = (await latestTip(worktree, `refs/heads/${branch}`))?.sha === headBefore;
  const moved = async (args: string[], how: 'rebased' | 'merged', env: Record<string, string>) => {
    let failure: unknown;
    const m = await moveBranchAt(
      worktree,
      branch,
      headBefore,
      () => git(worktree, args, { env }),
      // the conflicted files are read, then the rebase or merge is aborted (failRebase), then the branch re-attached
      async (r) => {
        failure = await failAndRecord(args, r).catch((e: unknown) => e);
      },
    );
    if (m.ok) {
      if (trustedBefore) await recordTip(worktree, `refs/heads/${branch}`, m.sha, how);
      return how;
    }
    if (failure) throw failure;
    throw rebaseError(label, shown(args), { stdout: '', stderr: m.reason, exitCode: 128 });
  };
  const failAndRecord = async (args: string[], res: Awaited<ReturnType<typeof git>>): Promise<never> => {
    try {
      return await failRebase(worktree, label, shown(args), res);
    } catch (err) {
      if (err instanceof RebaseConflictError) await recordCardConflict(worktree, headBefore, branch);
      throw err;
    }
  };
  // A card branch with merge commits of its own is brought up to date with a merge: a plain rebase would drop those
  // merges and replay the card's commits, hitting the conflicts their resolution already settled.
  const mergeBase = (await git(worktree, ['merge-base', target, 'HEAD'])).stdout.trim();
  const merges = mergeBase
    ? (await git(worktree, ['rev-list', '--merges', '--count', `${mergeBase}..HEAD`])).stdout.trim()
    : '0';
  if (merges !== '' && merges !== '0')
    return moved(['merge', '--no-edit', '--', target], 'merged', { ...renv, ...authorEnv(renv) });
  return moved(['rebase', target], 'rebased', renv);
}
