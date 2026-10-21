import { type Dirent, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';

/**
 * Read-only folders (reference repositories, the project's own clones in a chat, a role-wide source folder) and the
 * secrets that stay unreadable even inside them. One list drives both layers:
 * - the built-in tools get `Read(...)` deny rules (gitignore globs, see `secretReadDenies`);
 * - the OS sandbox gets path lists only (no globs), and an `allowRead` re-opens a path inside a `denyRead`
 *   region, so a secret in an allowed folder cannot simply be added to `denyRead`. Instead the folder is opened
 *   entry by entry, leaving the secret files out (`sandboxReadEntries`).
 */

/** File names (single `*` wildcard) that are never readable, in any read-only folder. */
export const SECRET_FILE_GLOBS = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
  '.npmrc',
  '.netrc',
  '.pypirc',
  '.git-credentials',
];

const SECRET_RES = SECRET_FILE_GLOBS.map(
  (g) => new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`),
);

export const isSecretFileName = (name: string): boolean => SECRET_RES.some((r) => r.test(name));

/** `Read(//abs/dir/**\/.env)`-style deny rules for the built-in tools (they also cover Grep and Glob). */
export function secretReadDenies(dirs: string[]): string[] {
  return dirs.flatMap((d) => SECRET_FILE_GLOBS.map((g) => `Read(/${resolve(d)}/**/${g})`));
}

/** Directories that are not scanned for secrets (large, generated, or the repository's own metadata); opened whole. */
const OPAQUE_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', 'build', 'target', '.next']);

/** The scan reads at most this many directory entries per folder; beyond it the folder is not opened to the shell at all. */
export const SCAN_LIMIT = 40_000;

interface Scan {
  count: number;
}

/**
 * The paths to hand the sandbox's `allowRead` so that `dir` is readable except for its secret files: the folder
 * itself when it has none, else each safe entry on its own (recursing into sub folders that hold some).
 * Returns null when the folder is too large to check (fail closed: the shell then reads none of it; the built-in
 * Read, Grep and Glob tools still can, minus the deny rules above).
 */
export function sandboxReadEntries(dir: string): string[] | null {
  const root = resolve(dir);
  if (basename(root) === '.git') return [root]; // repository metadata: not scanned (its objects are huge)
  const scan: Scan = { count: 0 };
  const out = walk(root, scan);
  return out === 'overflow' ? null : out.entries;
}

/** `clean`: nothing secret below (the caller may allow the folder as a whole). */
function walk(dir: string, scan: Scan): 'overflow' | { entries: string[]; clean: boolean } {
  let names: Array<{ name: string; isDir: boolean }>;
  try {
    names = readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    return { entries: [], clean: true }; // unreadable folder: nothing to open
  }
  scan.count += names.length;
  if (scan.count > SCAN_LIMIT) return 'overflow';
  const parts: Array<{ path: string; clean: boolean; entries?: string[] }> = [];
  let clean = true;
  for (const e of names) {
    const path = join(dir, e.name);
    if (e.isDir) {
      if (OPAQUE_DIRS.has(e.name)) {
        parts.push({ path, clean: true });
        continue;
      }
      const sub = walk(path, scan);
      if (sub === 'overflow') return 'overflow';
      parts.push({ path, clean: sub.clean, entries: sub.entries });
      if (!sub.clean) clean = false;
    } else if (isSecretFileName(e.name)) {
      clean = false; // left out
    } else {
      parts.push({ path, clean: true });
    }
  }
  if (clean) return { entries: [dir], clean: true };
  return { entries: parts.flatMap((p) => (p.clean ? [p.path] : (p.entries ?? []))), clean: false };
}

/** More secret file names a scan masks (on top of `SECRET_FILE_GLOBS`): any `*.env` (`secret.env`, `prod.env`), Terraform variables, .pgpass. */
const SCAN_EXTRA_SECRET_GLOBS = ['*.env', '*.tfvars', '.pgpass', '.htpasswd'];
const SCAN_SECRET_RES = SCAN_EXTRA_SECRET_GLOBS.map(
  (g) => new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`),
);
export const isScanSecretFileName = (name: string): boolean =>
  isSecretFileName(name) || SCAN_SECRET_RES.some((r) => r.test(name));

/** Dependency folders: huge, rarely hold a secret. Searched with a budget of their own; over it the whole folder is hidden. */
const DEPENDENCY_DIRS = new Set(['node_modules', '.venv', 'venv', 'target']);
const DEP_BUDGET = 60_000;
/** Entries looked at in one clone before the clone is not opened to the shell at all. */
export const SCAN_TOTAL_LIMIT = 400_000;

export interface ScanMasks {
  /** Secret files to mask with `/dev/null`, wherever they are, `build/` and `dist/` included. */
  files: string[];
  /** Folders to hide entirely: a dependency folder too big to search. */
  dirs: string[];
}

/**
 * What a scan must not read inside one read-only clone: every secret file at any depth (a bounded walk that does not follow
 * links; it looks inside the opaque folders `build/`, `dist/`, `.next/` too, which `sandboxReadEntries` leaves whole).
 * Returns null when the clone is too large to check: the caller then does not open it at all.
 */
export function scanMasksFor(dir: string): ScanMasks | null {
  const root = resolve(dir);
  const out: ScanMasks = { files: [], dirs: [] };
  let total = 0;
  /** 'ok'; 'total' = the clone is too big; 'dep' = the dependency folder being searched is over its budget. */
  const walkDir = (d: string, dep: { left: number } | null): 'ok' | 'total' | 'dep' => {
    let entries: Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return 'ok';
    }
    total += entries.length;
    if (dep) dep.left -= entries.length;
    if (total > SCAN_TOTAL_LIMIT) return 'total';
    if (dep && dep.left < 0) return 'dep';
    for (const e of entries) {
      const path = join(d, e.name);
      if (e.isDirectory()) {
        if (!dep && DEPENDENCY_DIRS.has(e.name)) {
          const mark = out.files.length;
          const r = walkDir(path, { left: DEP_BUDGET });
          if (r === 'total') return 'total';
          if (r === 'dep') {
            out.files.length = mark; // the whole folder goes instead
            out.dirs.push(path);
          }
        } else {
          const r = walkDir(path, dep);
          if (r !== 'ok') return r;
        }
      } else if (isScanSecretFileName(e.name)) {
        if (e.isSymbolicLink()) {
          // a link is never masked itself (the mask would land on its target); a target inside the clone is
          try {
            const target = realpathSync(path);
            if (target.startsWith(`${root}${sep}`) && statSync(target).isFile()) out.files.push(target);
          } catch {}
        } else out.files.push(path);
      }
    }
    return 'ok';
  };
  if (walkDir(root, null) !== 'ok') return null;
  return { files: [...new Set(out.files)], dirs: out.dirs };
}

/**
 * The paths to open (read-only) for a scan of one clone: every top-level entry, and of `.git` every entry EXCEPT its
 * `config` (a remote URL may carry a token, a credential helper a command). Git works without that file. Secret files
 * deeper down are masked by `scanMasksFor`, which beats this list. A linked worktree (`.git` is a file) is opened whole.
 */
const isLink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

export function scanCloneEntries(dir: string): string[] {
  const root = resolve(dir);
  const list = (d: string): string[] => {
    try {
      return readdirSync(d);
    } catch {
      return [];
    }
  };
  return list(root).flatMap((name) => {
    const p = join(root, name);
    // a link is not opened as an entry: bubblewrap would bind its TARGET at that path (a link to a secret outside)
    if (isLink(p)) return [];
    if (name !== '.git') return [p];
    try {
      if (!statSync(p).isDirectory()) return [p];
    } catch {
      return [];
    }
    return list(p)
      .filter((n) => n !== 'config' && n !== 'config.worktree')
      .map((n) => join(p, n))
      .filter((f) => !isLink(f));
  });
}
