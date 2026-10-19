import { dirname } from 'node:path/posix';

/** Source containers whose sub folders are the modules (`src/billing`), not `src` itself. */
const SOURCE_CONTAINERS = new Set(['src', 'lib', 'app', 'pkg', 'internal', 'cmd', 'source', 'sources']);

export interface Manifest {
  path: string;
  kind: 'npm' | 'go' | 'dotnet' | 'python' | 'cargo';
  /** The package name (npm `name`, Go module path, .NET project file name, Python project name). */
  name?: string;
  /** Declared dependency names (production and development). */
  deps: string[];
  /** npm: the entry files the manifest names (`main`, `module`, `types`, `exports["."]`). */
  entries: string[];
}

/** The repo-relative directory of a manifest (`.` for the root). */
export const manifestDir = (m: Manifest): string => dirname(m.path);

/**
 * Which module a file belongs to: the nearest enclosing directory that holds a package manifest (not the repository root);
 * else the first folder, one level deeper for a source container (`src/billing`); else `.` (the root).
 */
export function moduleDirOf(path: string, manifestDirs: Set<string>): string {
  const parts = path.split('/');
  parts.pop();
  for (let i = parts.length; i >= 1; i--) {
    const d = parts.slice(0, i).join('/');
    if (manifestDirs.has(d)) return d;
  }
  if (parts.length === 0) return '.';
  const first = parts[0] as string;
  if (SOURCE_CONTAINERS.has(first.toLowerCase()) && parts.length >= 2) return `${first}/${parts[1]}`;
  return first;
}

/** A name safe to use as a file name in the vault, stable for the same module. */
export function moduleFileName(dir: string, hash: (s: string) => string): string {
  if (dir === '.') return '_root';
  const flat = dir.replace(/\//g, '__');
  if (/^[A-Za-z0-9._@-]+$/.test(flat) && !flat.startsWith('_')) return flat;
  return `${flat.replace(/[^A-Za-z0-9._@-]/g, '_').replace(/^_+/, '')}-${hash(dir).slice(0, 6)}`;
}
