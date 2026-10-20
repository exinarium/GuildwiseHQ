import { one, type Queryable } from '../db/sql.ts';

/**
 * The project an organization-level task or wake is filed under: the given one, else the oldest active project of the
 * organization (one an Owner or Admin paused only when every project is, so an organization-wide task does not wait
 * behind one paused project). Null when the organization has no active project.
 */
export async function carrierProject(
  db: Queryable,
  orgId: string,
  projectId: string | null,
): Promise<string | null> {
  if (projectId) return projectId;
  const p = await one<{ id: string }>(
    db,
    `SELECT id FROM projects WHERE org_id=$1 AND status='active' AND kind='project' ORDER BY (paused_at IS NOT NULL), created_at, id LIMIT 1`,
    [orgId],
  );
  return p?.id ?? null;
}
