import { existsSync, realpathSync } from 'node:fs';
import { isSafeGitRef } from '@aom/shared';
import { currentBranch, git, hasRemote, revParse } from './git.ts';
import { withRepoLock } from './repo-lock.ts';
import { changedFiles } from './sweep.ts';
import type { GitAuth } from './worktrees.ts';

/**
 * Keeps the local working branch from falling behind origin (backlog #57). Safe by construction:
 * - fetches `origin <wb>` only;
 * - the clone is on `wb` and clean: `merge --ff-only origin/wb`;
 * - `wb` is not checked out anywhere: moves the ref only when the local tip is an ancestor of origin's (`update-ref`
 *   with the expected old value, so a ref that moved meanwhile is left alone);
 * - diverged, dirty, checked out in another worktree, or a card shift works in this repository: nothing is changed and
 *   the state says why. Never forces, never touches uncommitted work.
 */
export type SyncState =
  | 'synced' // local and origin are the same
  | 'updated' // local was behind and has been moved forward now
  | 'behind' // behind origin and could not be moved (detail says why)
  | 'ahead' // has commits origin does not have
  | 'diverged'
  | 'dirty' // behind origin, but the checkout has uncommitted changes
  | 'busy' // behind origin, but a card shift works in this repository
  | 'no_remote'
  | 'missing_branch' // no local branch of that name (agents start from origin anyway)
  | 'error';

export interface SyncResult {
  state: SyncState;
  /** Local commits origin does not have. */
  ahead: number;
  /** Origin commits the local branch does not have (after the update, if one was made). */
  behind: number;
  /** The clone's own checkout has uncommitted changes. */
  dirty: boolean;
  /** The clone's own checkout is on the working branch. */
  onBranch: boolean;
  checkedOutBranch: string | null;
  detail?: string;
}

export interface SyncInput {
  repoPath: string;
  workingBranch: string;
  /** Worktrees (paths) that have a running card shift; one of this clone's worktrees among them defers the update. */
  busyWorktrees?: string[];
  /** Fetch first (default true); false when the caller has just fetched. */
  fetch?: boolean;
  /** Only measure, never move anything (default false). */
  readOnly?: boolean;
  auth?: GitAuth;
}

const first = (s: string) => s.trim().split('\n')[0]?.trim() ?? '';

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** Worktrees of the clone: the clone itself first, then the linked ones, with the branch each is on. */
async function worktrees(repoPath: string): Promise<Array<{ path: string; branch: string | null }>> {
  const r = await git(repoPath, ['worktree', 'list', '--porcelain']);
  return r.stdout
    .split(/\n\n+/)
    .map((b) => ({
      path: /^worktree (.+)$/m.exec(b)?.[1] ?? '',
      branch: /^branch refs\/heads\/(.+)$/m.exec(b)?.[1] ?? null,
    }))
    .filter((w) => w.path);
}

export function syncWorkingBranch(input: SyncInput): Promise<SyncResult> {
  return withRepoLock(input.repoPath, () => syncWorkingBranchUnlocked(input));
}

/** For callers that already hold the clone's lock (worktree creation). */
export async function syncWorkingBranchUnlocked(input: SyncInput): Promise<SyncResult> {
  const { repoPath, workingBranch: wb } = input;
  const base: SyncResult = {
    state: 'error',
    ahead: 0,
    behind: 0,
    dirty: false,
    onBranch: false,
    checkedOutBranch: null,
  };
  if (!isSafeGitRef(wb)) return { ...base, detail: `unsafe branch name ${JSON.stringify(wb)}` };
  if (!existsSync(repoPath) || (await git(repoPath, ['rev-parse', '--git-dir'])).exitCode !== 0)
    return { ...base, detail: `no git clone at ${repoPath}` };
  const cur = await currentBranch(repoPath);
  const onBranch = cur === wb;
  const withCheckout = { ...base, checkedOutBranch: cur, onBranch };
  if (!(await hasRemote(repoPath))) return { ...withCheckout, state: 'no_remote' };

  let fetchError: string | undefined;
  if (input.fetch !== false) {
    const url = (await git(repoPath, ['remote', 'get-url', 'origin'])).stdout.trim();
    const a = input.auth && url ? await input.auth(url) : { args: [] as string[], env: {} };
    const f = await git(repoPath, [...a.args, 'fetch', '--no-tags', 'origin', '--', wb], { env: a.env });
    if (f.exitCode !== 0)
      fetchError = `git fetch failed: ${first(f.stderr) || first(f.stdout) || 'git failed'}`;
  }
  const local = await revParse(repoPath, `refs/heads/${wb}`);
  const remote = await revParse(repoPath, `refs/remotes/origin/${wb}`);
  if (!remote) return { ...withCheckout, state: 'error', detail: fetchError ?? `origin has no branch ${wb}` };
  if (!local)
    return { ...withCheckout, state: 'missing_branch', ...(fetchError ? { detail: fetchError } : {}) };

  const counts = await git(repoPath, ['rev-list', '--left-right', '--count', `${local}...${remote}`]);
  const [aheadN, behindN] = counts.stdout.trim().split(/\s+/).map(Number);
  let ahead = aheadN ?? 0;
  let behind = behindN ?? 0;
  const dirty = (await changedFiles(repoPath)).length > 0;
  const out = (state: SyncState, detail?: string): SyncResult => ({
    state,
    ahead,
    behind,
    dirty,
    onBranch,
    checkedOutBranch: cur,
    ...((detail ?? fetchError) ? { detail: (detail ?? fetchError) as string } : {}),
  });

  if (behind === 0) return out(ahead > 0 ? 'ahead' : 'synced');
  if (ahead > 0) return out('diverged', `${wb} has ${ahead} commit(s) origin does not have`);
  // Strictly behind: a fast-forward is possible.
  if (input.readOnly) return out(onBranch && dirty ? 'dirty' : 'behind');
  const wts = await worktrees(repoPath);
  const mine = new Set(wts.map((w) => real(w.path)));
  const busy = (input.busyWorktrees ?? []).map(real).filter((p) => mine.has(p));
  if (busy.length > 0) return out('busy', `${busy.length} card shift(s) are running in this repository`);

  if (onBranch) {
    // Local changes (untracked files, a moved submodule pointer, edits to other files) do not block a fast-forward:
    // git itself refuses, and changes nothing, when an incoming commit would overwrite one of them.
    const m = await git(repoPath, ['merge', '--ff-only', remote]);
    if (m.exitCode !== 0) {
      const why = `${m.stderr}\n${m.stdout}`;
      const files = [...why.matchAll(/^\s+(\S.*)$/gm)].map((x) => x[1]?.trim()).filter(Boolean) as string[];
      if (dirty && /would be overwritten|untracked working tree files/i.test(why))
        return out(
          'dirty',
          `uncommitted changes would be overwritten${files.length ? `: ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` and ${files.length - 5} more` : ''}` : ''}; commit, stash or discard them, then sync again`,
        );
      return out('behind', first(m.stderr) || first(m.stdout) || 'fast-forward failed');
    }
  } else {
    if (wts.some((w) => w.branch === wb))
      return out('behind', `${wb} is checked out in another worktree; it is left alone`);
    // Only when the tip is still the one measured above: a ref that moved meanwhile is not ours to overwrite.
    const u = await git(repoPath, [
      'update-ref',
      '-m',
      `sync ${wb} to origin`,
      `refs/heads/${wb}`,
      remote,
      local,
    ]);
    if (u.exitCode !== 0) return out('behind', first(u.stderr) || 'could not move the branch');
  }
  behind = 0;
  ahead = 0;
  return out('updated');
}
