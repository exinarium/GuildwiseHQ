import { sessionMac } from '../../src/auth/session-mac.ts';
import type { Ctx } from '../../src/context.ts';

/**
 * Re-seals session rows after a test changed their covered columns with SQL (release-readiness O5): `expires_at`,
 * `second_factor_at`, `user_id` or `method`. Without it the server refuses those rows as forged. Only for tests that
 * move the clock or make a session stale on purpose; a test of the seal itself never calls it. All rows, or one user's.
 */
export async function resealSessions(ctx: Pick<Ctx, 'pool' | 'config'>, userId?: string): Promise<number> {
  const r = await ctx.pool.query<{
    id: string;
    user_id: string;
    expires_at: Date;
    second_factor_at: Date | null;
    method: string | null;
  }>(
    `SELECT id, user_id, expires_at, second_factor_at, method FROM auth_sessions${userId ? ' WHERE user_id=$1' : ''}`,
    userId ? [userId] : [],
  );
  for (const s of r.rows) {
    const mac = await sessionMac(ctx, {
      id: s.id,
      userId: s.user_id,
      expiresAt: new Date(s.expires_at),
      secondFactorAt: s.second_factor_at ? new Date(s.second_factor_at) : null,
      method: s.method,
    });
    await ctx.pool.query('UPDATE auth_sessions SET mac=$2 WHERE id=$1', [s.id, mac]);
  }
  return r.rows.length;
}
