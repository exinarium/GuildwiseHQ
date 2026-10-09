import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { STACKS } from './stacks.ts';
import type { Detection, Platform, RepoView } from './types.ts';

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'bin',
  'obj',
  'dist',
  'build',
  'target',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  '.gradle',
  '.idea',
  '.vs',
  'Pods',
]);
const MAX_FILES = 6000;
const MAX_DEPTH = 3;
const MAX_READ = 256 * 1024;

/** The repository's files to depth 3 (relative, `/`-separated), build and dependency folders skipped. */
export function scanRepoFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(e.name)) walk(join(dir, e.name), r, depth + 1);
      } else if (e.isFile()) out.push(r);
    }
  };
  walk(root, '', 0);
  return out.sort();
}

/** A `RepoView` over a directory on disk. */
export function viewOf(root: string, platform: Platform = process.platform as Platform): RepoView {
  return {
    files: scanRepoFiles(root),
    platform,
    read(rel) {
      try {
        const p = join(root, rel);
        if (statSync(p).size > MAX_READ * 8) return null;
        return readFileSync(p, 'utf8').slice(0, MAX_READ);
      } catch {
        return null;
      }
    },
  };
}

/** The stacks a repository uses, most specific first (a MAUI project is not also reported as plain .NET). */
export function detectStacks(repo: RepoView): Detection[] {
  const found = STACKS.map((s) => s.detect(repo)).filter((d): d is Detection => d !== null);
  return found.some((d) => d.id === 'dotnet-maui') ? found.filter((d) => d.id !== 'dotnet') : found;
}
