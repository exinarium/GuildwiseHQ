import { resolve } from 'node:path';

const tails = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` while holding the runner's lock for one repository clone: the "merge latest main first" step and a merge
 * completion both integrate into the working branch through a throwaway worktree and push it, so they must not run at
 * the same time on one clone. Calls for the same clone run one after the other, in order; other clones are unaffected.
 */
export async function withRepoLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(repoPath);
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  try {
    return await run;
  } finally {
    if (tails.get(key) === tail) tails.delete(key);
  }
}
