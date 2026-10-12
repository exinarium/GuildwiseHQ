import {
  type CatalogRepo,
  type LocalReadRepo,
  normalizeRemoteUrl,
  type WorkstationRepoDto,
} from '@aom/shared';
import { exec, type Queryable, rows } from '../db/sql.ts';
import { wsServesOrgSql } from '../simulation/fit.ts';

/**
 * Reference repositories picked from clones on a workstation (any repository under its repoRoots, not only the
 * project repositories): the catalog the runner reports, the picker, the validation and what goes back to a runner.
 */

/** The runner's catalog of clones, replaced on each report (an older runner sends none: what we have stays). */
export async function recordRepoCatalog(
  db: Queryable,
  workstationId: string,
  catalog: CatalogRepo[] | undefined,
  now: Date,
): Promise<void> {
  if (!catalog) return;
  const seen = new Set<string>();
  const list = catalog.filter((c) => c.localKey && !seen.has(c.localKey) && seen.add(c.localKey));
  await exec(db, 'DELETE FROM workstation_repo_catalog WHERE workstation_id=$1', [workstationId]);
  if (list.length === 0) return;
  await exec(
    db,
    `INSERT INTO workstation_repo_catalog (workstation_id, local_key, name, remote_url_normalized, reported_at)
     SELECT $1, k, n, NULLIF(u, ''), $5 FROM unnest($2::text[], $3::text[], $4::text[]) AS t(k, n, u)`,
    [
      workstationId,
      list.map((c) => c.localKey),
      list.map((c) => c.name),
      list.map((c) => (c.remoteUrlNormalized ? normalizeRemoteUrl(c.remoteUrlNormalized) : '')),
      now,
    ],
  );
}

export interface StoredWorkstationRepo {
  workstationId: string;
  localKey: string;
  name: string;
  remoteUrlNormalized: string | null;
}

/** Clones on the caller's own, active workstations that may serve the organization: what the picker offers. */
export async function workstationRepoCandidates(
  db: Queryable,
  userId: string,
  orgId: string,
): Promise<WorkstationRepoDto[]> {
  return (
    await rows(
      db,
      `SELECT c.workstation_id, w.name AS workstation_name, c.local_key, c.name, c.remote_url_normalized
         FROM workstation_repo_catalog c JOIN workstations w ON w.id = c.workstation_id
        WHERE w.user_id = $1 AND w.status = 'active' AND ${wsServesOrgSql('w', '$2::uuid')}
        ORDER BY w.name, c.name, c.local_key`,
      [userId, orgId],
    )
  ).map((r) => ({
    workstationId: r.workstation_id,
    workstationName: r.workstation_name,
    localKey: r.local_key,
    name: r.name,
    remoteUrl: r.remote_url_normalized,
  }));
}

/**
 * Validates the requested clones for `PUT .../reference-repos`: each is on one of the caller's own active workstations
 * that serves the organization and is in that workstation's reported catalog, or is one the project already has
 * (picked by an earlier owner) on a workstation that is still active and whose user still belongs to the organization.
 * Returns the stored form, or the entries that are refused.
 */
export async function validateWorkstationRepos(
  db: Queryable,
  a: {
    userId: string;
    orgId: string;
    wanted: Array<{ workstationId: string; localKey: string }>;
    current: StoredWorkstationRepo[];
  },
): Promise<{ ok: StoredWorkstationRepo[]; bad: Array<{ workstationId: string; localKey: string }> }> {
  const own = await workstationRepoCandidates(db, a.userId, a.orgId);
  const stillValid = new Set(
    (
      await rows(
        db,
        `SELECT w.id FROM workstations w
          WHERE w.id = ANY($1::uuid[]) AND w.status = 'active' AND ${wsServesOrgSql('w', '$2::uuid')}
            AND EXISTS (SELECT 1 FROM org_members om WHERE om.org_id = $2 AND om.user_id = w.user_id AND om.status = 'active')`,
        [a.current.map((c) => c.workstationId), a.orgId],
      )
    ).map((r) => r.id as string),
  );
  const ok: StoredWorkstationRepo[] = [];
  const bad: Array<{ workstationId: string; localKey: string }> = [];
  const seen = new Set<string>();
  for (const w of a.wanted) {
    const key = `${w.workstationId}\u0000${w.localKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const mine = own.find((o) => o.workstationId === w.workstationId && o.localKey === w.localKey);
    const kept = a.current.find((c) => c.workstationId === w.workstationId && c.localKey === w.localKey);
    if (mine)
      ok.push({
        workstationId: w.workstationId,
        localKey: w.localKey,
        name: mine.name,
        remoteUrlNormalized: mine.remoteUrl,
      });
    else if (kept && stillValid.has(kept.workstationId)) ok.push(kept);
    else bad.push(w);
  }
  return { ok, bad };
}

/** The project's picked clones as the settings page shows them. */
export async function referenceWorkstationRepoDtos(
  db: Queryable,
  stored: StoredWorkstationRepo[],
): Promise<WorkstationRepoDto[]> {
  if (stored.length === 0) return [];
  const names = new Map(
    (
      await rows(db, 'SELECT id, name FROM workstations WHERE id = ANY($1::uuid[])', [
        stored.map((s) => s.workstationId),
      ])
    ).map((r) => [r.id as string, r.name as string]),
  );
  return stored.map((s) => ({
    workstationId: s.workstationId,
    workstationName: names.get(s.workstationId) ?? 'unknown workstation',
    localKey: s.localKey,
    name: s.name,
    remoteUrl: s.remoteUrlNormalized,
  }));
}

/**
 * The picked clones as the runner of `workstationId` receives them. A clone with a remote goes to every workstation (any
 * clone of the same remote may be opened there: it is the same repository); a clone without one only to the workstation
 * it was picked on, by `localKey`. On that workstation the key comes along too, so two clones of one remote there
 * cannot be mixed up.
 */
export async function localReadRepos(
  db: Queryable,
  projectId: string,
  workstationId: string,
): Promise<LocalReadRepo[]> {
  const r = await rows(db, 'SELECT reference_workstation_repos AS l FROM projects WHERE id=$1', [projectId]);
  const stored = (r[0]?.l ?? []) as StoredWorkstationRepo[];
  const out: LocalReadRepo[] = [];
  for (const s of stored) {
    const here = s.workstationId === workstationId;
    if (!here && !s.remoteUrlNormalized) continue;
    out.push({
      name: s.name,
      ...(here ? { localKey: s.localKey } : {}),
      ...(s.remoteUrlNormalized ? { remoteUrlNormalized: s.remoteUrlNormalized } : {}),
    });
  }
  return out;
}
