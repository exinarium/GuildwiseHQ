import { one, type Queryable } from '../db/sql.ts';

/**
 * Whether the person has access anywhere but this organization (R6, audit F1): another active membership, or active
 * project access in another organization. Their account is global, so an Owner or Admin here may not reset it. Used
 * when the Owner asks for a reset and again when a scheduled two-factor reset fires (release-readiness O2).
 */
export async function hasOtherAccess(db: Queryable, orgId: string, userId: string): Promise<boolean> {
  return !!(await one(
    db,
    `SELECT 1 FROM org_members WHERE user_id=$1 AND org_id<>$2 AND status='active'
     UNION ALL
     SELECT 1 FROM project_members pm JOIN projects p ON p.id = pm.project_id
      WHERE pm.user_id=$1 AND pm.status='active' AND p.org_id IS DISTINCT FROM $2
     LIMIT 1`,
    [userId, orgId],
  ));
}
