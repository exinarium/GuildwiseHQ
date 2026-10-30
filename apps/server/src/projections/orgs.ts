import { type EventOf, planDefinition } from '@aom/shared';
import { exec, one } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { Projector } from '../eventstore/types.ts';
import { refreshAccessWhere } from './sharing.ts';

const ev = <T>(e: { event: unknown }) => e.event as T;

/** The org's Owner and Admins get `org_grant` rows on every project of the org (decision D6). */
export async function grantOrgAccess(tx: Tx, orgId: string, userId: string, at: Date): Promise<void> {
  await exec(
    tx,
    `INSERT INTO project_members (project_id, user_id, role, status, joined_at, direct, org_grant)
     SELECT p.id, $2, 'owner', 'active', $3, false, true FROM projects p WHERE p.org_id = $1
     ON CONFLICT (project_id, user_id) DO UPDATE
       SET org_grant = true, role = 'owner', status = 'active', removed_at = NULL,
           joined_at = COALESCE(project_members.joined_at, EXCLUDED.joined_at)`,
    [orgId, userId, at],
  );
}

/** Owner or Admin -> Member: the grant goes; rows that were only the grant are removed, direct ones stay. */
async function revokeOrgGrant(tx: Tx, orgId: string, userId: string, at: Date): Promise<void> {
  await exec(
    tx,
    `UPDATE project_members SET org_grant = false
      WHERE user_id = $2 AND project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
    [orgId, userId],
  );
  await refreshAccessWhere(
    tx,
    `user_id = $2 AND project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
    [orgId, userId],
    at,
  );
}

export const orgProjectors: Record<string, Projector> = {
  OrganizationCreated: async (tx, e) => {
    const p = ev<EventOf<'OrganizationCreated'>>(e).payload;
    await exec(
      tx,
      `INSERT INTO organizations (id, name, owner_user_id, status, status_reason, status_changed_at, plan,
         max_members, max_workstations, max_agents, max_projects, trial_ends_at, license_expires_at, features,
         created_via, created_at, simulation, mode)
       VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$5,$15,$16)`,
      [
        p.orgId,
        p.name,
        p.ownerUserId,
        p.status,
        e.createdAt,
        p.plan,
        p.limits.maxMembers,
        p.limits.maxWorkstations,
        p.limits.maxAgents,
        p.limits.maxProjects,
        p.trialEndsAt ?? null,
        p.licenseExpiresAt ?? null,
        JSON.stringify(p.features ?? {}),
        p.createdVia,
        p.simulation === true,
        p.mode ?? 'dev',
      ],
    );
  },
  OrganizationRenamed: async (tx, e) => {
    const p = ev<EventOf<'OrganizationRenamed'>>(e).payload;
    await exec(tx, 'UPDATE organizations SET name=$2 WHERE id=$1', [p.orgId, p.name]);
  },
  OrgMemberAdded: async (tx, e) => {
    const p = ev<EventOf<'OrgMemberAdded'>>(e).payload;
    await exec(
      tx,
      `INSERT INTO org_members (org_id, user_id, role, status, invited_by, joined_at)
       VALUES ($1,$2,$3,'active',$4,$5)
       ON CONFLICT (org_id, user_id) DO UPDATE
         SET role = EXCLUDED.role, status = 'active', removed_at = NULL, invited_by = EXCLUDED.invited_by,
             joined_at = EXCLUDED.joined_at`,
      [p.orgId, p.userId, p.role, p.invitedBy ?? null, e.createdAt],
    );
    if (p.role === 'owner' || p.role === 'admin') await grantOrgAccess(tx, p.orgId, p.userId, e.createdAt);
  },
  OrgMemberRoleChanged: async (tx, e) => {
    const p = ev<EventOf<'OrgMemberRoleChanged'>>(e).payload;
    await exec(tx, `UPDATE org_members SET role=$3 WHERE org_id=$1 AND user_id=$2 AND status='active'`, [
      p.orgId,
      p.userId,
      p.role,
    ]);
    if (p.role === 'admin') await grantOrgAccess(tx, p.orgId, p.userId, e.createdAt);
    else await revokeOrgGrant(tx, p.orgId, p.userId, e.createdAt);
  },
  OrgMemberRemoved: async (tx, e) => {
    const p = ev<EventOf<'OrgMemberRemoved'>>(e).payload;
    await exec(
      tx,
      `UPDATE org_members SET status='removed', removed_at=$3 WHERE org_id=$1 AND user_id=$2 AND status='active'`,
      [p.orgId, p.userId, e.createdAt],
    );
    // Every project access of the organization goes (direct rows, the grant, pending shares).
    await exec(
      tx,
      `UPDATE project_members SET org_grant=false, direct=false, status='removed', role='manager',
              removed_at = COALESCE(removed_at, $3)
        WHERE user_id=$2 AND status <> 'removed' AND project_id IN (SELECT id FROM projects WHERE org_id=$1)`,
      [p.orgId, p.userId, e.createdAt],
    );
    // Agents they managed in this organization go to the Owner and need a new home (as for a project removal).
    const org = await one<{ owner_user_id: string }>(
      tx,
      'SELECT owner_user_id FROM organizations WHERE id=$1',
      [p.orgId],
    );
    await exec(
      tx,
      `UPDATE agents SET manager_user_id=$3, status='needs_rehome', workstation_id=NULL
        WHERE org_id=$1 AND manager_user_id=$2 AND status IN ('active','needs_rehome') AND NOT is_devops`,
      [p.orgId, p.userId, org?.owner_user_id ?? p.orgId],
    );
    // Their DevOps engineer on their workstations in this organization is retired by the command (AgentRetired).
  },
  OrgOwnershipTransferred: async (tx, e) => {
    const p = ev<EventOf<'OrgOwnershipTransferred'>>(e).payload;
    // The old Owner first: at most one active owner at any statement.
    await exec(tx, `UPDATE org_members SET role='admin' WHERE org_id=$1 AND user_id=$2`, [
      p.orgId,
      p.fromUserId,
    ]);
    await exec(tx, `UPDATE org_members SET role='owner' WHERE org_id=$1 AND user_id=$2`, [
      p.orgId,
      p.toUserId,
    ]);
    await exec(tx, 'UPDATE organizations SET owner_user_id=$2 WHERE id=$1', [p.orgId, p.toUserId]);
    await grantOrgAccess(tx, p.orgId, p.toUserId, e.createdAt);
    // The built-in CEO belongs to whoever is the Owner (its home is re-bound by the command, in the same append).
    await exec(
      tx,
      `UPDATE agents SET manager_user_id=$2 WHERE org_id=$1 AND role_key='ceo' AND status <> 'retired'`,
      [p.orgId, p.toUserId],
    );
  },
  OrgStatusChanged: async (tx, e) => {
    const p = ev<EventOf<'OrgStatusChanged'>>(e).payload;
    await exec(tx, 'UPDATE organizations SET status=$2, status_reason=$3, status_changed_at=$4 WHERE id=$1', [
      p.orgId,
      p.status,
      p.reason,
      e.createdAt,
    ]);
  },
  OrgPlanChanged: async (tx, e) => {
    const p = ev<EventOf<'OrgPlanChanged'>>(e).payload;
    await exec(tx, 'UPDATE organizations SET plan=$2 WHERE id=$1', [p.orgId, p.plan]);
    if (p.limitsReset) {
      const def = planDefinition(p.plan);
      const l = p.limits ?? def.limits;
      await exec(
        tx,
        `UPDATE organizations SET max_members=$2, max_workstations=$3, max_agents=$4, max_projects=$5, features=$6
          WHERE id=$1`,
        [
          p.orgId,
          l.maxMembers,
          l.maxWorkstations,
          l.maxAgents,
          l.maxProjects,
          JSON.stringify(p.features ?? {}),
        ],
      );
    }
  },
  OrgLimitsSet: async (tx, e) => {
    const p = ev<EventOf<'OrgLimitsSet'>>(e).payload;
    await exec(
      tx,
      'UPDATE organizations SET max_members=$2, max_workstations=$3, max_agents=$4, max_projects=$5 WHERE id=$1',
      [p.orgId, p.limits.maxMembers, p.limits.maxWorkstations, p.limits.maxAgents, p.limits.maxProjects],
    );
  },
  OrgDatesSet: async (tx, e) => {
    const p = ev<EventOf<'OrgDatesSet'>>(e).payload;
    await exec(
      tx,
      `UPDATE organizations SET trial_ends_at=$2, license_expires_at=$3, grace_days=COALESCE($4, grace_days)
        WHERE id=$1`,
      [p.orgId, p.trialEndsAt, p.licenseExpiresAt, p.graceDays ?? null],
    );
  },
  OrgFeaturesSet: async (tx, e) => {
    const p = ev<EventOf<'OrgFeaturesSet'>>(e).payload;
    const row = await one<{ features: Record<string, boolean>; plan: string }>(
      tx,
      'SELECT features, plan FROM organizations WHERE id=$1',
      [p.orgId],
    );
    if (!row) return;
    const next: Record<string, boolean> = { ...row.features };
    for (const [k, v] of Object.entries(p.features)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    await exec(tx, 'UPDATE organizations SET features=$2 WHERE id=$1', [p.orgId, JSON.stringify(next)]);
  },
  OrgSimulationSet: async (tx, e) => {
    const p = ev<EventOf<'OrgSimulationSet'>>(e).payload;
    await exec(
      tx,
      `UPDATE organizations SET simulation=$2, simulation_pace=COALESCE($3, simulation_pace) WHERE id=$1`,
      [p.orgId, p.enabled, p.pace ?? null],
    );
  },
  OrgTwoFactorPolicySet: async (tx, e) => {
    const p = ev<EventOf<'OrgTwoFactorPolicySet'>>(e).payload;
    await exec(tx, 'UPDATE organizations SET require_two_factor=$2 WHERE id=$1', [p.orgId, p.required]);
  },
  OrgModeSet: async (tx, e) => {
    const p = ev<EventOf<'OrgModeSet'>>(e).payload;
    await exec(tx, 'UPDATE organizations SET mode=$2 WHERE id=$1', [p.orgId, p.mode]);
  },
  OrgDiagnosticsSharingSet: async (tx, e) => {
    const p = ev<EventOf<'OrgDiagnosticsSharingSet'>>(e).payload;
    await exec(
      tx,
      `UPDATE organizations SET diagnostics_sharing=$2, diagnostics_consent_version=$3, diagnostics_sharing_at=$4 WHERE id=$1`,
      [p.orgId, p.on, p.consentVersion, e.createdAt],
    );
  },
};
