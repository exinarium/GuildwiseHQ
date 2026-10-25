import type { LimitKind, OrgLimits, OrgUsage } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one, type Queryable } from '../db/sql.ts';

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
       (SELECT count(*)::int FROM agents WHERE org_id=$1 AND status <> 'retired' AND NOT is_builtin) AS agents,
       (SELECT count(DISTINCT workstation_id)::int FROM agents
         WHERE org_id=$1 AND status='active' AND NOT is_builtin AND workstation_id IS NOT NULL) AS workstations`,
    [orgId],
  );
  return r ?? { members: 0, projects: 0, agents: 0, workstations: 0 };
}

/** The organization's limits, from the plan-limits provider (unlimited unless an extension supplies one). */
export function orgLimits(ctx: Ctx, db: Queryable, orgId: string): Promise<OrgLimits> {
  return ctx.ext.planLimits.limits(db, orgId);
}

const LIMIT_FIELD: Record<LimitKind, keyof OrgLimits> = {
  members: 'maxMembers',
  projects: 'maxProjects',
  agents: 'maxAgents',
  workstations: 'maxWorkstations',
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
 * command's append transaction. Without a plan-limits extension every organization is unlimited and this never throws.
 */
export function assertWithinLimit(
  ctx: Ctx,
  tx: Queryable,
  orgId: string,
  kind: LimitKind,
  delta = 1,
): Promise<void> {
  return ctx.ext.planLimits.assertWithin(tx, orgId, kind, delta);
}
