import { accessSync, constants, lstatSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, sep } from 'node:path';
import { writableByOthers } from '../policy/startup.ts';

/**
 * runner-bare-bin: the one resolver for a configured runtime binary (`runtimes.claude-code.bin`, codex, gemini, opencode).
 *
 * - An absolute name is checked as given.
 * - A non-absolute name with a slash is refused (it would resolve against whatever the cwd is).
 * - A bare name is searched execvp-style along `pathVar`, first hit wins; empty and relative PATH entries are skipped.
 * - The first hit must be a regular file the runner may execute (owner decision 3: a non-executable first match is refused,
 *   never skipped for a later one).
 * - Then `real = realpath(hit)` is checked again (R2, R3):
 *   - R2: neither `hit`, `real` nor their folders lie under a forbidden root (folders a box or an agent can write);
 *   - R3: `hit`, `real` and every parent folder of both, up to `/`, are writable only by `uid` or root, so nobody else can
 *     swap anything between this check and the exec (the same trust as editing `config.json`).
 *
 * Every failure is a reason, never a throw; the caller fails closed.
 */
export type BinLookup = { ok: true; path: string; real: string } | { ok: false; reason: string };

export interface BinLookupOptions {
  /** R2: roots a box or an agent can write (the runner data root, the toolchains, the agent tmp roots, the system tmp). */
  forbiddenRoots?: readonly string[];
  /** R3: the runner's uid (`geteuid()`); null skips the owner check (Windows). */
  uid: number | null;
}

const under = (p: string, root: string): boolean => {
  const r = root.endsWith(sep) && root.length > 1 ? root.slice(0, -1) : root;
  return p === r || p.startsWith(`${r}${sep}`);
};

const realOr = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** The file and every folder above it, up to `/`. */
function chain(p: string): string[] {
  const out = [p];
  let d = dirname(p);
  for (;;) {
    out.push(d);
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return out;
}

/** R3 for one path: the first entry (the file or a parent) another user could write or owns, or null. */
function foreignWritable(p: string, uid: number | null): string | null {
  for (const q of chain(p)) if (writableByOthers(q, uid)) return q;
  return null;
}

/** Is `p` a regular file the runner may execute? */
function executableFile(p: string): 'ok' | 'missing' | 'not_file' | 'not_executable' {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(p);
  } catch {
    return 'missing';
  }
  if (!st.isFile()) return 'not_file';
  try {
    accessSync(p, constants.X_OK);
  } catch {
    return 'not_executable';
  }
  return 'ok';
}

/** Resolves a configured binary name (see the module comment). */
export function lookupBin(name: string, pathVar: string, o: BinLookupOptions): BinLookup {
  if (!name || /[\0\n]/.test(name))
    return { ok: false, reason: 'the configured binary name is empty or invalid' };
  let hit: string | undefined;
  if (isAbsolute(name)) hit = name;
  else if (name.includes('/') || name.includes(sep))
    return {
      ok: false,
      reason: `"${name}" is a relative path: give an absolute path or a bare name`,
    };
  else {
    const dirs = pathVar.split(delimiter).filter((d) => d && isAbsolute(d));
    for (const d of dirs) {
      const p = `${d.endsWith(sep) ? d.slice(0, -1) : d}${sep}${name}`;
      try {
        lstatSync(p);
      } catch {
        continue;
      }
      hit = p;
      break;
    }
    if (!hit)
      return {
        ok: false,
        reason: `"${name}" was not found on the runner's PATH (${dirs.join(delimiter) || 'empty'})`,
      };
  }
  const kind = executableFile(hit);
  if (kind === 'missing') return { ok: false, reason: `${hit} does not exist (or is a broken link)` };
  if (kind === 'not_file') return { ok: false, reason: `${hit} is not a regular file` };
  if (kind === 'not_executable')
    return {
      ok: false,
      reason: `${hit} is not executable (the first match on the PATH is used, never a later one)`,
    };
  let real: string;
  try {
    real = realpathSync(hit);
  } catch {
    return { ok: false, reason: `${hit} cannot be resolved to its real path` };
  }
  if (executableFile(real) !== 'ok')
    return { ok: false, reason: `${real} is not an executable regular file` };
  // R2: never a binary a box or an agent could have put there
  const roots = (o.forbiddenRoots ?? []).filter((r) => r && isAbsolute(r));
  const forbidden = [...new Set([...roots, ...roots.map(realOr)])];
  for (const p of [hit, real])
    for (const r of forbidden)
      if (under(p, r) || under(dirname(p), r))
        return {
          ok: false,
          reason: `${p} lies under ${r}, a folder agents or boxes can write: install the runtime elsewhere`,
        };
  // R3: only this user or root can change the file or any folder above it (link included)
  if (o.uid !== null) {
    try {
      const l = lstatSync(hit);
      if (l.uid !== o.uid && l.uid !== 0) return { ok: false, reason: `${hit} belongs to another user` };
    } catch {
      return { ok: false, reason: `${hit} vanished while it was checked` };
    }
  }
  for (const p of [hit, real]) {
    const bad = foreignWritable(p, o.uid);
    if (bad)
      return {
        ok: false,
        reason: `${bad} is writable by group or others, or belongs to another user, so ${p} could be swapped: fix its permissions (for example an npm prefix under ~/.local)`,
      };
  }
  return { ok: true, path: hit, real };
}
