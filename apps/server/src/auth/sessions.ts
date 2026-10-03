import type { Ctx } from '../context.ts';
import { randomToken, sha256Hex } from '../crypto.ts';
import { exec, one } from '../db/sql.ts';

export const SESSION_COOKIE = 'aom_sid';
const ABSOLUTE_MS = 30 * 24 * 3600_000;
const IDLE_MS = 7 * 24 * 3600_000;
const TOUCH_MS = 5 * 60_000;

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'member';
  status: 'active' | 'deactivated';
  createdAt: Date;
  lastLoginAt: Date | null;
}

export interface AuthSession {
  sessionId: string;
  user: SessionUser;
}

export async function createSession(
  ctx: Ctx,
  userId: string,
  meta: { userAgent?: string; ip?: string } = {},
): Promise<{ token: string; maxAgeSec: number }> {
  const token = randomToken(32);
  const now = ctx.clock.now();
  await exec(
    ctx.pool,
    `INSERT INTO auth_sessions (id, user_id, created_at, last_seen_at, expires_at, user_agent, ip)
     VALUES ($1,$2,$3,$3,$4,$5,$6)`,
    [
      sha256Hex(token),
      userId,
      now,
      new Date(now.getTime() + ABSOLUTE_MS),
      meta.userAgent ?? null,
      meta.ip ?? null,
    ],
  );
  await exec(ctx.pool, 'UPDATE users SET last_login_at=$2 WHERE id=$1', [userId, now]);
  return { token, maxAgeSec: ABSOLUTE_MS / 1000 };
}

/** Returns the session for a cookie token, or null if unknown/expired/idle/deactivated. Slides `last_seen_at`. */
export async function lookupSession(ctx: Ctx, token: string | undefined): Promise<AuthSession | null> {
  if (!token) return null;
  const id = sha256Hex(token);
  const r = await one(
    ctx.pool,
    `SELECT s.id AS sid, s.last_seen_at, s.expires_at, u.id, u.email, u.display_name, u.role, u.status,
            u.created_at, u.last_login_at
       FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
    [id],
  );
  if (!r) return null;
  const now = ctx.clock.now();
  if (
    new Date(r.expires_at) <= now ||
    now.getTime() - new Date(r.last_seen_at).getTime() > IDLE_MS ||
    r.status !== 'active'
  ) {
    if (r.status !== 'active' || new Date(r.expires_at) <= now) await deleteSession(ctx, id);
    return null;
  }
  if (now.getTime() - new Date(r.last_seen_at).getTime() > TOUCH_MS) {
    await exec(ctx.pool, 'UPDATE auth_sessions SET last_seen_at=$2 WHERE id=$1', [id, now]);
  }
  return {
    sessionId: id,
    user: {
      id: r.id,
      email: r.email,
      displayName: r.display_name,
      role: r.role,
      status: r.status,
      createdAt: new Date(r.created_at),
      lastLoginAt: r.last_login_at ? new Date(r.last_login_at) : null,
    },
  };
}

export const deleteSession = (ctx: Ctx, sessionId: string) =>
  exec(ctx.pool, 'DELETE FROM auth_sessions WHERE id=$1', [sessionId]);
