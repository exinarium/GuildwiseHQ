import { type ProjectRole, parseCardRef } from '@aom/shared';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { conflict, notFound } from '../errors.ts';

/** Projects the user can see: active members (owner + managers). */
export const VISIBLE_PROJECTS_SQL = `SELECT project_id FROM project_members WHERE user_id = $1 AND status = 'active'`;

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
    `SELECT p.*, pm.role AS my_role FROM projects p JOIN project_members pm
       ON pm.project_id = p.id AND pm.user_id = $1 AND pm.status = 'active' WHERE p.id = $2`,
    [userId, projectId],
  );
  if (!p) throw notFound('project not found');
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
      `SELECT c.*, pm.role AS my_role FROM cards c JOIN project_members pm
         ON pm.project_id = c.project_id AND pm.user_id = $1 AND pm.status = 'active' WHERE c.id = $2`,
      [userId, idOrRef],
    );
  } else if (parseCardRef(idOrRef)) {
    // Project keys are unique per organization only, so a ref can match cards in several of the user's projects
    // (their own `WEB` and a shared one from another org). Never guess: the caller must use the card id.
    const found = await rows(
      db,
      `SELECT c.*, pm.role AS my_role, p.key AS project_key, p.name AS project_name FROM cards c
         JOIN project_members pm ON pm.project_id = c.project_id AND pm.user_id = $1 AND pm.status = 'active'
         JOIN projects p ON p.id = c.project_id
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
  return { card, role: card.my_role };
}

/** Event visibility predicate for browser replay (docs/ARCHITECTURE.md section 17.1). `$1` user, `$2` isAdmin, `$3` project ids. */
export const EVENT_VISIBILITY_SQL = `(
  (audience = 'org' AND org_id = $1)
  OR (audience = 'project' AND project_id = ANY($3::uuid[]))
  OR (audience = 'admin' AND $2::boolean)
)`;
