import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { WorktreeSpec } from '@aom/shared';
import { currentBranch, git, gitOk, hasRemote, revParse } from './git.ts';

export class WorktreeError extends Error {}

export interface WorktreeResult {
  path: string;
  branchName: string;
  baseBranch: string;
  created: boolean;
  headSha: string;
}

export interface EnsureWorktreeInput {
  repoPath: string;
  spec: WorktreeSpec;
  /** Default location `<dataDir>/worktrees/<KEY>/<REF>`; `spec.path` wins for `reuse`. */
  defaultPath: string;
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await revParse(repo, `refs/heads/${branch}`)) !== null;
}

async function isWorktreeOn(path: string, branch: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  return (await currentBranch(path)) === branch;
}

/**
 * First claim (`create`): fetch origin/<base> (if there is an origin), then `worktree add -b <branch> <path> origin/<base>`.
 * Later stages (`reuse`): verify the path is on the branch, recreate from the branch if the directory vanished.
 * Both modes are idempotent so a rejected or crashed first shift can be retried. Throws `WorktreeError` otherwise.
 */
export async function ensureWorktree(input: EnsureWorktreeInput): Promise<WorktreeResult> {
  const { repoPath, spec } = input;
  const path = spec.mode === 'reuse' && spec.path ? spec.path : input.defaultPath;
  const branch = spec.branchName;
  const base = spec.baseBranch;

  const fail = (m: string): never => {
    throw new WorktreeError(m);
  };

  await git(repoPath, ['worktree', 'prune']);

  const result = async (created: boolean): Promise<WorktreeResult> => ({
    path,
    branchName: branch,
    baseBranch: base,
    created,
    headSha: await gitOk(path, ['rev-parse', 'HEAD']),
  });

  if (await isWorktreeOn(path, branch)) return result(false);

  if (existsSync(path)) {
    // Directory exists but is not a worktree on the branch: only clean up if it is not a registered worktree.
    const onOther = await currentBranch(path);
    if (onOther !== null || existsSync(`${path}/.git`)) {
      fail(`Path ${path} exists but is on branch ${onOther ?? '(detached)'}, expected ${branch}`);
    }
    await rm(path, { recursive: true, force: true });
  }
  await mkdir(dirname(path), { recursive: true });

  if (await branchExists(repoPath, branch)) {
    const r = await git(repoPath, ['worktree', 'add', path, branch]);
    if (r.exitCode !== 0) fail(`git worktree add ${branch} failed: ${r.stderr.trim()}`);
    return result(false);
  }

  if (spec.mode === 'reuse') fail(`Worktree ${path} and branch ${branch} are both missing`);

  let startPoint = base;
  if (await hasRemote(repoPath)) {
    const f = await git(repoPath, ['fetch', 'origin', base]);
    if (f.exitCode === 0 || (await revParse(repoPath, `refs/remotes/origin/${base}`))) {
      if (await revParse(repoPath, `refs/remotes/origin/${base}`)) startPoint = `origin/${base}`;
    }
  }
  if (!(await revParse(repoPath, startPoint))) fail(`Base branch ${base} not found in ${repoPath}`);
  const r = await git(repoPath, ['worktree', 'add', '-b', branch, path, startPoint]);
  if (r.exitCode !== 0) fail(`git worktree add -b ${branch} failed: ${r.stderr.trim()}`);
  return result(true);
}

/** `worktree.remove` command: idempotent. Deletes the branch only when asked. */
export async function removeWorktree(input: {
  path: string;
  branchName?: string;
  deleteBranch?: boolean;
}): Promise<{ removed: boolean; branchDeleted: boolean }> {
  let repo: string | null = null;
  if (existsSync(input.path)) {
    const r = await git(input.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (r.exitCode === 0) {
      const common = r.stdout.trim();
      repo = /[\\/]\.git$/.test(common) ? common.slice(0, -5) : common;
    }
  }
  let removed = false;
  if (existsSync(input.path)) {
    if (repo) await git(repo, ['worktree', 'remove', '--force', input.path]);
    if (existsSync(input.path)) await rm(input.path, { recursive: true, force: true });
    removed = true;
  }
  let branchDeleted = false;
  if (repo) {
    await git(repo, ['worktree', 'prune']);
    if (input.deleteBranch && input.branchName) {
      branchDeleted = (await git(repo, ['branch', '-D', input.branchName])).exitCode === 0;
    }
  }
  return { removed, branchDeleted };
}

export { RebaseConflictError, rebaseOntoBase } from './rebase.ts';
