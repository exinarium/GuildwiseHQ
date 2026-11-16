import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isSafeGitRef, maskSecrets, REPO_SYNC_REASON_MESSAGE_MAX, type RepoSyncReason } from '@aom/shared';
import { displayDir, maskHomeIn } from '../home-path.ts';
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
 * Every result that leaves the branch unchanged carries a `reason` code and a `reasonMessage`; `updated` never does.
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
  /** Why the branch was left unchanged (absent only when it was updated). */
  reason?: RepoSyncReason;
  /** Short human-readable reason: secrets masked, the home folder as `~`, at most 400 characters. */
  reasonMessage?: string;
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
  /** The home folder masked as `~` in messages (default: the user's home). */
  home?: string;
}

/** Text that may leave the machine: secrets masked, the home folder as `~`, cut to what the protocol accepts. */
export function safeSyncText(s: string, home: string = homedir()): string {
  return maskHomeIn(maskSecrets(s), home).slice(0, REPO_SYNC_REASON_MESSAGE_MAX);
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
  const home = input.home ?? homedir();
  const safe = (s: string) => safeSyncText(s, home);
  const base: SyncResult = {
    state: 'error',
    ahead: 0,
    behind: 0,
    dirty: false,
    onBranch: false,
    checkedOutBranch: null,
  };
  /** A result before ahead/behind is known; the branch is left unchanged, so it always has a reason. */
  const early = (
    from: SyncResult,
    state: SyncState,
    reason: RepoSyncReason,
    message: string,
    detail?: string,
  ): SyncResult => ({
    ...from,
    state,
    ...(detail ? { detail: safe(detail) } : {}),
    reason,
    reasonMessage: safe(message),
  });
  if (!isSafeGitRef(wb))
    return early(
      base,
      'error',
      'unsafe-branch',
      `the working branch name ${JSON.stringify(wb)} is not a safe git branch name; nothing was changed`,
      `unsafe branch name ${JSON.stringify(wb)}`,
    );
  if (!existsSync(repoPath) || (await git(repoPath, ['rev-parse', '--git-dir'])).exitCode !== 0) {
    const shown = displayDir(real(repoPath), real(home));
    return early(base, 'error', 'no-clone', `no git clone at ${shown}`, `no git clone at ${shown}`);
  }
  const cur = await currentBranch(repoPath);
  const onBranch = cur === wb;
  const withCheckout = { ...base, checkedOutBranch: cur, onBranch };
  if (!(await hasRemote(repoPath)))
    return early(
      withCheckout,
      'no_remote',
      'no-remote',
      'the clone has no origin remote, so there is nothing to sync from',
    );

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
  if (!remote)
    return fetchError
      ? early(
          withCheckout,
          'error',
          'fetch-failed',
          `could not fetch ${wb} from origin: ${fetchError.replace(/^git fetch failed: /, '')}`,
          fetchError,
        )
      : early(
          withCheckout,
          'error',
          'origin-missing-branch',
          `origin has no branch ${wb}`,
          `origin has no branch ${wb}`,
        );
  if (!local)
    return early(
      withCheckout,
      'missing_branch',
      'no-local-branch',
      `there is no local branch ${wb}; shifts start from origin, so nothing was changed${fetchError ? `; the fetch also failed: ${fetchError.replace(/^git fetch failed: /, '')}` : ''}`,
      fetchError,
    );

  const counts = await git(repoPath, ['rev-list', '--left-right', '--count', `${local}...${remote}`]);
  const [aheadN, behindN] = counts.stdout.trim().split(/\s+/).map(Number);
  let ahead = aheadN ?? 0;
  let behind = behindN ?? 0;
  const dirty = (await changedFiles(repoPath)).length > 0;
  /** Every result from here on; `why` is required for anything but `updated`. */
  const out = (
    state: SyncState,
    detail?: string,
    why?: { reason: RepoSyncReason; message: string },
  ): SyncResult => {
    const d = detail ?? fetchError;
    return {
      state,
      ahead,
      behind,
      dirty,
      onBranch,
      checkedOutBranch: cur,
      ...(d ? { detail: safe(d) } : {}),
      ...(why ? { reason: why.reason, reasonMessage: safe(why.message) } : {}),
    };
  };
  const fetchNote = fetchError ? `; ${fetchError}` : '';

  if (behind === 0) {
    if (ahead > 0)
      return out('ahead', undefined, {
        reason: fetchError ? 'fetch-failed' : 'local-ahead',
        message: `${wb} has ${ahead} commit(s) origin does not have; a sync never pushes${fetchNote}`,
      });
    return out('synced', undefined, {
      reason: fetchError ? 'fetch-failed' : 'up-to-date',
      message: fetchError
        ? `${wb} could not be checked against origin${fetchNote}`
        : `${wb} is already up to date with origin`,
    });
  }
  if (ahead > 0) {
    const d = `${wb} has ${ahead} commit(s) origin does not have`;
    return out('diverged', d, {
      reason: 'diverged',
      message: `${wb} has ${ahead} local commit(s) and ${behind} new on origin; it is never forced, so it was left alone`,
    });
  }
  // Strictly behind: a fast-forward is possible.
  if (input.readOnly)
    return out(onBranch && dirty ? 'dirty' : 'behind', undefined, {
      reason: 'read-only',
      message: `measured only; nothing was changed (${behind} commit(s) behind origin)`,
    });
  const wts = await worktrees(repoPath);
  const mine = new Set(wts.map((w) => real(w.path)));
  const busy = (input.busyWorktrees ?? []).map(real).filter((p) => mine.has(p));
  if (busy.length > 0) {
    const d = `${busy.length} card shift(s) are running in this repository`;
    return out('busy', d, { reason: 'shift-running', message: `${d}; it catches up after they end` });
  }

  if (onBranch) {
    // Local changes (untracked files, a moved submodule pointer, edits to other files) do not block a fast-forward:
    // git itself refuses, and changes nothing, when an incoming commit would overwrite one of them.
    const m = await git(repoPath, ['merge', '--ff-only', remote]);
    if (m.exitCode !== 0) {
      const why = `${m.stderr}\n${m.stdout}`;
      const files = [...why.matchAll(/^\s+(\S.*)$/gm)].map((x) => x[1]?.trim()).filter(Boolean) as string[];
      if (dirty && /would be overwritten|untracked working tree files/i.test(why)) {
        const d = `uncommitted changes would be overwritten${files.length ? `: ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` and ${files.length - 5} more` : ''}` : ''}; commit, stash or discard them, then sync again`;
        return out('dirty', d, { reason: 'local-changes', message: d });
      }
      const d = first(m.stderr) || first(m.stdout) || 'fast-forward failed';
      return out('behind', d, { reason: 'fast-forward-failed', message: `fast-forward failed: ${d}` });
    }
  } else {
    const other = wts.find((w) => w.branch === wb);
    if (other)
      return out('behind', `${wb} is checked out in another worktree; it is left alone`, {
        reason: 'checked-out-elsewhere',
        message:
          `${wb} is checked out in another worktree (${displayDir(real(other.path), real(home))}); it was left alone. ` +
          'Update it there, or remove that worktree, then sync again',
      });
    // Only when the tip is still the one measured above: a ref that moved meanwhile is not ours to overwrite.
    const u = await git(repoPath, [
      'update-ref',
      '-m',
      `sync ${wb} to origin`,
      `refs/heads/${wb}`,
      remote,
      local,
    ]);
    if (u.exitCode !== 0) {
      const d = first(u.stderr) || 'could not move the branch';
      return out('behind', d, {
        reason: 'ref-update-failed',
        message: `${wb} moved while it was being synced, or could not be updated: ${d}; it was left alone`,
      });
    }
  }
  behind = 0;
  ahead = 0;
  return out('updated');
}
