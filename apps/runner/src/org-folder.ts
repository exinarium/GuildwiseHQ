import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_ORG_FOLDER_CANDIDATES, type OrgFolderState } from '@aom/shared';
import type { RunnerConfig } from './config.ts';
import { checkOrgSourceFolder, resolveOrgFolderRepos } from './read-repos.ts';

/**
 * The organisation source folder of this workstation, in one place: `aom-runner org-folder`, the `org.folder` command
 * from the app and the periodic report all go through here, so the rules (strictly inside a repo root, never the home
 * directory, the runner's data dir or a credentials folder, real paths compared) have a single source of truth.
 */

export const ORG_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OrgFolderChange =
  | { ok: true; config: RunnerConfig; path: string | null }
  | { ok: false; error: string };

/**
 * Sets (`path`) or clears (`path: null`) the folder of one organisation: returns the new config (nothing is written) or
 * the reason the folder is refused.
 */
export function changeOrgFolder(
  config: RunnerConfig,
  orgId: string,
  path: string | null,
  runnerRoot: string,
  realHome?: string,
): OrgFolderChange {
  if (!ORG_ID_RE.test(orgId)) return { ok: false, error: `'${orgId}' is not an organization id (a UUID)` };
  const key = orgId.toLowerCase();
  if (path === null) {
    const { [key]: _gone, ...rest } = config.orgSourceFolders;
    return { ok: true, config: { ...config, orgSourceFolders: rest }, path: null };
  }
  const checked = checkOrgSourceFolder(path, config.repoRoots, runnerRoot, realHome);
  if (!checked.ok) return { ok: false, error: checked.error };
  return {
    ok: true,
    config: { ...config, orgSourceFolders: { ...config.orgSourceFolders, [key]: checked.path } },
    path: checked.path,
  };
}

/** What the runner says about each configured folder: is it still acceptable, and how many repositories it holds. */
export async function orgFolderStates(
  config: RunnerConfig,
  runnerRoot: string,
  realHome?: string,
): Promise<OrgFolderState[]> {
  const out: OrgFolderState[] = [];
  for (const [orgId, folder] of Object.entries(config.orgSourceFolders)) {
    if (!ORG_ID_RE.test(orgId)) continue;
    const checked = checkOrgSourceFolder(folder, config.repoRoots, runnerRoot, realHome);
    const repoCount = checked.ok
      ? (
          await resolveOrgFolderRepos(folder, {
            repoRoots: config.repoRoots,
            runnerRoot,
            ...(realHome ? { realHome } : {}),
          })
        ).length
      : 0;
    out.push({
      orgId: orgId.toLowerCase(),
      folder,
      valid: checked.ok,
      reason: checked.ok ? null : checked.error.slice(0, 600),
      repoCount,
    });
  }
  return out;
}

const SKIP = new Set(['node_modules', 'vendor', 'target', 'dist', 'build']);

/**
 * Folders worth offering: sub folders (depth 1 and 2) of the repo roots that are not repositories themselves and that
 * pass the same check as a typed path. Bounded; sorted.
 */
export function orgFolderCandidates(
  config: RunnerConfig,
  runnerRoot: string,
  realHome?: string,
  max = MAX_ORG_FOLDER_CANDIDATES,
): string[] {
  const found = new Set<string>();
  const visit = (dir: string, depth: number) => {
    if (found.size >= max) return;
    let names: string[];
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name))
        .map((e) => e.name)
        .sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (found.size >= max) return;
      const path = join(dir, name);
      if (existsSync(join(path, '.git'))) continue; // a repository, not a folder of repositories
      const checked = checkOrgSourceFolder(path, config.repoRoots, runnerRoot, realHome);
      if (checked.ok) found.add(checked.path);
      if (depth < 2) visit(path, depth + 1);
    }
  };
  for (const root of config.repoRoots) visit(root, 1);
  return [...found].sort();
}
