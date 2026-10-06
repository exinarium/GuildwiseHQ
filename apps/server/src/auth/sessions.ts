import type { Ctx } from '../context.ts';
import { randomToken, sha256Hex } from '../crypto.ts';
import { exec, one } from '../db/sql.ts';

export const SESSION_COOKIE = 'aom_sid';
const ABSOLUTE_MS = 30 * 24 * 3600_000;
const IDLE_MS = 7 * 24 * 3600_000;
/** Super admin sessions are short: absolute 12 h, idle 1 h (docs/design/organizations.md section 5). */
const SUPER_ADMIN_ABSOLUTE_MS = 12 * 3600_000;
const SUPER_ADMIN_IDLE_MS = 3600_000;
const TOUCH_MS = 5 * 60_000;

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  /** The retired app-wide role (still read by the legacy /api/admin routes until they go). */
  role: 'admin' | 'member';
  kind: 'user' | 'super_admin';
  status: 'active' | 'deactivated';
  createdAt: Date;
  lastLoginAt: Date | null;
  lastOrgId: string | null;
}

export interface SessionTwoFactor {
  enabled: boolean;
  /** Super admin, or a member of an organization whose Owner requires it. */
  required: boolean;
  /** Required and not set up yet: the session reaches the setup endpoints only. */
  setupRequired: boolean;
}

export interface AuthSession {
  sessionId: string;
  user: SessionUser;
  /** The organization remembered for this session (the request header wins). */
  activeOrgId: string | null;
  twoFactor: SessionTwoFactor;
}

export async function createSession(
  ctx: Ctx,
  userId: string,
  meta: { userAgent?: string; ip?: string } = {},
): Promise<{ token: string; maxAgeSec: number }> {
  const token = randomToken(32);
  const now = ctx.clock.now();
  const u = await one<{ kind: string; last_org_id: string | null }>(
    ctx.pool,
    'SELECT kind, last_org_id FROM users WHERE id=$1',
    [userId],
  );
  const absolute = u?.kind === 'super_admin' ? SUPER_ADMIN_ABSOLUTE_MS : ABSOLUTE_MS;
  await exec(
    ctx.pool,
    `INSERT INTO auth_sessions (id, user_id, created_at, last_seen_at, expires_at, user_agent, ip, active_org_id)
     VALUES ($1,$2,$3,$3,$4,$5,$6,$7)`,
    [
      sha256Hex(token),
      userId,
      now,
      new Date(now.getTime() + absolute),
      meta.userAgent ?? null,
      meta.ip ?? null,
      u?.last_org_id ?? null,
    ],
  );
  await exec(ctx.pool, 'UPDATE users SET last_login_at=$2 WHERE id=$1', [userId, now]);
  return { token, maxAgeSec: absolute / 1000 };
}

/** Returns the session for a cookie token, or null if unknown/expired/idle/deactivated. Slides `last_seen_at`. */
export async function lookupSession(ctx: Ctx, token: string | undefined): Promise<AuthSession | null> {
  if (!token) return null;
  const id = sha256Hex(token);
  const r = await one(
    ctx.pool,
    `SELECT s.id AS sid, s.last_seen_at, s.expires_at, s.active_org_id, u.id, u.email, u.display_name, u.legacy_role,
            u.kind, u.status, u.created_at, u.last_login_at, u.last_org_id, u.two_factor_enabled,
            ${TWO_FACTOR_REQUIRED_SQL} AS two_factor_required
       FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
    [id],
  );
  if (!r) return null;
  const now = ctx.clock.now();
  const idle = r.kind === 'super_admin' ? SUPER_ADMIN_IDLE_MS : IDLE_MS;
  if (
    new Date(r.expires_at) <= now ||
    now.getTime() - new Date(r.last_seen_at).getTime() > idle ||
    r.status !== 'active'
  ) {
    if (r.status !== 'active' || new Date(r.expires_at) <= now) await deleteSession(ctx, id);
    return null;
  }
  if (now.getTime() - new Date(r.last_seen_at).getTime() > TOUCH_MS) {
    await exec(ctx.pool, 'UPDATE auth_sessions SET last_seen_at=$2 WHERE id=$1', [id, now]);
  }
  return toSession(r, id);
}

const TWO_FACTOR_REQUIRED_SQL = `(u.kind = 'super_admin' OR EXISTS (
     SELECT 1 FROM org_members om JOIN organizations o ON o.id = om.org_id
      WHERE om.user_id = u.id AND om.status = 'active' AND o.require_two_factor AND o.status IN ('trial','active')))`;

function toSession(r: Record<string, any>, sessionId: string): AuthSession {
  const enabled = Boolean(r.two_factor_enabled);
  const required = Boolean(r.two_factor_required);
  return {
    sessionId,
    activeOrgId: r.active_org_id ?? null,
    twoFactor: { enabled, required, setupRequired: required && !enabled },
    user: {
      id: r.id,
      email: r.email,
      displayName: r.display_name,
      role: r.legacy_role ?? 'member',
      kind: r.kind,
      status: r.status,
      createdAt: new Date(r.created_at),
      lastLoginAt: r.last_login_at ? new Date(r.last_login_at) : null,
      lastOrgId: r.last_org_id ?? null,
    },
  };
}

/** The user's account part of a session (no cookie): for responses built right after login, accept or setup. */
export async function sessionOfUser(ctx: Ctx, userId: string): Promise<AuthSession> {
  const r = await one(
    ctx.pool,
    `SELECT NULL::text AS active_org_id, u.id, u.email, u.display_name, u.legacy_role, u.kind, u.status, u.created_at,
            u.last_login_at, u.last_org_id, u.two_factor_enabled, ${TWO_FACTOR_REQUIRED_SQL} AS two_factor_required
       FROM users u WHERE u.id = $1`,
    [userId],
  );
  if (!r) throw new Error('user not found');
  return toSession(r, '');
}

export const deleteSession = (ctx: Ctx, sessionId: string) =>
  exec(ctx.pool, 'DELETE FROM auth_sessions WHERE id=$1', [sessionId]);
