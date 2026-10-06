import type { EventOf } from '@aom/shared';
import { exec, one } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { Projector } from '../eventstore/types.ts';

/**
 * Recomputes the effective `project_members` row from its two grants (decision D6): active when a direct grant
 * (`direct`) or the organization grant (`org_grant`, the Owner and Admins) holds; role `owner` exactly for the
 * organization grant. A pending share (`invited`) stays pending; anything else is `removed`.
 */
export async function refreshAccessWhere(tx: Tx, where: string, params: unknown[], at: Date): Promise<void> {
  const n = params.length + 1;
  await exec(
    tx,
    `UPDATE project_members SET
       status = CASE WHEN direct OR org_grant THEN 'active' WHEN status = 'invited' THEN 'invited' ELSE 'removed' END,
       role = CASE WHEN org_grant THEN 'owner' ELSE 'manager' END,
       joined_at = CASE WHEN direct OR org_grant THEN COALESCE(joined_at, $${n}) ELSE joined_at END,
       removed_at = CASE WHEN direct OR org_grant THEN NULL
                         WHEN status = 'invited' THEN removed_at ELSE COALESCE(removed_at, $${n}) END
     WHERE ${where}`,
    [...params, at],
  );
}

export const refreshProjectAccess = (tx: Tx, projectId: string, userId: string, at: Date) =>
  refreshAccessWhere(tx, 'project_id = $1 AND user_id = $2', [projectId, userId], at);

export const sharingProjectors: Record<string, Projector> = {
  ProjectShared: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectShared'>).payload;
    await exec(
      tx,
      `INSERT INTO project_members (project_id, user_id, role, status, invited_by, invited_at, direct, org_grant)
       VALUES ($1,$2,'manager','invited',$3,$4,false,false)
       ON CONFLICT (project_id, user_id) DO UPDATE
         SET status='invited', invited_by=EXCLUDED.invited_by, invited_at=EXCLUDED.invited_at,
             joined_at=NULL, removed_at=NULL, direct=false
       WHERE NOT project_members.org_grant AND NOT project_members.direct`,
      [p.projectId, p.userId, p.invitedBy, e.createdAt],
    );
  },
  ProjectShareAccepted: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectShareAccepted'>).payload;
    await exec(
      tx,
      `UPDATE project_members SET direct=true WHERE project_id=$1 AND user_id=$2 AND status='invited'`,
      [p.projectId, p.userId],
    );
    await refreshProjectAccess(tx, p.projectId, p.userId, e.createdAt);
  },
  ProjectShareDeclined: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectShareDeclined'>).payload;
    await exec(
      tx,
      `UPDATE project_members SET direct=false, status = CASE WHEN org_grant THEN status ELSE 'removed' END,
              removed_at = CASE WHEN org_grant THEN removed_at ELSE $3 END
        WHERE project_id=$1 AND user_id=$2 AND NOT org_grant AND status='invited'`,
      [p.projectId, p.userId, e.createdAt],
    );
  },
  /** An organization Owner or Admin gave an org Member access: active at once. */
  ProjectMemberAdded: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectMemberAdded'>).payload;
    await exec(
      tx,
      `INSERT INTO project_members (project_id, user_id, role, status, invited_by, invited_at, joined_at, direct, org_grant)
       VALUES ($1,$2,'manager','active',$3,$4,$4,true,false)
       ON CONFLICT (project_id, user_id) DO UPDATE SET direct=true`,
      [p.projectId, p.userId, p.addedBy, e.createdAt],
    );
    await refreshProjectAccess(tx, p.projectId, p.userId, e.createdAt);
  },
  ProjectMemberRemoved: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectMemberRemoved'>).payload;
    // The organization's Owner inherits the agents and cards (legacy history, before organizations: `org_id` is the user).
    const project = await one<{ org_id: string; owner_user_id: string | null }>(
      tx,
      `SELECT p.org_id, o.owner_user_id FROM projects p LEFT JOIN organizations o ON o.id = p.org_id WHERE p.id=$1`,
      [p.projectId],
    );
    await exec(tx, 'UPDATE project_members SET direct=false WHERE project_id=$1 AND user_id=$2', [
      p.projectId,
      p.userId,
    ]);
    await refreshProjectAccess(tx, p.projectId, p.userId, e.createdAt);
    if (!project) return;
    const inheritor = project.owner_user_id ?? project.org_id;
    // The owner inherits the agents; they need a new home (workstation + provider) before they work again.
    await exec(
      tx,
      `UPDATE agents SET manager_user_id=$2, status='needs_rehome', workstation_id=NULL
        WHERE id = ANY($1::uuid[]) AND status <> 'retired'`,
      [p.inheritedAgentIds, inheritor],
    );
    await exec(tx, `UPDATE cards SET owner_user_id=$2, updated_at=$3 WHERE id = ANY($1::uuid[])`, [
      p.transferredCardIds,
      inheritor,
      e.createdAt,
    ]);
  },
  CardRehomed: async (tx, e) => {
    const p = (e.event as EventOf<'CardRehomed'>).payload;
    await exec(
      tx,
      `UPDATE cards SET home_workstation_id=NULL, worktree_path=NULL, branch_name=NULL, base_branch=NULL, updated_at=$2
        WHERE id=$1`,
      [p.cardId, e.createdAt],
    );
  },
};
