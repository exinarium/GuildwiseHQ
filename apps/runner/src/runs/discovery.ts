import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

const MAX_BYTES = 60 * 1024;

/** A file named `name` (any case) directly in `dir`, or null. */
function findCaseInsensitive(dir: string, name: string): string | null {
  try {
    const hit = readdirSync(dir).find((f) => f.toLowerCase() === name.toLowerCase());
    if (!hit) return null;
    const p = join(dir, hit);
    return statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

/**
 * `BUILD.md` of a repository's run worktree: first in the project folder (`projectPath`, subfolder projects), then at
 * the repository root, case-insensitively. The runner finds it so the DevOps engineer never has to search.
 */
export function findBuildDoc(
  worktree: string,
  projectPath?: string,
): { path: string; content: string } | null {
  const dirs = [...(projectPath ? [join(worktree, projectPath)] : []), worktree];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const p = findCaseInsensitive(dir, 'BUILD.md');
    if (!p) continue;
    try {
      const text = readFileSync(p, 'utf8');
      return {
        path: p.slice(worktree.length).replace(/^[\\/]/, '') || 'BUILD.md',
        content: text.length > MAX_BYTES ? `${text.slice(0, MAX_BYTES)}\n... (cut)` : text,
      };
    } catch {
      return null;
    }
  }
  return null;
}

/** Hash of the BUILD.md files a plan was made from (part of the plan's fingerprint on the server). */
export function buildHash(docs: Array<{ repoId: string; content: string }>): string {
  const h = createHash('sha256');
  for (const d of [...docs].sort((a, b) => (a.repoId < b.repoId ? -1 : 1)))
    h.update(`${d.repoId}\n${d.content}\n`);
  return h.digest('hex');
}

// ------------------------------------------------------------------------------------ guides above the repositories

/** A build guide outside the run worktree (the runner reads it and passes the text on). `path` is absolute. */
export interface ExtraGuide {
  path: string;
  content: string;
  origin: 'parent' | 'configured' | 'readme';
  repoIds: string[];
}

const README_NAMES = ['README.md', 'README', 'README.txt', 'README.rst', 'README.markdown'];

function readCut(p: string): string | null {
  try {
    const text = readFileSync(p, 'utf8');
    return text.length > MAX_BYTES ? `${text.slice(0, MAX_BYTES)}\n... (cut)` : text;
  } catch {
    return null;
  }
}

const realOr = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const isInside = (p: string, dir: string): boolean =>
  p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/**
 * The folders above a clone that may hold a guide, nearest first: the clone's parent up to and including the runner's
 * `repoRoots` entry that contains the clone (the organization source folder sits inside one). Never the home directory
 * or anything above it, and nothing at all when the clone is not under a repo root.
 */
export function guideFolders(clonePath: string, repoRoots: readonly string[], home: string): string[] {
  const clone = realOr(clonePath);
  const homeReal = realOr(home);
  const root = repoRoots
    .map(realOr)
    .filter((r) => isInside(clone, r) && clone !== r)
    .sort((a, b) => b.length - a.length)[0];
  if (!root) return [];
  const out: string[] = [];
  for (let d = dirname(clone); ; d = dirname(d)) {
    if (isInside(homeReal, d)) break; // the home directory itself, or something above it
    out.push(d);
    if (d === root || dirname(d) === d) break;
  }
  return out;
}

export interface GuideSource {
  repoId: string;
  /** The user's clone (its parent folders are searched). */
  clonePath: string | undefined;
  /** The run worktree. */
  worktree: string;
  projectPath?: string | undefined;
}

/**
 * Guides that live outside the run worktrees: the project's "Build guide" setting when set (it replaces all discovery,
 * the repository's own BUILD.md included, and the caller then ignores the in-repo ones); else every BUILD.md in the
 * folders above the clones, nearest first and deduplicated; README files only when no BUILD.md exists anywhere (also
 * in the repositories: `repoHasBuildDoc`).
 */
export function discoverExtraGuides(o: {
  sources: GuideSource[];
  configured: readonly string[];
  repoRoots: readonly string[];
  home: string;
  repoHasBuildDoc: boolean;
}): ExtraGuide[] {
  const allRepos = o.sources.map((s) => s.repoId);
  if (o.configured.length > 0) {
    const out: ExtraGuide[] = [];
    for (const p of o.configured) {
      const content = readCut(p);
      if (content === null || out.some((g) => g.path === p)) continue;
      out.push({ path: p, content, origin: 'configured', repoIds: allRepos });
    }
    return out;
  }
  const collect = (names: string[], origin: 'parent' | 'readme', extraDirs: (s: GuideSource) => string[]) => {
    const found = new Map<string, ExtraGuide>();
    for (const s of o.sources) {
      const dirs = [...extraDirs(s), ...(s.clonePath ? guideFolders(s.clonePath, o.repoRoots, o.home) : [])];
      for (const dir of dirs) {
        for (const name of names) {
          const p = findCaseInsensitive(dir, name);
          if (!p) continue;
          const key = realOr(p);
          const hit = found.get(key);
          if (hit) {
            if (!hit.repoIds.includes(s.repoId)) hit.repoIds.push(s.repoId);
          } else {
            const content = readCut(p);
            if (content !== null) found.set(key, { path: p, content, origin, repoIds: [s.repoId] });
          }
          break; // one guide per folder
        }
      }
    }
    return [...found.values()];
  };
  const parents = collect(['BUILD.md'], 'parent', () => []);
  if (parents.length > 0 || o.repoHasBuildDoc) return parents;
  // No BUILD.md anywhere: the README of the project folder, the repository root and the folders above.
  return collect(README_NAMES, 'readme', (s) => [
    ...(s.projectPath ? [join(s.worktree, s.projectPath)] : []),
    s.worktree,
  ]);
}

/**
 * Hash of the guides a plan was made from (part of the plan's fingerprint on the server): the repositories' BUILD.md
 * files and the guides outside them (the parent folders' or the configured ones, never a README fallback). With no
 * outside guide the value is the same as before guides above the repositories were read.
 */
export function guidesHash(
  docs: Array<{ repoId: string; content: string }>,
  extra: Array<Pick<ExtraGuide, 'path' | 'content' | 'origin'>> = [],
): string {
  const h = createHash('sha256');
  for (const d of [...docs].sort((a, b) => (a.repoId < b.repoId ? -1 : 1)))
    h.update(`${d.repoId}\n${d.content}\n`);
  for (const g of [...extra].filter((x) => x.origin !== 'readme').sort((a, b) => (a.path < b.path ? -1 : 1)))
    h.update(`guide\n${g.path}\n${createHash('sha256').update(g.content).digest('hex')}\n`);
  return h.digest('hex');
}
