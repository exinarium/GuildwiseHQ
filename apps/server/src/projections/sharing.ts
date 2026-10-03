import type { EventOf } from '@aom/shared';
import { exec, one } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

export const sharingProjectors: Record<string, Projector> = {
  ProjectShared: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectShared'>).payload;
    await exec(
      tx,
      `INSERT INTO project_members (project_id, user_id, role, status, invited_by, invited_at)
       VALUES ($1,$2,'manager','invited',$3,$4)
       ON CONFLICT (project_id, user_id) DO UPDATE
         SET status='invited', invited_by=EXCLUDED.invited_by, invited_at=EXCLUDED.invited_at,
             joined_at=NULL, removed_at=NULL
       WHERE project_members.role <> 'owner'`,
      [p.projectId, p.userId, p.invitedBy, e.createdAt],
    );
  },
  ProjectShareAccepted: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectShareAccepted'>).payload;
    await exec(
      tx,
      `UPDATE project_members SET status='active', joined_at=$3 WHERE project_id=$1 AND user_id=$2 AND status='invited'`,
      [p.projectId, p.userId, e.createdAt],
    );
  },
  ProjectShareDeclined: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectShareDeclined'>).payload;
    await exec(
      tx,
      `UPDATE project_members SET status='removed', removed_at=$3 WHERE project_id=$1 AND user_id=$2 AND role <> 'owner'`,
      [p.projectId, p.userId, e.createdAt],
    );
  },
  ProjectMemberRemoved: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectMemberRemoved'>).payload;
    const project = await one<{ org_id: string }>(tx, 'SELECT org_id FROM projects WHERE id=$1', [
      p.projectId,
    ]);
    await exec(
      tx,
      `UPDATE project_members SET status='removed', removed_at=$3 WHERE project_id=$1 AND user_id=$2 AND role <> 'owner'`,
      [p.projectId, p.userId, e.createdAt],
    );
    if (!project) return;
    // The owner inherits the agents; they need a new home (workstation + provider) before they work again.
    await exec(
      tx,
      `UPDATE agents SET manager_user_id=$2, status='needs_rehome', workstation_id=NULL
        WHERE id = ANY($1::uuid[]) AND status <> 'retired'`,
      [p.inheritedAgentIds, project.org_id],
    );
    await exec(tx, `UPDATE cards SET owner_user_id=$2, updated_at=$3 WHERE id = ANY($1::uuid[])`, [
      p.transferredCardIds,
      project.org_id,
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
