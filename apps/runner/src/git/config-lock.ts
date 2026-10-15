import { lstatSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Claude Code's sandbox protects `<gitDir>/config` and, with it, `config.lock` and `config.worktree.lock`: bubblewrap
 * mounts over each name and creates a missing one on the HOST as an empty, read-only file (verified in the claude 2.1.300
 * binary: it lists hooks, config, config.lock, config.worktree, config.worktree.lock and commondir, and the stub stays
 * behind after the sandbox ends). A `config.lock` stub makes EVERY git operation that writes `.git/config` in that clone
 * fail with "could not lock config file .git/config: File exists" (branch tracking set-up on `worktree add`, `push -u`,
 * `git config`, the owner's own `git branch -u`...).
 *
 * Two defences, both here:
 *  - `holdSandboxRepo` counts the sandboxed shifts per clone and removes the stubs when the last one ends, so no
 *    `config.lock` is left on the host while no agent runs there;
 *  - `clearLockStub` is the recovery for a stub that is found anyway (a crashed runner, an agent still running): it removes
 *    a lock ONLY when it is certainly a stub (a regular file, 0 bytes, no write permission). A real lock of a concurrent
 *    git (the runner's own included) is created writable, so it is never touched.
 *
 * Residual window: while an agent shift runs on a clone, the stub may reappear (a new sandbox re-creates it) and the
 * owner's own `git config` in that clone can hit it; the runner removes it before its own writes (see `git()`) and at the
 * end of the last shift.
 */
export const SANDBOX_LOCK_NAMES = ['config.lock', 'config.worktree.lock'] as const;

/** A regular, empty, read-only file: what bwrap leaves behind. Anything else may be a real git's lock. */
export function isLockStub(path: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isFile() && st.size === 0 && (st.mode & 0o222) === 0;
  } catch {
    return false;
  }
}

/** Removes the sandbox lock stubs of one git dir. Returns the names removed. Never removes a non-stub. */
export function clearLockStub(gitDir: string, names: readonly string[] = SANDBOX_LOCK_NAMES): string[] {
  const removed: string[] = [];
  for (const n of names) {
    const p = join(gitDir, n);
    if (!isLockStub(p)) continue;
    try {
      unlinkSync(p);
      removed.push(n);
    } catch {}
  }
  return removed;
}

const holders = new Map<string, number>();

/** A sandboxed shift starts on a clone (its shared git dirs); the returned function ends it and cleans up after the last one. */
export function holdSandboxRepo(gitDirs: readonly string[]): () => void {
  const dirs = [...new Set(gitDirs.map((d) => resolve(d)))];
  for (const d of dirs) holders.set(d, (holders.get(d) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const d of dirs) {
      const n = (holders.get(d) ?? 1) - 1;
      if (n > 0) holders.set(d, n);
      else {
        holders.delete(d);
        clearLockStub(d);
      }
    }
  };
}

/** Number of sandboxed shifts holding the git dir (tests). */
export function sandboxHolders(gitDir: string): number {
  return holders.get(resolve(gitDir)) ?? 0;
}
