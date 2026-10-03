import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { RepoReport } from '@aom/shared';
import { currentBranch, git } from './git.ts';

const SKIP = new Set(['node_modules', '.git', 'dist', '.venv', 'vendor']);

async function isRepo(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, '.git'))).isDirectory();
  } catch {
    return false;
  }
}

async function walk(dir: string, depth: number, out: string[]): Promise<void> {
  if (await isRepo(dir)) {
    out.push(dir);
    return;
  }
  if (depth >= 3) return;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith('.')) continue;
    await walk(join(dir, e.name), depth + 1, out);
  }
}

/** Scans each root to depth 3 for `.git` directories; reports repos that have an `origin` remote. */
export async function scanRepos(roots: string[]): Promise<RepoReport[]> {
  const found = new Set<string>();
  for (const root of roots) {
    const dirs: string[] = [];
    await walk(resolve(root), 0, dirs);
    for (const d of dirs) found.add(d);
  }
  const reports: RepoReport[] = [];
  for (const localPath of [...found].sort()) {
    const r = await git(localPath, ['remote', 'get-url', 'origin']);
    if (r.exitCode !== 0 || !r.stdout.trim()) continue;
    reports.push({ remoteUrl: r.stdout.trim(), localPath, headBranch: await currentBranch(localPath) });
  }
  return reports;
}
