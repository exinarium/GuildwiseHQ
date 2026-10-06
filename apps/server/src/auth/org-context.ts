import {
  effectiveFeatures,
  isOrgOperational,
  ORG_ROLE_LABEL,
  type OrgFeature,
  type OrgRole,
  type OrgStatus,
  rankOf,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { exec, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { HttpError } from '../errors.ts';
import type { AuthSession } from './sessions.ts';

/** The tab's organization travels on every request (docs/design/organizations.md section 5). */
export const ORG_HEADER = 'x-aom-org';

export interface OrgRow extends Row {
  id: string;
  name: string;
  owner_user_id: string;
  status: OrgStatus;
  plan: string;
  features: Record<string, boolean>;
  require_two_factor: boolean;
}

/** A signed-in member acting in one organization. */
export interface OrgAccess {
  session: AuthSession;
  org: OrgRow;
  orgId: string;
  role: OrgRole;
}

export interface Membership {
  org_id: string;
  role: OrgRole;
  name: string;
  status: OrgStatus;
  joined_at: Date;
}

export async function membershipsOf(db: Queryable, userId: string): Promise<Membership[]> {
  return rows<Membership>(
    db,
    `SELECT om.org_id, om.role, o.name, o.status, om.joined_at FROM org_members om
       JOIN organizations o ON o.id = om.org_id
      WHERE om.user_id = $1 AND om.status = 'active' ORDER BY om.joined_at, o.name`,
    [userId],
  );
}

/** The user's active role in the organization, or null (not a member). */
export async function orgRoleOf(db: Queryable, userId: string, orgId: string): Promise<OrgRole | null> {
  const r = await one<{ role: OrgRole }>(
    db,
    `SELECT role FROM org_members WHERE org_id=$1 AND user_id=$2 AND status='active'`,
    [orgId, userId],
  );
  return r?.role ?? null;
}

export async function loadOrg(db: Queryable, orgId: string): Promise<OrgRow | null> {
  return ((await one(db, 'SELECT * FROM organizations WHERE id=$1', [orgId])) as OrgRow | undefined) ?? null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Header value of the request, if it is a well formed id. */
export function requestedOrgId(req: { headers: Record<string, unknown> }): string | null {
  const h = req.headers[ORG_HEADER];
  const v = Array.isArray(h) ? h[0] : h;
  return typeof v === 'string' && UUID_RE.test(v) ? v.toLowerCase() : null;
}

/**
 * The request's organization: the `X-AOM-Org` header (must be an active membership, else 403 `org_forbidden`), else the
 * session's remembered org, else the user's last org, else their oldest membership. Null: no membership at all
 * (a platform account).
 */
export async function resolveOrgId(
  ctx: Ctx,
  session: AuthSession,
  requested: string | null,
): Promise<string | null> {
  const mine = await membershipsOf(ctx.pool, session.user.id);
  if (requested) {
    if (!mine.some((m) => m.org_id === requested))
      throw new HttpError(403, 'org_forbidden', 'you are not a member of that organization');
    return requested;
  }
  for (const candidate of [session.activeOrgId, session.user.lastOrgId]) {
    if (candidate && mine.some((m) => m.org_id === candidate)) return candidate;
  }
  return mine[0]?.org_id ?? null;
}

/** Remembers the org as the default for this session and the user (operational, no event). */
export async function rememberActiveOrg(ctx: Ctx, session: AuthSession, orgId: string): Promise<void> {
  await exec(ctx.pool, 'UPDATE auth_sessions SET active_org_id=$2 WHERE id=$1', [session.sessionId, orgId]);
  await exec(ctx.pool, 'UPDATE users SET last_org_id=$2 WHERE id=$1', [session.user.id, orgId]);
}

export function orgSuspended(org: Pick<OrgRow, 'name' | 'status'>, ownerName?: string): HttpError {
  return new HttpError(
    403,
    'org_suspended',
    `Your organization ${org.name} is ${org.status}.${ownerName ? ` Contact ${ownerName}.` : ''}`,
  );
}

export function featureEnabled(org: Pick<OrgRow, 'plan' | 'features'>, key: OrgFeature): boolean {
  return effectiveFeatures(org.plan, org.features)[key];
}

/** 403 `feature_disabled` when the organization's plan or flags have the feature off. */
export function requireFeature(org: Pick<OrgRow, 'plan' | 'features'>, key: OrgFeature): void {
  if (!featureEnabled(org, key))
    throw new HttpError(403, 'feature_disabled', `${key} is not enabled for this organization`);
}

export interface RequireOrgOptions {
  /** Lowest role allowed (default: any member). */
  min?: OrgRole;
  feature?: OrgFeature;
}

/** Builds the access from a session and an org id; shared by the guard and the WebSocket gateway. */
export async function orgAccessFor(
  ctx: Ctx,
  session: AuthSession,
  orgId: string,
  opts: RequireOrgOptions = {},
): Promise<OrgAccess> {
  const org = await loadOrg(ctx.pool, orgId);
  const role = org ? await orgRoleOf(ctx.pool, session.user.id, orgId) : null;
  if (!org || !role) throw new HttpError(403, 'org_forbidden', 'you are not a member of that organization');
  // A suspended or cancelled organization: only its Owner gets in (read access, settings, members).
  if (!isOrgOperational(org.status) && role !== 'owner') {
    const owner = await one<{ display_name: string }>(
      ctx.pool,
      'SELECT display_name FROM users WHERE id=$1',
      [org.owner_user_id],
    );
    throw orgSuspended(org, owner?.display_name);
  }
  if (opts.min && rankOf(role, false) < rankOf(opts.min, false))
    throw new HttpError(403, 'org_role_required', `this needs the ${ORG_ROLE_LABEL[opts.min]} role`);
  if (opts.feature) requireFeature(org, opts.feature);
  return { session, org, orgId, role };
}
