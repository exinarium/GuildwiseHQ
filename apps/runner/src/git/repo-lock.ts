import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve } from 'node:path';

const tails = new Map<string, Promise<unknown>>();
/** The clones the current async call chain already holds the lock of (a locked step may call another locked one). */
const held = new AsyncLocalStorage<Set<string>>();

/**
 * Runs `fn` while holding the runner's lock for one repository clone. Everything that changes a clone's shared state
 * goes through it: worktree add/remove, branch create/delete, config writes, fetches, the "merge latest main first"
 * step and a merge completion (which integrate through a throwaway worktree and push). Two shifts starting at once in
 * one clone would otherwise collide on `.git/config.lock`. Calls for the same clone run one after the other, in order;
 * other clones are unaffected; a call made while this chain already holds the lock runs straight away.
 */
export async function withRepoLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(repoPath);
  const mine = held.getStore();
  if (mine?.has(key)) return fn();
  const inner = () => held.run(new Set([...(mine ?? []), key]), fn);
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.then(inner, inner);
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
