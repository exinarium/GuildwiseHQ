import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Own clones only [rv6-3]: the runner works in clones it owns under its HOME, never in the person's folders. The person
 * gets the work through git: the runner pushes branches to the remote (the default), or, where they opt in, a read-only
 * `git fetch` from the runner's clone (git >= 2.45.1, an exact `safe.directory`, never `*`) [rv7-13].
 */

/** The dedicated user's clones live in `~guildwise-runner/src`; with the current user, in a folder of their own. */
export function clonesDir(home: string, mode: 'dedicated' | 'current'): string {
  return mode === 'dedicated' ? join(home, 'src') : join(home, 'guildwise-runner', 'src');
}

/**
 * Creates the clones folder (0700) or tightens an existing one: never group- or other-writable, never setgid. Group
 * read stays only where `guildwise-admin readers add` granted it. Refuses a symlink.
 */
export function ensureClonesDir(dir: string): number {
  const st = lstatSync(dir, { throwIfNoEntry: false });
  if (st?.isSymbolicLink())
    throw new Error(`${dir} is a symlink: the runner's clones folder must be a real folder`);
  if (st && !st.isDirectory()) throw new Error(`${dir} exists and is not a folder`);
  if (!st) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const cur = lstatSync(dir).mode & 0o7777;
  const mode = cur & 0o750 & ~0o2000;
  chmodSync(dir, mode | 0o700);
  return mode | 0o700;
}

export const MIN_FETCH_GIT = '2.45.1';

function parts(v: string): number[] {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : [];
}

/** Is the `git --version` text at least `min`? Unparseable text is not. */
export function gitVersionAtLeast(text: string, min: string = MIN_FETCH_GIT): boolean {
  const v = parts(text);
  const m = parts(min);
  if (v.length === 0) return false;
  for (let i = 0; i < 3; i++) {
    if ((v[i] ?? 0) > (m[i] ?? 0)) return true;
    if ((v[i] ?? 0) < (m[i] ?? 0)) return false;
  }
  return true;
}

/** The person's `safe.directory` entry for one clone: the exact absolute path, never a wildcard. */
export function safeDirectoryCommand(repoPath: string): string {
  if (!repoPath.startsWith('/') || repoPath.includes('*') || /\s|'/.test(repoPath))
    throw new Error(`safe.directory needs an exact absolute path without wildcards: ${repoPath}`);
  return `git config --global --add safe.directory ${repoPath}`;
}
