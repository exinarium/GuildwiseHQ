import { readdir, stat } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import type { RepoIdentityFact, RepoReport } from '@aom/shared';
import { currentBranch, git } from './git.ts';
import { repoLevelIdentity } from './identity.ts';

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

export interface ScannedRepo {
  localPath: string;
  /** Path relative to the repoRoot it was found under (forward slashes): the stable identifier, never absolute. */
  localKey: string;
  remoteUrl: string | null;
  headBranch: string | null;
  /** The identity commits get here without a project setting (repository, global or system config); null: none set. */
  identity: RepoIdentityFact | null;
}

/**
 * Scans each root to depth 3 for `.git` directories; reports every repo, with or without an `origin` remote.
 * `exclude` drops folders that must never be offered (the runner's data dir, the user's credential folders).
 */
export async function scanAllRepos(
  roots: string[],
  exclude: (path: string) => boolean = () => false,
): Promise<ScannedRepo[]> {
  const found = new Map<string, string>(); // path -> key
  for (const root of roots) {
    const base = resolve(root);
    const dirs: string[] = [];
    await walk(base, 0, dirs);
    for (const d of dirs) {
      if (found.has(d) || exclude(d)) continue;
      found.set(d, relative(base, d).split(sep).join('/') || basename(base));
    }
  }
  const out: ScannedRepo[] = [];
  for (const localPath of [...found.keys()].sort()) {
    const r = await git(localPath, ['remote', 'get-url', 'origin']);
    out.push({
      localPath,
      localKey: found.get(localPath) as string,
      remoteUrl: r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : null,
      headBranch: await currentBranch(localPath),
      identity: await repoLevelIdentity(localPath),
    });
  }
  return out;
}

/** The repositories that have an `origin` remote (what projects match against). */
export function withRemote(all: ScannedRepo[]): RepoReport[] {
  return all.flatMap((r) =>
    r.remoteUrl
      ? [{ remoteUrl: r.remoteUrl, localPath: r.localPath, headBranch: r.headBranch, identity: r.identity }]
      : [],
  );
}

/** Scans each root to depth 3 for `.git` directories; reports repos that have an `origin` remote. */
export async function scanRepos(roots: string[]): Promise<RepoReport[]> {
  return withRemote(await scanAllRepos(roots));
}
