import {
  compareSemver,
  RELEASE_SUBMODULE_GATE_CODE,
  type ReleasePointerGate,
  type ReleaseSubmoduleFacts,
  ReleaseFactsSchema,
  releasePointerGate,
  tagVersion,
} from '@aom/shared';
import { one, type Queryable, rows } from '../db/sql.ts';
import { conflict } from '../errors.ts';
import { loadFacts } from './facts.ts';

/** The newest release version the server knows of a repository (tagged ships and its own stored facts), or null. */
async function newestKnownVersion(db: Queryable, repoId: string): Promise<string | null> {
  const shipped = await rows<{ version: string }>(
    db,
    'SELECT version FROM release_ships WHERE repo_id=$1 AND tag_name IS NOT NULL',
    [repoId],
  );
  const stored = await one(db, 'SELECT facts FROM repo_release_facts WHERE project_repo_id=$1', [repoId]);
  const parsed = stored?.facts ? ReleaseFactsSchema.safeParse(stored.facts) : null;
  const fromFacts = parsed?.success ? parsed.data.existingTags.map((t) => tagVersion(t)) : [];
  const versions = [...shipped.map((r) => r.version), ...fromFacts].filter((v): v is string => !!v);
  let newest: string | null = null;
  for (const v of versions) if (newest === null || (compareSemver(v, newest) ?? 0) > 0) newest = v;
  return newest;
}

/**
 * The stored submodule entries with the server's own knowledge applied: a pointed repository that released a newer
 * version after these facts were read turns `pinned` / `not_on_release_tag` into `behind`.
 */
export async function withServerStaleness(
  db: Queryable,
  subs: readonly ReleaseSubmoduleFacts[] | undefined,
): Promise<ReleaseSubmoduleFacts[] | undefined> {
  if (!subs) return undefined;
  const out: ReleaseSubmoduleFacts[] = [];
  for (const s of subs) {
    const read = s.latestTag ? tagVersion(s.latestTag.name) : null;
    if (!s.repoId || !read || (s.state !== 'pinned' && s.state !== 'not_on_release_tag')) {
      out.push(s);
      continue;
    }
    const newest = await newestKnownVersion(db, s.repoId);
    if (newest && (compareSemver(newest, read) ?? 0) > 0) {
      const name = s.repoName ?? 'the pointed repository';
      out.push({
        ...s,
        state: 'behind',
        latestTag: { name: `v${newest}`, sha: '' },
        reason: `${name} released ${newest} after this repository was read`.slice(0, 300),
      });
    } else out.push(s);
  }
  return out;
}

/** The submodule pointer gate of a repository's current release facts. */
export async function releasePointerGateFor(
  db: Queryable,
  repoId: string,
): Promise<{ gate: ReleasePointerGate; submodules: ReleaseSubmoduleFacts[] | undefined }> {
  const repo = await one(db, 'SELECT name FROM project_repos WHERE id=$1', [repoId]);
  const stored = await loadFacts(db, repoId);
  const submodules = await withServerStaleness(db, stored?.facts?.submodules);
  return { gate: releasePointerGate(submodules, repo?.name ?? 'this repository'), submodules };
}

/**
 * Refuses (409 `release_submodule_behind`) while a submodule of the repository points behind the latest release of the
 * project repository it points to, or at an untagged commit. Called wherever `release.ship` would be queued.
 */
export async function assertReleasePointers(db: Queryable, repoId: string): Promise<void> {
  const { gate } = await releasePointerGateFor(db, repoId);
  if (!gate.blocked) return;
  throw conflict(RELEASE_SUBMODULE_GATE_CODE, gate.message ?? 'a submodule points behind its latest release', {
    repoId,
    submodules: gate.blocking.map(({ path, pinned, latestTag, state }) => ({
      path,
      pinned,
      latestTag: latestTag?.name ?? null,
      state,
    })),
  });
}
