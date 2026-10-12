import { type ReadRepo, type ReferenceRepoDto, scrubRemoteUrl } from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import { type Queryable, rows } from '../db/sql.ts';

/**
 * Repositories an agent of a project may read, read-only (docs/RUNNER.md, "Reference repositories"). They go to the
 * runner by remote, never by path: the runner finds its own clone and opens only that folder.
 */

/** The project's reference repositories that still exist, are active and belong to the project's organization. */
export async function referenceReadRepos(db: Queryable, projectId: string): Promise<ReadRepo[]> {
  const list = await rows(
    db,
    `SELECT r.id, r.name, r.remote_url_normalized FROM projects p
       JOIN project_repos r ON r.id = ANY(p.reference_repo_ids) AND r.removed_at IS NULL
       JOIN projects rp ON rp.id = r.project_id AND rp.org_id = p.org_id AND rp.status = 'active'
      WHERE p.id = $1 AND r.project_id <> p.id ORDER BY r.name, r.id`,
    [projectId],
  );
  return list.map((r) => ({
    repoId: r.id,
    name: r.name,
    remoteUrlNormalized: r.remote_url_normalized,
    kind: 'reference' as const,
  }));
}

/** The project's own repositories (a chat about the project reads them when they are cloned on the workstation). */
export async function projectReadRepos(db: Queryable, projectId: string): Promise<ReadRepo[]> {
  const list = await rows(
    db,
    'SELECT id, name, remote_url_normalized FROM project_repos WHERE project_id=$1 AND removed_at IS NULL ORDER BY name, id',
    [projectId],
  );
  return list.map((r) => ({
    repoId: r.id,
    name: r.name,
    remoteUrlNormalized: r.remote_url_normalized,
    kind: 'project' as const,
  }));
}

/**
 * Every repository of the organization's active projects (interest projects excluded) that the workstation owner is an
 * active member of: what an agent whose role has `readOrgRepos` (the architect) may read, read-only. Named by remote;
 * the runner opens only the clones it found itself.
 */
export async function orgReadRepos(db: Queryable, orgId: string, userId: string): Promise<ReadRepo[]> {
  const list = await rows(
    db,
    `SELECT r.id, r.name, r.remote_url_normalized FROM project_repos r
       JOIN projects rp ON rp.id = r.project_id
      WHERE rp.org_id = $1 AND rp.status = 'active' AND rp.kind <> 'interest' AND r.removed_at IS NULL
        AND EXISTS (SELECT 1 FROM project_members pm
                     WHERE pm.project_id = rp.id AND pm.user_id = $2 AND pm.status = 'active')
      ORDER BY rp.name, r.name, r.id`,
    [orgId, userId],
  );
  return list.map((r) => ({
    repoId: r.id,
    name: r.name,
    remoteUrlNormalized: r.remote_url_normalized,
    kind: 'org' as const,
  }));
}

const toDto = (r: Record<string, any>): ReferenceRepoDto => ({
  repoId: r.id,
  name: r.name,
  projectId: r.project_id,
  projectName: r.project_name,
  remoteUrl: scrubRemoteUrl(r.remote_url),
});

/** The reference repositories as the settings page shows them (names, no paths). */
export async function referenceRepoDtos(db: Queryable, projectId: string): Promise<ReferenceRepoDto[]> {
  return (
    await rows(
      db,
      `SELECT r.id, r.name, r.remote_url, r.project_id, rp.name AS project_name FROM projects p
         JOIN project_repos r ON r.id = ANY(p.reference_repo_ids) AND r.removed_at IS NULL
         JOIN projects rp ON rp.id = r.project_id AND rp.org_id = p.org_id
        WHERE p.id = $1 ORDER BY rp.name, r.name`,
      [projectId],
    )
  ).map(toDto);
}

/**
 * Who sees every repository of the organization's projects: the Owner and Admins. Everyone else only the projects they
 * are an active member of. The picker and the validation of `PUT .../reference-repos` both go through
 * `eligibleProjectRepos`, so they cannot disagree.
 */
export async function seesAllOrgRepos(db: Queryable, userId: string, orgId: string): Promise<boolean> {
  const role = await orgRoleOf(db, userId, orgId);
  return role === 'owner' || role === 'admin';
}

/**
 * Repositories of the organization's other active projects (not interest projects) that `userId` may pick as a
 * reference repository of `projectId`; `onlyIds` narrows it (validation).
 */
export async function eligibleProjectRepos(
  db: Queryable,
  a: { userId: string; orgId: string; projectId: string; onlyIds?: string[] },
): Promise<ReferenceRepoDto[]> {
  const all = await seesAllOrgRepos(db, a.userId, a.orgId);
  return (
    await rows(
      db,
      `SELECT r.id, r.name, r.remote_url, r.project_id, rp.name AS project_name FROM project_repos r
         JOIN projects rp ON rp.id = r.project_id
        WHERE rp.org_id = $2 AND rp.id <> $3 AND rp.status = 'active' AND rp.kind <> 'interest'
          AND r.removed_at IS NULL
          AND ($4::uuid[] IS NULL OR r.id = ANY($4::uuid[]))
          AND ($5::boolean OR EXISTS (SELECT 1 FROM project_members pm
                                       WHERE pm.project_id = rp.id AND pm.user_id = $1 AND pm.status = 'active'))
        ORDER BY rp.name, r.name`,
      [a.userId, a.orgId, a.projectId, a.onlyIds ?? null, all],
    )
  ).map(toDto);
}

/** What the user could pick among the organization's projects' repositories. */
export const referenceRepoCandidates = (
  db: Queryable,
  userId: string,
  orgId: string,
  projectId: string,
): Promise<ReferenceRepoDto[]> => eligibleProjectRepos(db, { userId, orgId, projectId });
