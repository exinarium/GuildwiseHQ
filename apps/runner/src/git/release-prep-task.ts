import { existsSync } from 'node:fs';
import {
  type CommitAs,
  filesOutsideWritable,
  missingNewVideoFiles,
  type ReleasePrepShift,
} from '@aom/shared';
import { git } from './git.ts';
import { commitEnv, requireCommitIdentity } from './identity.ts';
import { withRepoLock } from './repo-lock.ts';

/**
 * A release prep task shift (GWP-92 5.4): a detached worktree from the run's work ref, a check at the end that the agent
 * changed only the files of its task, and a local commit of them on the work ref. Nothing is pushed.
 */

export interface PrepTaskWorktree {
  path: string;
  repoPath: string;
  /** The commit the worktree started from. */
  base: string;
}

const revParse = async (repoPath: string, ref: string): Promise<string | null> => {
  const r = await git(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return r.exitCode === 0 ? r.stdout.trim() : null;
};

/** Adds the worktree under the repository lock (the work ref, else the analysed head). */
export async function addPrepTaskWorktree(
  repoPath: string,
  rp: ReleasePrepShift,
  path: string,
): Promise<PrepTaskWorktree> {
  return withRepoLock(repoPath, async () => {
    const base = (await revParse(repoPath, rp.workRef)) ?? (await revParse(repoPath, rp.startSha));
    if (!base) throw new Error(`the release work ${rp.startSha.slice(0, 12)} is not in the clone`);
    if (existsSync(path)) await git(repoPath, ['worktree', 'remove', '--force', path]);
    await git(repoPath, ['worktree', 'prune']);
    const add = await git(repoPath, ['worktree', 'add', '--detach', path, base]);
    if (add.exitCode !== 0) throw new Error(`could not add a worktree: ${(add.stderr || add.stdout).trim()}`);
    return { path, repoPath, base };
  });
}

export async function removePrepTaskWorktree(wt: PrepTaskWorktree): Promise<void> {
  await withRepoLock(wt.repoPath, async () => {
    await git(wt.repoPath, ['worktree', 'remove', '--force', wt.path]);
    await git(wt.repoPath, ['worktree', 'prune']);
  }).catch(() => undefined);
}

/** The files the shift changed: committed by the agent since the start, and left in the worktree. */
export async function changedFiles(wt: PrepTaskWorktree): Promise<string[]> {
  const committed = (await git(wt.path, ['diff', '--name-only', '-z', wt.base, 'HEAD'])).stdout.split('\0');
  const left = (await git(wt.path, ['status', '--porcelain', '-z', '--untracked-files=all'])).stdout
    .split('\0')
    .filter(Boolean)
    .map((l) => l.slice(3));
  return [...new Set([...committed, ...left].filter(Boolean))].sort();
}

export type PrepTaskFinish = { ok: true; commit: string; files: string[] } | { ok: false; reason: string };

/**
 * At `aom prep done`: refuses any file outside the writable list and a task without its required files, else commits
 * the changed files on top of the start as one local commit and moves the work ref to it (under the lock).
 */
export async function finishPrepTask(
  wt: PrepTaskWorktree,
  rp: ReleasePrepShift,
  commitAs: CommitAs | null | undefined,
): Promise<PrepTaskFinish> {
  const files = await changedFiles(wt);
  const outside = filesOutsideWritable(files, rp.writable);
  if (outside.length > 0)
    return { ok: false, reason: `changed files outside the task: ${outside.slice(0, 20).join(', ')}` };
  const missing = rp.task.kind === 'new_video' ? missingNewVideoFiles(rp.task, files) : [];
  if (missing.length > 0) return { ok: false, reason: `missing ${missing.join(', ')}` };
  let identity: Awaited<ReturnType<typeof requireCommitIdentity>>;
  try {
    identity = await requireCommitIdentity(wt.repoPath, commitAs ?? undefined);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  return withRepoLock(wt.repoPath, async (): Promise<PrepTaskFinish> => {
    // The agent's own commits are folded into one: reset to the start, keep the files, commit once.
    const reset = await git(wt.path, ['reset', '--soft', wt.base]);
    if (reset.exitCode !== 0) return { ok: false, reason: `git reset failed: ${reset.stderr.trim()}` };
    const add = await git(wt.path, ['add', '-A', '--', ...files]);
    if (add.exitCode !== 0)
      return { ok: false, reason: `git add failed: ${(add.stderr || add.stdout).trim()}` };
    const label = rp.task.kind === 'new_video' ? `the ${rp.task.slug} video script` : rp.task.kind;
    const commit = await git(wt.path, ['commit', '-m', `docs(release): ${label}`], {
      env: commitEnv(identity),
    });
    if (commit.exitCode !== 0)
      return { ok: false, reason: `git commit failed: ${(commit.stderr || commit.stdout).trim()}` };
    const sha = (await git(wt.path, ['rev-parse', 'HEAD'])).stdout.trim();
    // The work ref moves only if nobody else moved it since this worktree started from it.
    const now = await revParse(wt.repoPath, rp.workRef);
    if (now && now !== wt.base)
      return { ok: false, reason: 'the release work moved while the script was written' };
    const upd = await git(wt.repoPath, ['update-ref', rp.workRef, sha]);
    if (upd.exitCode !== 0) return { ok: false, reason: `could not keep the work: ${upd.stderr.trim()}` };
    return { ok: true, commit: sha, files };
  });
}
