import { isIP } from 'node:net';
import { type LoginFailureReason, TOO_MANY_ATTEMPTS } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { exec, one, type Queryable, rows } from '../db/sql.ts';
import { HttpError } from '../errors.ts';
import { accountLockedMail } from '../mail/templates.ts';
import { ipMatches } from './address-policy.ts';
import { claimSecurityNotice, sendSecurityMail } from './security-mail.ts';
import { uaFamily } from './ua-family.ts';

/**
 * Sign-in protection (R2). Every failed sign-in, step-up and reset second factor is a `login_failures` row (operational,
 * kept 90 days), and so are the guard's own decisions (`locked`, `blocked`) and the `cleared` marks that end an account
 * lock. The lock rules (account: 5 failures, 15 min doubling up to 60; IP: 20 in 15 min, 100 in 24 h; the exemptions)
 * live in `checkLoginGuard`.
 */

/** Normalized email key: trimmed and lower-cased, so an unknown address behaves exactly like a known one. */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export interface LoginFailureInput {
  reason: LoginFailureReason;
  /** The address typed (normalized here); null for a failure without one (a step-up by session). */
  email?: string | null | undefined;
  userId?: string | null | undefined;
  ip?: string | null | undefined;
  userAgent?: string | null | undefined;
}

/** A valid address as stored in `login_failures.ip`: zone removed, lower-cased; anything else is not stored (null). */
export function normalizeIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const a = (ip.trim().split('%')[0] ?? '').toLowerCase();
  return isIP(a) ? a : null;
}

/** Records one row in `login_failures`. Use `db` to write inside a caller's transaction. */
export async function recordLoginFailure(
  ctx: Ctx,
  input: LoginFailureInput,
  db: Queryable = ctx.pool,
): Promise<void> {
  await exec(
    db,
    `INSERT INTO login_failures (at, email_norm, user_id, ip, user_agent, reason) VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      ctx.clock.now(),
      input.email ? normalizeEmail(input.email) : null,
      input.userId ?? null,
      normalizeIp(input.ip),
      input.userAgent ? input.userAgent.slice(0, 400) : null,
      input.reason,
    ],
  );
}

/** The guard's answer before a password is checked. */
export type LoginGuardDecision =
  | { locked: false }
  | { locked: true; scope: 'account' | 'ip'; retryAfterSec: number };

/** The reasons that count towards a lock: wrong answers. The guard's own rows (`locked`, `blocked`) and `cleared` never do. */
export const COUNTED_REASONS: LoginFailureReason[] = [
  'password',
  'second_factor',
  'step_up',
  'reset_second_factor',
];

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
export const ACCOUNT_LOCK_AFTER = 5;
const ACCOUNT_LOCK_BASE_MS = 15 * MIN;
const ACCOUNT_LOCK_MAX_MS = 60 * MIN;
const ACCOUNT_WINDOW_MS = DAY;
const KNOWN_DEVICE_MS = 30 * DAY;
const IP_SHORT = { count: 20, windowMs: 15 * MIN, lockMs: 15 * MIN };
const IP_LONG = { count: 100, windowMs: DAY, lockMs: DAY };
export const LOGIN_FAILURE_RETENTION_MS = 90 * DAY;
const LOCK_NOTICE_MS = DAY;

/** Account lock length for `n` failures (n >= 5): 15 min x 2^(n-5), at most 60 min. */
export const accountLockMs = (n: number): number =>
  Math.min(ACCOUNT_LOCK_BASE_MS * 2 ** Math.max(0, n - ACCOUNT_LOCK_AFTER), ACCOUNT_LOCK_MAX_MS);

/** Loopback, RFC 1918 and ULA ranges: never IP-locked (exemption c), nor anything `AOM_TRUST_PROXY` lists. */
const PRIVATE_RANGES = [
  '127.0.0.0/8',
  '::1/128',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  'fc00::/7',
];

const plainIp = (ip: string): string => (ip.toLowerCase().startsWith('::ffff:') ? ip.slice(7) : ip);

/** Whether an IP is exempt from the IP lock (exemption c): a proxy we trust, loopback, a private or ULA address. */
export function ipLockExempt(ctx: Ctx, ip: string): boolean {
  const a = plainIp(ip);
  const tp = ctx.config.trustProxy;
  const trusted = tp.kind === 'addresses' ? tp.addresses : [];
  return [...PRIVATE_RANGES, ...trusted].some((r) => ipMatches(a, r));
}

const retryAfter = (until: number, now: number) => Math.max(1, Math.ceil((until - now) / 1000));

/**
 * The key an IP lock counts by: an IPv4 address as itself (an IPv4-mapped IPv6 address counts as its IPv4 address); an
 * IPv6 address by its /64, because one client usually holds a whole /64 and could otherwise rotate through it
 * (`2001:db8:1:2::/64`).
 */
export function ipLockKey(ip: string): string {
  const a = plainIp(ip.split('%')[0] ?? ip);
  if (isIP(a) !== 6 || a.includes('.')) return a;
  const [head = '', tail = ''] = a.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = a.includes('::') ? (tail ? tail.split(':') : []) : [];
  const groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/** SQL condition (with `$1` = the key) for the failure rows an IP lock key covers. */
const ipKeyWhere = (key: string): string =>
  key.endsWith('/64')
    ? // CASE keeps the cast from ever seeing a value that is not an address (an old or hand-written row)
      `ip ~ ':' AND ip NOT ILIKE '::ffff:%' AND CASE WHEN pg_input_is_valid(ip, 'inet') THEN ip::inet <<= $1::inet ELSE false END`
    : `(ip = $1 OR ip = '::ffff:' || $1)`;

/** The IP lock on its own (20 failures in 15 min lock 15 min; 100 in 24 h lock 24 h), counted per `ipLockKey`. */
async function ipLock(
  ctx: Ctx,
  key: string,
  now: number,
): Promise<{ until: number; failures: number } | null> {
  const r = await one<{ n15: number; last15: Date | null; n24: number; last24: Date | null }>(
    ctx.pool,
    `SELECT count(*) FILTER (WHERE at > $3)::int AS n15, max(at) FILTER (WHERE at > $3) AS last15,
            count(*)::int AS n24, max(at) AS last24
       FROM login_failures WHERE at > $2 AND reason = ANY($4) AND ${ipKeyWhere(key)}`,
    [key, new Date(now - IP_LONG.windowMs), new Date(now - IP_SHORT.windowMs), COUNTED_REASONS],
  );
  if (!r) return null;
  let until = 0;
  if (r.n24 >= IP_LONG.count && r.last24)
    until = Math.max(until, new Date(r.last24).getTime() + IP_LONG.lockMs);
  if (r.n15 >= IP_SHORT.count && r.last15)
    until = Math.max(until, new Date(r.last15).getTime() + IP_SHORT.lockMs);
  return until > now ? { until, failures: Math.max(r.n15, r.n24) } : null;
}

/**
 * The account lock on its own, keyed by the normalized address (an unknown address behaves the same): failures since the
 * latest of the last successful sign-in, the latest `cleared` row and 24 h ago; at 5 or more, locked for
 * 15 min x 2^(n-5) (capped at 60) after the latest failure.
 */
async function accountLock(
  ctx: Ctx,
  emailNorm: string,
  userId: string | null,
  now: number,
): Promise<{ until: number; failures: number } | null> {
  const lastOk = userId
    ? await one<{ at: Date | null }>(ctx.pool, 'SELECT max(at) AS at FROM sign_ins WHERE user_id=$1', [
        userId,
      ])
    : null;
  const lastClear = await one<{ at: Date | null }>(
    ctx.pool,
    `SELECT max(at) AS at FROM login_failures WHERE email_norm=$1 AND reason='cleared' AND at > $2`,
    [emailNorm, new Date(now - ACCOUNT_WINDOW_MS)],
  );
  const since = Math.max(
    now - ACCOUNT_WINDOW_MS,
    lastOk?.at ? new Date(lastOk.at).getTime() : 0,
    lastClear?.at ? new Date(lastClear.at).getTime() : 0,
  );
  const f = await one<{ n: number; last: Date | null }>(
    ctx.pool,
    `SELECT count(*)::int AS n, max(at) AS last FROM login_failures
      WHERE email_norm=$1 AND at > $2 AND reason = ANY($3)`,
    [emailNorm, new Date(since), COUNTED_REASONS],
  );
  if (!f || f.n < ACCOUNT_LOCK_AFTER || !f.last) return null;
  const until = new Date(f.last).getTime() + accountLockMs(f.n);
  return until > now ? { until, failures: f.n } : null;
}

const userIdOf = async (ctx: Ctx, emailNorm: string): Promise<string | null> =>
  (await one<{ id: string }>(ctx.pool, 'SELECT id FROM users WHERE lower(email)=$1', [emailNorm]))?.id ??
  null;

/** Exemption (a): this IP plus browser family signed in to the account successfully in the last 30 days. */
async function knownDevice(
  ctx: Ctx,
  userId: string,
  ip: string | null,
  userAgent: string | null | undefined,
  now: number,
): Promise<boolean> {
  if (!ip) return false;
  return !!(await one(
    ctx.pool,
    `SELECT 1 FROM sign_ins WHERE user_id=$1 AND ip=$2 AND ua_family=$3 AND at > $4 LIMIT 1`,
    [userId, ip, uaFamily(userAgent), new Date(now - KNOWN_DEVICE_MS)],
  ));
}

/**
 * Checked before the password (R2). `AOM_LOGIN_LOCKOUT=false` switches the guard off. The IP lock never applies to the
 * exempt addresses (c); the account lock never applies to a known device (a); a completed reset or the CLI reset ends it
 * (b, a `cleared` row).
 */
export async function checkLoginGuard(
  ctx: Ctx,
  input: { email: string; ip: string | null; userAgent?: string | null | undefined },
): Promise<LoginGuardDecision> {
  if (!ctx.config.loginLockout) return { locked: false };
  const now = ctx.clock.now().getTime();
  if (input.ip && !ipLockExempt(ctx, input.ip)) {
    const l = await ipLock(ctx, ipLockKey(input.ip), now);
    if (l) return { locked: true, scope: 'ip', retryAfterSec: retryAfter(l.until, now) };
  }
  const emailNorm = normalizeEmail(input.email);
  const userId = await userIdOf(ctx, emailNorm);
  if (userId && (await knownDevice(ctx, userId, input.ip, input.userAgent, now))) return { locked: false };
  const l = await accountLock(ctx, emailNorm, userId, now);
  if (l) return { locked: true, scope: 'account', retryAfterSec: retryAfter(l.until, now) };
  return { locked: false };
}

/**
 * The guard as the routes use it: a lock records `locked` and throws 429 `too_many_attempts {retryAfterSec}`; the
 * password is then never checked.
 */
export async function enforceLoginGuard(
  ctx: Ctx,
  input: { email: string; ip: string | null; userAgent?: string | null | undefined },
): Promise<void> {
  const d = await checkLoginGuard(ctx, input);
  if (!d.locked) return;
  await recordLoginFailure(ctx, {
    reason: 'locked',
    email: input.email,
    userId: await userIdOf(ctx, normalizeEmail(input.email)),
    ip: input.ip,
    userAgent: input.userAgent,
  });
  throw new HttpError(
    429,
    TOO_MANY_ATTEMPTS,
    d.scope === 'ip'
      ? 'too many failed sign-ins from this address: try again later'
      : 'too many failed sign-ins for this account: try again later, or reset your password',
    { retryAfterSec: d.retryAfterSec, scope: d.scope },
  );
}

/**
 * Records a wrong answer. When the account is locked after it, its open login challenges are deleted and its owner is
 * mailed (at most once per account per 24 h, exemption d). Unknown addresses are recorded the same way and mail nobody.
 */
export async function recordFailedSignIn(ctx: Ctx, input: LoginFailureInput): Promise<void> {
  await recordLoginFailure(ctx, input);
  if (!ctx.config.loginLockout || !input.email) return;
  try {
    const emailNorm = normalizeEmail(input.email);
    const userId = input.userId ?? (await userIdOf(ctx, emailNorm));
    if (!userId) return;
    const now = ctx.clock.now().getTime();
    const l = await accountLock(ctx, emailNorm, userId, now);
    if (!l) return;
    // A lock ends every half-finished two-factor sign-in of the account: no challenge outlives it.
    await exec(ctx.pool, 'DELETE FROM login_challenges WHERE user_id=$1', [userId]);
    if (!(await claimSecurityNotice(ctx, userId, 'login_locked', LOCK_NOTICE_MS))) return;
    const u = await one<{ email: string; display_name: string }>(
      ctx.pool,
      'SELECT email, display_name FROM users WHERE id=$1',
      [userId],
    );
    if (u)
      await sendSecurityMail(
        ctx,
        accountLockedMail({
          to: u.email,
          name: u.display_name,
          until: new Date(l.until),
          failures: l.failures,
          origin: ctx.config.publicOrigin,
        }),
      );
  } catch (err) {
    ctx.log.warn({ err }, 'lock notice failed');
  }
}

/** Ends an account lock (exemption b): a completed reset or `superadmin:reset-password`. */
export async function clearLoginLock(
  ctx: Ctx,
  input: { email: string; userId: string; ip?: string | null | undefined },
  db: Queryable = ctx.pool,
): Promise<void> {
  await recordLoginFailure(
    ctx,
    { reason: 'cleared', email: input.email, userId: input.userId, ip: input.ip },
    db,
  );
}

/** The locks in force right now, for the Security page (the exemptions of a particular device are not applied). */
export async function currentLocks(
  ctx: Ctx,
): Promise<Array<{ scope: 'account' | 'ip'; key: string; until: Date; failures: number }>> {
  const now = ctx.clock.now().getTime();
  const out: Array<{ scope: 'account' | 'ip'; key: string; until: Date; failures: number }> = [];
  const emails = await rows<{ email_norm: string }>(
    ctx.pool,
    `SELECT email_norm FROM login_failures WHERE email_norm IS NOT NULL AND at > $1 AND reason = ANY($2)
      GROUP BY email_norm HAVING count(*) >= $3 ORDER BY max(at) DESC LIMIT 100`,
    [new Date(now - ACCOUNT_WINDOW_MS), COUNTED_REASONS, ACCOUNT_LOCK_AFTER],
  );
  for (const e of emails) {
    const l = await accountLock(ctx, e.email_norm, await userIdOf(ctx, e.email_norm), now);
    if (l) out.push({ scope: 'account', key: e.email_norm, until: new Date(l.until), failures: l.failures });
  }
  const ips = await rows<{ ip: string; n: number }>(
    ctx.pool,
    `SELECT ip, count(*)::int AS n FROM login_failures WHERE ip IS NOT NULL AND at > $1 AND reason = ANY($2)
      GROUP BY ip ORDER BY max(at) DESC LIMIT 2000`,
    [new Date(now - IP_LONG.windowMs), COUNTED_REASONS],
  );
  const perKey = new Map<string, number>();
  for (const i of ips) {
    if (ipLockExempt(ctx, i.ip)) continue;
    const k = ipLockKey(i.ip);
    perKey.set(k, (perKey.get(k) ?? 0) + i.n);
  }
  for (const [key, n] of perKey) {
    if (n < IP_SHORT.count) continue;
    const l = await ipLock(ctx, key, now);
    if (l) out.push({ scope: 'ip', key, until: new Date(l.until), failures: l.failures });
  }
  return out;
}

// Pruned at most once a day per process (the maintenance pass runs every five minutes).
const lastPrune = new WeakMap<Ctx, number>();

/** Deletes `login_failures` rows older than 90 days. Returns how many went (0 when it already ran in the last day). */
export async function pruneLoginFailures(ctx: Ctx, opts: { force?: boolean } = {}): Promise<number> {
  const now = ctx.clock.now().getTime();
  const last = lastPrune.get(ctx);
  if (!opts.force && last !== undefined && now - last < DAY) return 0;
  lastPrune.set(ctx, now);
  return exec(ctx.pool, 'DELETE FROM login_failures WHERE at < $1', [
    new Date(now - LOGIN_FAILURE_RETENTION_MS),
  ]);
}
