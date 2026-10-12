import { type ReadRepo, type ReferenceRepoDto, scrubRemoteUrl } from '@aom/shared';
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

/** What the user could pick: repositories of the organization's other active projects they are an active member of. */
export async function referenceRepoCandidates(
  db: Queryable,
  userId: string,
  orgId: string,
  projectId: string,
): Promise<ReferenceRepoDto[]> {
  return (
    await rows(
      db,
      `SELECT r.id, r.name, r.remote_url, r.project_id, rp.name AS project_name FROM project_repos r
         JOIN projects rp ON rp.id = r.project_id
         JOIN project_members pm ON pm.project_id = rp.id AND pm.user_id = $1 AND pm.status = 'active'
        WHERE rp.org_id = $2 AND rp.id <> $3 AND rp.status = 'active' AND rp.kind <> 'interest'
          AND r.removed_at IS NULL ORDER BY rp.name, r.name`,
      [userId, orgId, projectId],
    )
  ).map(toDto);
}
