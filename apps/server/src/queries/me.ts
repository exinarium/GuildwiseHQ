import type { MeResponse } from '@aom/shared';
import { loadOrg, membershipsOf, type OrgRow, orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { one, rows } from '../db/sql.ts';
import { toUserDto } from '../dto.ts';
import { activeOrgDto } from '../orgs/summary.ts';

/**
 * Project ids the user can work in: active members of the project, minus the projects of organizations that are not
 * running (suspended or cancelled) unless the user is that organization's Owner.
 */
export const VISIBLE_PROJECTS_FOR_ME_SQL = `
  SELECT pm.project_id FROM project_members pm
    JOIN projects p ON p.id = pm.project_id
    LEFT JOIN organizations o ON o.id = p.org_id
   WHERE pm.user_id = $1 AND pm.status = 'active'
     AND (o.id IS NULL OR o.status IN ('trial','active') OR o.owner_user_id = $1)
   ORDER BY pm.project_id`;

/** Organizations where the user only holds project access (a guest), with those projects. */
export async function guestOrgs(ctx: Ctx, userId: string) {
  const r = await rows<{ org_id: string; org_name: string; id: string; key: string; name: string }>(
    ctx.pool,
    `SELECT p.org_id, o.name AS org_name, p.id, p.key, p.name FROM project_members pm
       JOIN projects p ON p.id = pm.project_id JOIN organizations o ON o.id = p.org_id
      WHERE pm.user_id = $1 AND pm.status = 'active' AND p.status = 'active' AND o.status IN ('trial','active')
        AND NOT EXISTS (SELECT 1 FROM org_members om WHERE om.org_id = p.org_id AND om.user_id = $1 AND om.status = 'active')
      ORDER BY o.name, p.key`,
    [userId],
  );
  const byOrg = new Map<
    string,
    { orgId: string; orgName: string; projects: Array<{ id: string; key: string; name: string }> }
  >();
  for (const x of r) {
    const g = byOrg.get(x.org_id) ?? { orgId: x.org_id, orgName: x.org_name, projects: [] };
    g.projects.push({ id: x.id, key: x.key, name: x.name });
    byOrg.set(x.org_id, g);
  }
  return [...byOrg.values()];
}

/**
 * The `me` response: the account, its organizations, the active organization of this request and the guest access.
 * `requestedOrg` is the tab's `X-AOM-Org`; a stale one (no longer a member) falls back to the default instead of failing,
 * so a tab can always recover.
 */
export async function buildMe(
  ctx: Ctx,
  session: AuthSession,
  requestedOrg: string | null,
): Promise<MeResponse> {
  const userId = session.user.id;
  const u = await one(ctx.pool, 'SELECT * FROM users WHERE id=$1', [userId]);
  const memberships = session.user.kind === 'super_admin' ? [] : await membershipsOf(ctx.pool, userId);
  const orgs = memberships.map((m) => ({ id: m.org_id, name: m.name, role: m.role, status: m.status }));
  const pick = [requestedOrg, session.activeOrgId, session.user.lastOrgId].find(
    (id) => id && memberships.some((m) => m.org_id === id),
  );
  const activeId = pick ?? memberships[0]?.org_id ?? null;
  let activeOrg: MeResponse['activeOrg'] = null;
  if (activeId) {
    const org = (await loadOrg(ctx.pool, activeId)) as OrgRow | null;
    const role = org ? await orgRoleOf(ctx.pool, userId, activeId) : null;
    if (org && role) activeOrg = await activeOrgDto(ctx, org, role);
  }
  const visible = await rows<{ project_id: string }>(ctx.pool, VISIBLE_PROJECTS_FOR_ME_SQL, [userId]);
  const guestIn = session.user.kind === 'super_admin' ? [] : await guestOrgs(ctx, userId);
  const pending = await one<{ n: number }>(
    ctx.pool,
    `SELECT (SELECT count(*) FROM invitations WHERE kind='org_member' AND status='pending' AND expires_at > $2
              AND lower(email) = lower($3))::int
          + (SELECT count(*) FROM project_members WHERE user_id=$1 AND status='invited')::int AS n`,
    [userId, ctx.clock.now(), session.user.email],
  );
  return {
    user: toUserDto(u as Record<string, any>),
    account: { kind: session.user.kind },
    isAdmin: activeOrg ? activeOrg.role === 'owner' || activeOrg.role === 'admin' : false,
    orgs,
    activeOrg,
    guestIn,
    guestProjectIds: guestIn.flatMap((g) => g.projects.map((p) => p.id)),
    visibleProjectIds: visible.map((v) => v.project_id),
    pendingInvitations: pending?.n ?? 0,
    twoFactor: session.twoFactor,
    features: { mockUi: ctx.config.mockUi },
  };
}
