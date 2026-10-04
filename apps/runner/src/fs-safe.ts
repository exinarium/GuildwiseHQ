import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

export class PathConfinementError extends Error {}

/** `realpath` of the deepest ancestor that exists, with the not-yet-existing tail appended (symlinks resolved). */
export function realpathLoose(p: string): string {
  const abs = resolve(p);
  const tail: string[] = [];
  let cur = abs;
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) break;
    tail.unshift(basename(cur));
    cur = up;
  }
  const real = existsSync(cur) ? realpathSync(cur) : cur;
  return tail.length ? join(real, ...tail) : real;
}

/**
 * Returns `target` (resolved) when it lies strictly inside `root`, after following symlinks on both sides; otherwise
 * throws. Server-supplied paths (worktree locations, vault folders) go through this before anything is created or
 * deleted, so a manipulated value can never point `rm -rf` outside the runner's own directories.
 */
export function confine(root: string, target: string): string {
  const resolved = resolve(target);
  const realRoot = realpathLoose(root);
  const realTarget = realpathLoose(resolved);
  const inside = (r: string, t: string) => t.startsWith(r.endsWith(sep) ? r : r + sep) && t !== r;
  if (!inside(resolve(root), resolved) || !inside(realRoot, realTarget))
    throw new PathConfinementError(`path ${target} is outside ${root}`);
  return resolved;
}

/** Like `confine` against several allowed roots (any one suffices). */
export function confineAny(roots: string[], target: string): string {
  for (const r of roots) {
    try {
      return confine(r, target);
    } catch (err) {
      if (!(err instanceof PathConfinementError)) throw err;
    }
  }
  throw new PathConfinementError(`path ${target} is outside the runner's worktree directories`);
}
