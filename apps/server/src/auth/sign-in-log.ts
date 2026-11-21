import type { FailedSignInsResponse, SecurityLogQuery, SignInsResponse } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { rows } from '../db/sql.ts';
import { currentLocks } from './login-guard.ts';
import { uaFamily } from './ua-family.ts';

/**
 * The two sign-in lists of Platform > Security (R2, R4): failed sign-ins (`login_failures`, with the locks in force)
 * and successful ones (`sign_ins`). Super admins only (the route guards it). The full user agent is never shown, only
 * the browser family plus OS.
 */

/** `q` matches an address (contains, case-insensitive) or an IP (prefix). */
const filter = (q: string | undefined) => (q ? q.toLowerCase() : null);

export async function failedSignIns(ctx: Ctx, query: SecurityLogQuery): Promise<FailedSignInsResponse> {
  const q = filter(query.q);
  const items = await rows<{
    id: string;
    at: Date;
    email_norm: string | null;
    user_id: string | null;
    display_name: string | null;
    ip: string | null;
    user_agent: string | null;
    reason: string;
  }>(
    ctx.pool,
    `SELECT f.id::text AS id, f.at, f.email_norm, f.user_id, u.display_name, f.ip, f.user_agent, f.reason
       FROM login_failures f LEFT JOIN users u ON u.id = f.user_id
      WHERE ($1::text IS NULL OR f.email_norm LIKE '%' || $1 || '%' OR f.ip LIKE $1 || '%')
      ORDER BY f.at DESC, f.id DESC LIMIT $2`,
    [q, query.limit],
  );
  const locks = await currentLocks(ctx);
  return {
    items: items.map((r) => ({
      id: r.id,
      at: new Date(r.at).toISOString(),
      email: r.email_norm,
      userId: r.user_id,
      displayName: r.display_name,
      ip: r.ip,
      uaFamily: r.user_agent ? uaFamily(r.user_agent) : null,
      reason: r.reason,
    })),
    locks: locks
      .filter((l) => !q || l.key.includes(q))
      .map((l) => ({ scope: l.scope, key: l.key, until: l.until.toISOString(), failures: l.failures })),
  };
}

export async function signIns(ctx: Ctx, query: SecurityLogQuery): Promise<SignInsResponse> {
  const q = filter(query.q);
  const items = await rows<{
    seq: string;
    at: Date;
    user_id: string;
    email: string | null;
    display_name: string | null;
    kind: string | null;
    method: string;
    ip: string | null;
    ua_family: string | null;
    new_device: boolean;
  }>(
    ctx.pool,
    `SELECT s.seq::text AS seq, s.at, s.user_id, u.email, u.display_name, u.kind, s.method, s.ip, s.ua_family, s.new_device
       FROM sign_ins s LEFT JOIN users u ON u.id = s.user_id
      WHERE ($1::text IS NULL OR lower(u.email) LIKE '%' || $1 || '%' OR s.ip LIKE $1 || '%')
      ORDER BY s.seq DESC LIMIT $2`,
    [q, query.limit],
  );
  return {
    items: items.map((r) => ({
      seq: r.seq,
      at: new Date(r.at).toISOString(),
      userId: r.user_id,
      email: r.email,
      displayName: r.display_name,
      kind: r.kind,
      method: r.method,
      ip: r.ip,
      uaFamily: r.ua_family,
      newDevice: r.new_device,
    })),
  };
}
