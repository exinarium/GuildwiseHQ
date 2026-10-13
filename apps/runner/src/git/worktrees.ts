import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { ForgeKind, WorktreeSpec } from '@aom/shared';
import { isSafeGitRef } from '@aom/shared';
import { confineAny } from '../fs-safe.ts';
import {
  ambiguousMainMessage,
  branchNames,
  currentBranch,
  git,
  gitOk,
  hasRemote,
  resolveDefaultBranch,
  revParse,
} from './git.ts';
import { withRepoLock } from './repo-lock.ts';

export class WorktreeError extends Error {}

/**
 * The working branch the server named does not exist in the clone. Carries what the manager needs to fix it: the
 * repository's default branch (when the clone knows it) and the branches there are.
 */
export class BaseBranchMissingError extends WorktreeError {
  constructor(
    readonly base: string,
    readonly defaultBranch: string | null,
    readonly branches: string[],
    /** Why the runner could not create the branch from the default branch (set when it tried). */
    readonly createFailed?: string,
  ) {
    super(
      `working branch '${base}' does not exist in this repo${defaultBranch ? `; its default branch is '${defaultBranch}'` : ''}${createFailed ? `; creating it failed: ${createFailed}` : ''}`,
    );
  }
}

export interface WorktreeResult {
  path: string;
  branchName: string;
  baseBranch: string;
  created: boolean;
  headSha: string;
  /** Set when the working branch did not exist and was created (and pushed) from the repository's default branch. */
  createdBranch?: { base: string; from: string; pushed: boolean; mainBranchSet: boolean };
}

export interface EnsureWorktreeInput {
  repoPath: string;
  spec: WorktreeSpec;
  /** Default location `<dataDir>/worktrees/<KEY>-<project>/<REF>`; `spec.path` wins for `reuse`. */
  defaultPath: string;
  /**
   * Directories a worktree may live in (the runner's `worktrees/`; `integration/` for merges). Every path is
   * confined to them, whatever the server sent; nothing outside is created or deleted.
   */
  roots: string[];
  /** Credentials for pushing a working branch this creates (absent: the user's own git setup is used). */
  auth?: GitAuth;
}

/** Credentials for git against the repository's host (clone, push). */
export type GitAuth = (
  url: string,
  forge?: ForgeKind,
) => Promise<{ args: string[]; env: Record<string, string> }>;

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
  // Worktree add, branch create and the config writes behind them are serialized per clone (two shifts starting at once
  // collided on .git/config.lock).
  return withRepoLock(input.repoPath, () => ensureWorktreeLocked(input));
}

async function ensureWorktreeLocked(input: EnsureWorktreeInput): Promise<WorktreeResult> {
  const { repoPath, spec } = input;
  const branch = spec.branchName;
  const base = spec.baseBranch;

  const fail = (m: string): never => {
    throw new WorktreeError(m);
  };
  // Refs come from the server (owner-controlled): never let one parse as an option or escape ref syntax.
  if (!isSafeGitRef(branch)) fail(`refusing unsafe branch name ${JSON.stringify(branch)}`);
  if (!isSafeGitRef(base)) fail(`refusing unsafe base branch ${JSON.stringify(base)}`);
  let path: string;
  try {
    path = confineAny(input.roots, spec.mode === 'reuse' && spec.path ? spec.path : input.defaultPath);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

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
    const r = await git(repoPath, ['worktree', 'add', '--', path, branch]);
    if (r.exitCode !== 0) fail(`git worktree add ${branch} failed: ${r.stderr.trim()}`);
    return result(false);
  }

  // A card branch that is gone locally: a copy on origin comes back as it was. Without one (hygiene removed the branch
  // of a finished card that was reopened, or the clone lost it) the branch is recreated from the working branch below.
  if (
    (await hasRemote(repoPath)) &&
    (await git(repoPath, ['fetch', '--', 'origin', branch])).exitCode === 0
  ) {
    if (await revParse(repoPath, `refs/remotes/origin/${branch}`)) {
      const r = await git(repoPath, ['worktree', 'add', '-b', branch, '--', path, `origin/${branch}`]);
      if (r.exitCode !== 0) fail(`git worktree add -b ${branch} failed: ${r.stderr.trim()}`);
      return result(false);
    }
  }

  let startPoint = base;
  if (await hasRemote(repoPath)) {
    const f = await git(repoPath, ['fetch', '--', 'origin', base]);
    if (f.exitCode === 0 || (await revParse(repoPath, `refs/remotes/origin/${base}`))) {
      if (await revParse(repoPath, `refs/remotes/origin/${base}`)) startPoint = `origin/${base}`;
    }
  }
  let createdBranch: WorktreeResult['createdBranch'];
  if (!(await revParse(repoPath, startPoint))) {
    // The working branch exists neither locally nor on origin: create it from the default branch and push it.
    const made = await createWorkingBranch(repoPath, base, { mainBranch: spec.mainBranch, auth: input.auth });
    if (!made.ok && made.refusal) throw new WorktreeError(made.refusal);
    if (!made.ok) throw new BaseBranchMissingError(base, made.defaultBranch, made.branches, made.error);
    createdBranch = made.created;
    startPoint = base;
  }
  const r = await git(repoPath, ['worktree', 'add', '-b', branch, '--', path, startPoint]);
  if (r.exitCode !== 0) fail(`git worktree add -b ${branch} failed: ${r.stderr.trim()}`);
  return { ...(await result(true)), ...(createdBranch ? { createdBranch } : {}) };
}

/**
 * Creates the missing working branch `base` from the project's main branch (`opts.mainBranch`; absent: the repository's
 * default branch: `origin/HEAD`, else the only branch, else main/master) and, when there is an origin, pushes it with
 * upstream. When the main branch cannot be told, does not exist, or the push is refused it returns `ok: false` with a
 * message that says which and leaves nothing behind; the caller then asks the manager.
 */
export async function createWorkingBranch(
  repoPath: string,
  base: string,
  opts: { mainBranch?: string; auth?: GitAuth } = {},
): Promise<
  | { ok: true; created: NonNullable<WorktreeResult['createdBranch']> }
  | { ok: false; defaultBranch: string | null; branches: string[]; error?: string; refusal?: string }
> {
  return withRepoLock(repoPath, () => createWorkingBranchLocked(repoPath, base, opts));
}

async function createWorkingBranchLocked(
  repoPath: string,
  base: string,
  opts: { mainBranch?: string; auth?: GitAuth },
): ReturnType<typeof createWorkingBranch> {
  const branches = await branchNames(repoPath);
  let def = opts.mainBranch;
  if (!def) {
    // Unset: ask the remote what its default is (the clone's origin/HEAD goes stale); never guess between candidates.
    const found = await resolveDefaultBranch(repoPath, {
      branches,
      ...(opts.auth ? { auth: (url: string) => (opts.auth as GitAuth)(url) } : {}),
    });
    if (!found.branch && found.ambiguous.length > 1)
      return {
        ok: false,
        defaultBranch: null,
        branches,
        refusal: ambiguousMainMessage(basename(repoPath), found.ambiguous),
      };
    def = found.branch ?? undefined;
  }
  if (!def || !isSafeGitRef(def)) return { ok: false, defaultBranch: null, branches };
  const failed = (error: string) => ({ ok: false as const, defaultBranch: def, branches, error });
  const remote = await hasRemote(repoPath);
  if (remote) await git(repoPath, ['fetch', '--', 'origin', def]);
  const from = (await revParse(repoPath, `refs/remotes/origin/${def}`)) ? `origin/${def}` : def;
  if (!(await revParse(repoPath, from)))
    return failed(
      opts.mainBranch
        ? `the main branch '${def}' does not exist in this repository, so '${base}' cannot be created from it`
        : `the default branch '${def}' has no commits`,
    );
  const b = await git(repoPath, ['branch', '--no-track', '--', base, from]);
  if (b.exitCode !== 0) return failed(`git branch failed: ${b.stderr.trim()}`);
  if (remote) {
    const url = (await git(repoPath, ['remote', 'get-url', 'origin'])).stdout.trim();
    const a = opts.auth && url ? await opts.auth(url) : { args: [], env: {} };
    const push = await git(repoPath, [...a.args, 'push', '-u', 'origin', `${base}:${base}`], { env: a.env });
    if (push.exitCode !== 0) {
      await git(repoPath, ['branch', '-D', '--', base]);
      return failed(
        `could not push the new branch '${base}' to origin (${(push.stderr || push.stdout).trim().slice(0, 300)}). Check that this workstation may push to the repository, or create '${base}' by hand and try again`,
      );
    }
  }
  return {
    ok: true,
    created: { base, from: def, pushed: remote, mainBranchSet: opts.mainBranch !== undefined },
  };
}

/** `worktree.remove` command: idempotent. Deletes the branch only when asked. */
export async function removeWorktree(input: {
  path: string;
  branchName?: string;
  deleteBranch?: boolean;
  /** See `EnsureWorktreeInput.roots`; a path outside them is refused, never deleted. */
  roots: string[];
}): Promise<{ removed: boolean; branchDeleted: boolean }> {
  const path = confineAny(input.roots, input.path);
  const repoOf = async (): Promise<string | null> => {
    if (!existsSync(path)) return null;
    const r = await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (r.exitCode !== 0) return null;
    const common = r.stdout.trim();
    return /[\\/]\.git$/.test(common) ? common.slice(0, -5) : common;
  };
  const clone = await repoOf();
  // Serialized with the other changes to that clone (worktree add, branch create).
  return clone
    ? withRepoLock(clone, () => removeWorktreeLocked(input, path))
    : removeWorktreeLocked(input, path);
}

async function removeWorktreeLocked(
  input: { branchName?: string; deleteBranch?: boolean },
  path: string,
): Promise<{ removed: boolean; branchDeleted: boolean }> {
  if (input.branchName !== undefined && !isSafeGitRef(input.branchName))
    throw new WorktreeError(`refusing unsafe branch name ${JSON.stringify(input.branchName)}`);
  let repo: string | null = null;
  if (existsSync(path)) {
    const r = await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (r.exitCode === 0) {
      const common = r.stdout.trim();
      repo = /[\\/]\.git$/.test(common) ? common.slice(0, -5) : common;
    }
  }
  let removed = false;
  if (existsSync(path)) {
    if (repo) await git(repo, ['worktree', 'remove', '--force', '--', path]);
    if (existsSync(path)) await rm(path, { recursive: true, force: true });
    removed = true;
  }
  let branchDeleted = false;
  if (repo) {
    await git(repo, ['worktree', 'prune']);
    if (input.deleteBranch && input.branchName) {
      branchDeleted = (await git(repo, ['branch', '-D', '--', input.branchName])).exitCode === 0;
    }
  }
  return { removed, branchDeleted };
}

export { RebaseConflictError, rebaseOntoBase } from './rebase.ts';
