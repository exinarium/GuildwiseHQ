import { mkdirSync, rmSync, statSync } from 'node:fs';

/**
 * A cross-process lock for the owner's login file (the runner may run twice, e.g. an update overlapping, and the owner's own
 * CLI may refresh at the same time). `mkdir` is atomic; a lock older than `staleMs` is broken. Best effort: after
 * `waitMs` the critical section runs anyway, because a login copy must never block a shift for long.
 */
export async function withFileLock<T>(
  lockDir: string,
  fn: () => T | Promise<T>,
  opts: { staleMs?: number; waitMs?: number; pollMs?: number } = {},
): Promise<T> {
  const staleMs = opts.staleMs ?? 10_000;
  const waitMs = opts.waitMs ?? 5_000;
  const pollMs = opts.pollMs ?? 25;
  const deadline = Date.now() + waitMs;
  let held = false;
  for (;;) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      held = true;
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') break; // unwritable folder: go without
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > staleMs) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // released between the two calls
      }
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  try {
    return await fn();
  } finally {
    if (held) rmSync(lockDir, { recursive: true, force: true });
  }
}
