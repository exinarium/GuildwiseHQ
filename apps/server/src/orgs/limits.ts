import type { LimitKind, OrgLimits, OrgUsage } from '@aom/shared';
import { one, type Queryable } from '../db/sql.ts';
import { conflict } from '../errors.ts';

/**
 * Usage and limits of an organization (docs/design/organizations.md section 7.4). Limits are optional: the Founding
 * plan has none, so every limit column is NULL (unlimited) until pricing is decided. Guests never count.
 */
export async function orgUsage(db: Queryable, orgId: string): Promise<OrgUsage> {
  const r = await one<{ members: number; projects: number; agents: number; workstations: number }>(
    db,
    `SELECT
       (SELECT count(*)::int FROM org_members WHERE org_id=$1 AND status='active')
         + (SELECT count(*)::int FROM invitations WHERE org_id=$1 AND kind='org_member' AND status='pending'
              AND expires_at > now()) AS members,
       (SELECT count(*)::int FROM projects WHERE org_id=$1 AND status='active' AND kind='project') AS projects,
       (SELECT count(*)::int FROM agents WHERE org_id=$1 AND status <> 'retired' AND NOT is_devops) AS agents,
       (SELECT count(DISTINCT workstation_id)::int FROM agents
         WHERE org_id=$1 AND status='active' AND NOT is_devops AND workstation_id IS NOT NULL) AS workstations`,
    [orgId],
  );
  return r ?? { members: 0, projects: 0, agents: 0, workstations: 0 };
}

export async function orgLimits(db: Queryable, orgId: string): Promise<OrgLimits> {
  const r = await one<{
    max_members: number | null;
    max_workstations: number | null;
    max_projects: number | null;
  }>(db, 'SELECT max_members, max_workstations, max_projects FROM organizations WHERE id=$1', [orgId]);
  return {
    maxMembers: r?.max_members ?? null,
    maxWorkstations: r?.max_workstations ?? null,
    maxAgents: null, // B11: plans never limit agents; the max_agents column is unused
    maxProjects: r?.max_projects ?? null,
  };
}

const LIMIT_FIELD: Record<LimitKind, keyof OrgLimits> = {
  members: 'maxMembers',
  projects: 'maxProjects',
  agents: 'maxAgents',
  workstations: 'maxWorkstations',
};
const LIMIT_NOUN: Record<LimitKind, string> = {
  members: 'members',
  projects: 'projects',
  agents: 'agents',
  workstations: 'workstations',
};

/** How full each limit is: `null` max is unlimited. */
export function limitState(
  usage: OrgUsage,
  limits: OrgLimits,
): Array<{ kind: LimitKind; used: number; max: number | null; over: boolean; full: boolean }> {
  return (Object.keys(LIMIT_FIELD) as LimitKind[]).map((kind) => {
    const max = limits[LIMIT_FIELD[kind]];
    const used = usage[kind];
    return { kind, used, max, over: max !== null && used > max, full: max !== null && used >= max };
  });
}

/**
 * Throws 409 `limit_reached` when adding `delta` of `kind` would exceed the organization's limit. Call it inside the
 * command's append transaction: it locks the organization row (`FOR UPDATE`) so two concurrent adds at `max - 1` cannot
 * both pass. An unlimited organization (no limit set) always passes.
 */
export async function assertWithinLimit(
  tx: Queryable,
  orgId: string,
  kind: LimitKind,
  delta = 1,
): Promise<void> {
  // Owner decision B11: plans never limit agents (the max_agents column is kept but ignored).
  if (kind === 'agents') return;
  const org = await one<Record<string, number | null>>(
    tx,
    'SELECT max_members, max_workstations, max_projects FROM organizations WHERE id=$1 FOR UPDATE',
    [orgId],
  );
  if (!org) return;
  const column = {
    members: 'max_members',
    projects: 'max_projects',
    workstations: 'max_workstations',
  }[kind];
  const max = org[column] ?? null;
  if (max === null) return;
  const used = (await orgUsage(tx, orgId))[kind];
  if (used + delta > max)
    throw conflict(
      'limit_reached',
      `This organization has reached its limit of ${max} ${LIMIT_NOUN[kind]}.`,
      { limit: kind, used, max },
    );
}
