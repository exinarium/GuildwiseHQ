import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import type { LocalReadRepo, ReadableFolder, ReadRepo } from '@aom/shared';
import { HOME_SECRETS, inside } from './adapters/claude-policy.ts';
import { scanAllRepos } from './git/repo-scan.ts';

export interface ResolvedReadRepo extends ReadableFolder {
  repoId: string;
}

export interface ReadRepoDeps {
  /** The runner's own clone of a repository by normalized remote (its repository scan); undefined: not on this workstation. */
  findRepo(remoteUrlNormalized: string): Promise<{ localPath: string } | undefined>;
  /** The runner's own clone by catalog key (path relative to its repoRoot): the repositories without a remote. */
  findLocal?(localKey: string): Promise<{ localPath: string } | undefined>;
  /** The runner data dir: never a read-only folder, nor inside one. */
  runnerRoot: string;
  realHome?: string;
}

/**
 * True for a folder that must never be opened (nor offered in the picker): the filesystem root, the runner's private
 * state (the data dir or a parent of it), the home directory itself or a parent of it, and the user's credential folders.
 */
export function forbiddenReadPath(path: string, runnerRoot: string, realHome?: string): boolean {
  const home = realHome ?? homedir();
  const secrets = HOME_SECRETS.map((s) => join(home, s));
  return (
    path === '/' ||
    inside(runnerRoot, path) || // the data dir itself or a parent of it
    inside(path, runnerRoot) ||
    inside(home, path) || // the home directory or a parent of it
    secrets.some((s) => inside(path, s) || inside(s, path))
  );
}

/** The real path of a folder that may be opened read-only, or undefined. */
function openable(localPath: string, deps: ReadRepoDeps): string | undefined {
  let path: string;
  try {
    path = realpathSync(localPath);
    if (!statSync(path).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  return forbiddenReadPath(path, deps.runnerRoot, deps.realHome) ? undefined : path;
}

/**
 * The server names repositories by remote (or, for a clone picked on a workstation, by catalog key); the runner opens
 * only the clones it found itself. A repository that is not cloned here is skipped (no error: the project's other
 * workstations may have it). A folder that holds the runner's private state or the user's credentials, or the home
 * directory itself, is never opened. Pure of side effects besides the filesystem lookups; paths are real paths,
 * de-duplicated.
 */
export async function resolveReadRepos(
  readRepos: ReadRepo[] | undefined,
  deps: ReadRepoDeps,
  localReadRepos?: LocalReadRepo[],
): Promise<ResolvedReadRepo[]> {
  const seen = new Set<string>();
  const out: ResolvedReadRepo[] = [];
  const add = (
    repoId: string,
    name: string,
    kind: ResolvedReadRepo['kind'],
    found: { localPath: string } | undefined,
  ) => {
    if (!found) return;
    const path = openable(found.localPath, deps);
    // a project repository that is also a reference repository is opened once, as the project's own
    if (!path || seen.has(path)) return;
    seen.add(path);
    out.push({ repoId, name, kind, path });
  };
  for (const r of readRepos ?? []) add(r.repoId, r.name, r.kind, await deps.findRepo(r.remoteUrlNormalized));
  // Clones the owner picked on a workstation: by catalog key on the workstation they were picked on (the server sends
  // `localKey` only there), else by remote on any workstation that has a clone of the same repository.
  for (const r of localReadRepos ?? []) {
    let found = r.localKey && deps.findLocal ? await deps.findLocal(r.localKey) : undefined;
    if (!found && r.remoteUrlNormalized) found = await deps.findRepo(r.remoteUrlNormalized);
    add(`local:${r.localKey ?? r.remoteUrlNormalized ?? r.name}`, r.name, 'reference', found);
  }
  return out;
}

// ------------------------------------------------------------------------- organization source folder

export type OrgFolderCheck = { ok: true; path: string } | { ok: false; error: string };

/**
 * Is `folder` acceptable as the organization source folder of this workstation? It must exist, sit strictly inside one
 * of the runner's `repoRoots` (not be a root itself), and never be (or contain) the home directory, the runner's data
 * dir or a credential folder. Real paths are compared, so a symlink cannot lead out of the roots.
 */
export function checkOrgSourceFolder(
  folder: string,
  repoRoots: readonly string[],
  runnerRoot: string,
  realHome?: string,
): OrgFolderCheck {
  let real: string;
  try {
    real = realpathSync(resolve(folder));
    if (!statSync(real).isDirectory()) return { ok: false, error: `${folder} is not a folder` };
  } catch {
    return { ok: false, error: `${folder} does not exist` };
  }
  if (forbiddenReadPath(real, runnerRoot, realHome))
    return {
      ok: false,
      error: `${folder} cannot be opened: it is, contains or sits in the home directory, the runner's data directory or a credentials folder`,
    };
  const roots = repoRoots.flatMap((r) => {
    try {
      return [realpathSync(resolve(r))];
    } catch {
      return [];
    }
  });
  if (!roots.some((r) => inside(real, r) && real !== r))
    return {
      ok: false,
      error: `${folder} must be a folder inside one of the runner's repoRoots (${repoRoots.join(', ') || 'none configured'}), not a root itself`,
    };
  return { ok: true, path: real };
}

/**
 * The git repositories under the organization's source folder, as read-only folders (`kind: 'org'`): found by the same
 * scan the runner uses for its clones (depth 3, `.git` folders only), each one confined to the folder after symlinks are
 * resolved. A folder that no longer passes `checkOrgSourceFolder` opens nothing.
 */
export async function resolveOrgFolderRepos(
  folder: string | undefined,
  deps: { repoRoots: readonly string[]; runnerRoot: string; realHome?: string },
): Promise<ResolvedReadRepo[]> {
  if (!folder) return [];
  const checked = checkOrgSourceFolder(folder, deps.repoRoots, deps.runnerRoot, deps.realHome);
  if (!checked.ok) return [];
  const root = checked.path;
  const repos = await scanAllRepos([root], (p) => forbiddenReadPath(p, deps.runnerRoot, deps.realHome));
  const out: ResolvedReadRepo[] = [];
  for (const r of repos) {
    let real: string;
    try {
      real = realpathSync(r.localPath);
    } catch {
      continue;
    }
    if (!inside(real, root) || real === root || forbiddenReadPath(real, deps.runnerRoot, deps.realHome))
      continue;
    const key = relative(root, real).split(sep).join('/');
    out.push({ repoId: `orgfolder:${key}`, name: basename(real), kind: 'org', path: real });
  }
  return out;
}

/** Adds `extra` folders after `base`; a path that is already open (as the project's own or a reference) stays as it was. */
export function mergeReadFolders<T extends { path: string }>(base: T[], extra: T[]): T[] {
  const seen = new Set(base.map((f) => f.path));
  return [...base, ...extra.filter((f) => !seen.has(f.path))];
}
