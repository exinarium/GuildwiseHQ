import { readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

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
