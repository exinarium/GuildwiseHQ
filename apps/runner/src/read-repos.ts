import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ReadableFolder, ReadRepo } from '@aom/shared';
import { HOME_SECRETS, inside } from './adapters/claude-policy.ts';

export interface ResolvedReadRepo extends ReadableFolder {
  repoId: string;
}

export interface ReadRepoDeps {
  /** The runner's own clone of a repository by normalized remote (its repository scan); undefined: not on this workstation. */
  findRepo(remoteUrlNormalized: string): Promise<{ localPath: string } | undefined>;
  /** The runner data dir: never a read-only folder, nor inside one. */
  runnerRoot: string;
  realHome?: string;
}

/**
 * The server names repositories by remote; the runner opens only the clones it found itself. A repository that is
 * not cloned here is skipped (no error: the project's other workstations may have it). A folder that holds the
 * runner's private state or the user's credentials, or the home directory itself, is never opened.
 * Pure of side effects besides the filesystem lookups; paths are real paths, de-duplicated.
 */
export async function resolveReadRepos(
  readRepos: ReadRepo[] | undefined,
  deps: ReadRepoDeps,
): Promise<ResolvedReadRepo[]> {
  const home = deps.realHome ?? homedir();
  const secrets = HOME_SECRETS.map((s) => join(home, s));
  const seen = new Set<string>();
  const out: ResolvedReadRepo[] = [];
  for (const r of readRepos ?? []) {
    const found = await deps.findRepo(r.remoteUrlNormalized);
    if (!found) continue;
    let path: string;
    try {
      path = realpathSync(found.localPath);
      if (!statSync(path).isDirectory()) continue;
    } catch {
      continue;
    }
    if (
      path === '/' ||
      inside(deps.runnerRoot, path) || // the data dir itself or a parent of it
      inside(path, deps.runnerRoot) ||
      inside(home, path) || // the home directory or a parent of it
      secrets.some((s) => inside(path, s) || inside(s, path))
    )
      continue;
    if (seen.has(path)) {
      // a project repository that is also a reference repository is opened once, as the project's own
      continue;
    }
    seen.add(path);
    out.push({ repoId: r.repoId, name: r.name, kind: r.kind, path });
  }
  return out;
}
