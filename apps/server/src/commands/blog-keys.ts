import { randomUUID } from 'node:crypto';
import { type ApiKey, BLOG_LIMITS, type BlogApiScope } from '@aom/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { randomToken, sha256Hex } from '../crypto.ts';
import { exec, iso, one, type Row, rows } from '../db/sql.ts';
import { HttpError, notFound } from '../errors.ts';
import { userActor } from './common.ts';

/**
 * Super-admin managed API keys for the blog agents. A key is `gwk_` plus 32 random
 * bytes; only its sha256 is stored (a high-entropy secret needs no slow hash), the secret is shown once at creation.
 * Every request is logged (`blog_api_log`), which is both the audit trail and what the rate limits count.
 */

const adminScope = { orgId: null, projectId: null, audience: 'admin' } as const;
const HOUR = 3600_000;

export interface ApiKeyAuth {
  id: string;
  name: string;
  scopes: BlogApiScope[];
}

function keyDto(r: Row, counts: { requests24h: number; posts24h: number }): ApiKey {
  return {
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    scopes: r.scopes,
    createdAt: iso(r.created_at) as string,
    expiresAt: iso(r.expires_at),
    revokedAt: iso(r.revoked_at),
    lastUsedAt: iso(r.last_used_at),
    lastIp: r.last_ip ?? null,
    ipAllowList: r.ip_allow_list ?? [],
    ...counts,
  };
}

export async function listApiKeys(ctx: Ctx): Promise<ApiKey[]> {
  const since = new Date(ctx.clock.now().getTime() - 24 * HOUR);
  const rs = await rows(
    ctx.pool,
    `SELECT k.*,
       (SELECT count(*)::int FROM blog_api_log l WHERE l.key_id = k.id AND l.at >= $1) AS requests24h,
       (SELECT count(*)::int FROM blog_api_log l WHERE l.key_id = k.id AND l.at >= $1 AND l.is_post) AS posts24h
     FROM blog_api_keys k ORDER BY k.created_at DESC`,
    [since],
  );
  return rs.map((r) => keyDto(r, { requests24h: r.requests24h, posts24h: r.posts24h }));
}

export async function createApiKey(
  ctx: Ctx,
  by: AuthSession['user'],
  input: {
    name: string;
    scopes: BlogApiScope[];
    expiresAt?: string | null | undefined;
    ipAllowList: string[];
  },
): Promise<ApiKey & { secret: string }> {
  const secret = `gwk_${randomToken(32)}`;
  const id = randomUUID();
  const prefix = secret.slice(0, 8);
  // `blog:write` implies reading; `blog:publish` implies writing's visibility, but is granted explicitly
  const scopes = [...new Set(input.scopes)];
  await exec(
    ctx.pool,
    `INSERT INTO blog_api_keys (id, name, prefix, key_hash, scopes, ip_allow_list, created_by, created_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id,
      input.name,
      prefix,
      sha256Hex(secret),
      scopes,
      input.ipAllowList,
      by.id,
      ctx.clock.now(),
      input.expiresAt ?? null,
    ],
  );
  await ctx.store.append([
    {
      streamId: `apikey-${id}`,
      event: {
        type: 'ApiKeyCreated',
        payload: {
          keyId: id,
          name: input.name,
          scopes,
          prefix,
          expiresAt: input.expiresAt ?? null,
          by: by.id,
        },
      },
      actor: userActor(by.id),
      scope: adminScope,
    },
  ]);
  const r = (await one(ctx.pool, 'SELECT * FROM blog_api_keys WHERE id=$1', [id])) as Row;
  return { ...keyDto(r, { requests24h: 0, posts24h: 0 }), secret };
}

export async function revokeApiKey(ctx: Ctx, by: AuthSession['user'], id: string): Promise<void> {
  const n = await exec(
    ctx.pool,
    'UPDATE blog_api_keys SET revoked_at=$2 WHERE id=$1 AND revoked_at IS NULL',
    [id, ctx.clock.now()],
  );
  if (!n) {
    if (!(await one(ctx.pool, 'SELECT 1 FROM blog_api_keys WHERE id=$1', [id])))
      throw notFound('key not found');
    return;
  }
  await ctx.store.append([
    {
      streamId: `apikey-${id}`,
      event: { type: 'ApiKeyRevoked', payload: { keyId: id, by: by.id } },
      actor: userActor(by.id),
      scope: adminScope,
    },
  ]);
}

export async function apiKeyAudit(ctx: Ctx, limit = 100) {
  const rs = await rows(
    ctx.pool,
    `SELECT l.*, k.name FROM blog_api_log l JOIN blog_api_keys k ON k.id = l.key_id ORDER BY l.at DESC, l.id DESC LIMIT $1`,
    [Math.min(limit, 500)],
  );
  return rs.map((r) => ({
    at: iso(r.at) as string,
    keyId: r.key_id as string,
    keyName: r.name as string,
    method: r.method as string,
    path: r.path as string,
    status: r.status as number,
    ip: (r.ip ?? null) as string | null,
  }));
}

// ---- request authentication

const marks = new WeakMap<FastifyRequest, { logId: string }>();

/** Called by a handler that accepted a brand-new post: it counts to the 24 h cap. */
export async function markPostCreated(ctx: Ctx, req: FastifyRequest): Promise<void> {
  const m = marks.get(req);
  if (m) await exec(ctx.pool, 'UPDATE blog_api_log SET is_post=true WHERE id=$1', [m.logId]);
}

const rateLimited = (message: string, retryAfter: number) =>
  new HttpError(429, 'rate_limited', message, { retryAfterSeconds: retryAfter });

/**
 * Checks the Bearer key: unknown 401 `invalid_key`, revoked 401 `key_revoked`, expired 401 `key_expired`, wrong IP
 * 403 `ip_not_allowed`, missing scope 403 `insufficient_scope`, then the rate limits (reads per minute, writes per
 * hour). Session cookies are never looked at on these routes.
 */
export async function authenticateKey(
  ctx: Ctx,
  req: FastifyRequest,
  reply: FastifyReply,
  scope: BlogApiScope | BlogApiScope[],
  opts: { write?: boolean } = {},
): Promise<ApiKeyAuth> {
  const h = String(req.headers.authorization ?? '');
  const m = /^Bearer\s+(gwk_[A-Za-z0-9_-]{20,})$/.exec(h);
  if (!m) throw new HttpError(401, 'invalid_key', 'send the API key as "Authorization: Bearer gwk_..."');
  const k = await one(ctx.pool, 'SELECT * FROM blog_api_keys WHERE key_hash=$1', [sha256Hex(m[1] as string)]);
  if (!k) throw new HttpError(401, 'invalid_key', 'unknown API key');
  const now = ctx.clock.now();
  if (k.revoked_at) throw new HttpError(401, 'key_revoked', 'this API key was revoked');
  if (k.expires_at && new Date(k.expires_at) <= now)
    throw new HttpError(401, 'key_expired', 'this API key has expired');
  if ((k.ip_allow_list as string[]).length && !(k.ip_allow_list as string[]).includes(req.ip))
    throw new HttpError(403, 'ip_not_allowed', 'this key may not be used from this address');
  const have = new Set(k.scopes as string[]);
  // blog:write and blog:publish include reading
  if (have.has('blog:write') || have.has('blog:publish')) have.add('blog:read');
  const need = Array.isArray(scope) ? scope : [scope];
  if (!need.every((s) => have.has(s)))
    throw new HttpError(403, 'insufficient_scope', `this key needs the scope ${need.join(' and ')}`);

  const isWrite = !!opts.write;
  if (isWrite) {
    const n = (
      await one(
        ctx.pool,
        `SELECT count(*)::int AS n FROM blog_api_log WHERE key_id=$1 AND is_write AND at >= $2`,
        [k.id, new Date(now.getTime() - HOUR)],
      )
    )?.n as number;
    if (n >= BLOG_LIMITS.writesPerHour) {
      void reply.header('retry-after', '600');
      throw rateLimited(`at most ${BLOG_LIMITS.writesPerHour} writes per hour per key`, 600);
    }
  } else {
    const n = (
      await one(
        ctx.pool,
        `SELECT count(*)::int AS n FROM blog_api_log WHERE key_id=$1 AND NOT is_write AND at >= $2`,
        [k.id, new Date(now.getTime() - 60_000)],
      )
    )?.n as number;
    if (n >= BLOG_LIMITS.readsPerMinute) {
      void reply.header('retry-after', '30');
      throw rateLimited(`at most ${BLOG_LIMITS.readsPerMinute} reads per minute per key`, 30);
    }
  }
  await exec(ctx.pool, 'UPDATE blog_api_keys SET last_used_at=$2, last_ip=$3 WHERE id=$1', [
    k.id,
    now,
    req.ip,
  ]);
  // The audit row is written up front (so the next request counts it at once); the status is filled in on response.
  const log = await one(
    ctx.pool,
    `INSERT INTO blog_api_log (key_id, at, method, path, status, ip, is_write) VALUES ($1,$2,$3,$4,0,$5,$6) RETURNING id`,
    [k.id, now, req.method, (req.url.split('?')[0] ?? '').slice(0, 200), req.ip, isWrite],
  );
  marks.set(req, { logId: String(log?.id) });
  return { id: k.id, name: k.name, scopes: [...have] as BlogApiScope[] };
}

/** The hard cap: at most `postsPer24h` new posts per key in a rolling 24 hours. */
export async function assertPostCap(ctx: Ctx, keyId: string, reply: FastifyReply): Promise<void> {
  const since = new Date(ctx.clock.now().getTime() - 24 * HOUR);
  const n = (
    await one(
      ctx.pool,
      `SELECT count(*)::int AS n FROM blog_api_log WHERE key_id=$1 AND is_post AND at >= $2`,
      [keyId, since],
    )
  )?.n as number;
  if (n >= BLOG_LIMITS.postsPer24h) {
    void reply.header('retry-after', '3600');
    throw rateLimited(
      `this key already submitted ${BLOG_LIMITS.postsPer24h} posts in the last 24 hours`,
      3600,
    );
  }
}

/** Fills in the response status of the audit row (an onResponse hook). */
export async function logApiRequest(ctx: Ctx, req: FastifyRequest, status: number): Promise<void> {
  const m = marks.get(req);
  if (!m) return;
  marks.delete(req);
  try {
    await exec(ctx.pool, 'UPDATE blog_api_log SET status=$2 WHERE id=$1', [m.logId, status]);
  } catch (err) {
    ctx.log.error({ err }, 'api log write failed');
  }
}
