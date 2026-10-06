import { isOrgOperational, type ProjectRole, parseCardRef } from '@aom/shared';
import { orgSuspended } from '../auth/org-context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { conflict, notFound } from '../errors.ts';

/**
 * Projects the user can see: active members (owner + managers). Projects of an organization that is not running
 * (suspended, cancelled) are visible to its Owner only (docs/design/organizations.md section 8.2).
 */
export const VISIBLE_PROJECTS_SQL = `SELECT pm.project_id FROM project_members pm
    JOIN projects p ON p.id = pm.project_id LEFT JOIN organizations o ON o.id = p.org_id
   WHERE pm.user_id = $1 AND pm.status = 'active'
     AND (o.id IS NULL OR o.status IN ('trial','active') OR o.owner_user_id = $1)`;

/** 403 `org_suspended` when the object's organization is not running and the user is not its Owner. */
function assertOrgRunning(row: Row, userId: string): void {
  if (row.org_status && !isOrgOperational(row.org_status) && row.org_owner !== userId)
    throw orgSuspended(
      { name: row.org_name ?? 'The organization', status: row.org_status },
      row.org_owner_name,
    );
}
const ORG_COLS = `o.status AS org_status, o.owner_user_id AS org_owner, o.name AS org_name,
       (SELECT u.display_name FROM users u WHERE u.id = o.owner_user_id) AS org_owner_name`;

export async function visibleProjectIds(db: Queryable, userId: string): Promise<string[]> {
  return (await rows<{ project_id: string }>(db, VISIBLE_PROJECTS_SQL, [userId])).map((r) => r.project_id);
}

export async function projectRole(db: Queryable, userId: string, projectId: string): Promise<ProjectRole> {
  const r = await one<{ role: 'owner' | 'manager' }>(
    db,
    `SELECT role FROM project_members WHERE user_id=$1 AND project_id=$2 AND status='active'`,
    [userId, projectId],
  );
  return r?.role ?? null;
}

/** Active member or 404 (not visible looks the same as not found). */
export async function requireProjectMember(
  db: Queryable,
  userId: string,
  projectId: string,
): Promise<'owner' | 'manager'> {
  const role = await projectRole(db, userId, projectId);
  if (!role) throw notFound('project not found');
  return role;
}

export async function loadVisibleProject(db: Queryable, userId: string, projectId: string): Promise<Row> {
  const p = await one(
    db,
    `SELECT p.*, pm.role AS my_role, ${ORG_COLS} FROM projects p JOIN project_members pm
       ON pm.project_id = p.id AND pm.user_id = $1 AND pm.status = 'active'
       LEFT JOIN organizations o ON o.id = p.org_id WHERE p.id = $2`,
    [userId, projectId],
  );
  if (!p) throw notFound('project not found');
  assertOrgRunning(p, userId);
  return p;
}

/** Card by uuid or by ref (`WEB-12`), only within the user's visible projects. */
export async function loadVisibleCard(
  db: Queryable,
  userId: string,
  idOrRef: string,
): Promise<{ card: Row; role: 'owner' | 'manager' }> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrRef);
  let card: Row | undefined;
  if (isUuid) {
    card = await one(
      db,
      `SELECT c.*, pm.role AS my_role, ${ORG_COLS} FROM cards c JOIN project_members pm
         ON pm.project_id = c.project_id AND pm.user_id = $1 AND pm.status = 'active'
         LEFT JOIN organizations o ON o.id = c.org_id WHERE c.id = $2`,
      [userId, idOrRef],
    );
  } else if (parseCardRef(idOrRef)) {
    // Project keys are unique per organization only, so a ref can match cards in several of the user's projects
    // (their own `WEB` and a shared one from another org). Never guess: the caller must use the card id.
    const found = await rows(
      db,
      `SELECT c.*, pm.role AS my_role, p.key AS project_key, p.name AS project_name, ${ORG_COLS} FROM cards c
         JOIN project_members pm ON pm.project_id = c.project_id AND pm.user_id = $1 AND pm.status = 'active'
         JOIN projects p ON p.id = c.project_id LEFT JOIN organizations o ON o.id = c.org_id
        WHERE c.ref = $2 ORDER BY c.created_at LIMIT 10`,
      [userId, idOrRef],
    );
    if (found.length > 1)
      throw conflict(
        'ambiguous_ref',
        `${idOrRef} matches cards in more than one of your projects; use the card id`,
        {
          candidates: found.map((c) => ({
            id: c.id,
            ref: c.ref,
            title: c.title,
            projectId: c.project_id,
            projectName: c.project_name,
          })),
        },
      );
    card = found[0];
  }
  if (!card) throw notFound('card not found');
  assertOrgRunning(card, userId);
  return { card, role: card.my_role };
}

/**
 * Event visibility predicate for browser replay (docs/design/organizations.md section 6). `$1` user, `$2` is super
 * admin, `$3` visible project ids, `$4` the socket's organization, `$5` the user's role in it. Organization events
 * are returned to every member of the socket's organization; Members get them payload-stripped in `toVisibleEvent`.
 */
export const EVENT_VISIBILITY_SQL = `(
  (audience = 'org' AND org_id = $4::uuid AND $5::text IS NOT NULL AND NOT $2::boolean)
  OR (audience = 'project' AND project_id = ANY($3::uuid[]) AND NOT $2::boolean)
  OR (audience = 'user' AND user_id = $1::uuid AND NOT $2::boolean)
  OR (audience = 'admin' AND $2::boolean)
)`;
