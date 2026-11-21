import { randomUUID } from 'node:crypto';
import { TOO_MANY_ATTEMPTS, type TwoFactorRecoveryStatus } from '@aom/shared';
import { checkLoginGuard, recordLoginFailure } from '../auth/login-guard.ts';
import { disableTwoFactorIn, MAX_CHALLENGE_ATTEMPTS } from '../auth/two-factor.ts';
import type { Ctx } from '../context.ts';
import { randomToken, sha256Hex } from '../crypto.ts';
import { exec, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { conflict, forbidden, HttpError, notFound, unauthorized } from '../errors.ts';
import { securityNoticeMail } from '../mail/security-notices.ts';
import { SYSTEM_ACTOR } from './common.ts';
import { notifySuperAdmins } from './platform-notify.ts';
import { sendQuietly } from './platform-settings.ts';

/**
 * "Lost your authenticator?" (R17-2): the user's own two-factor recovery, which replaced the super admin's instant
 * reset. The password must be right first (it starts from the two-factor step of a sign-in), a mailed link (valid 24 h)
 * confirms it, and two-factor login is removed 24 h after that by `twoFactorRecoveryTick`. The user is mailed at
 * confirmation and at removal, and so are the Owners of every organization the user belongs to; when the user owns an
 * organization, every super admin is mailed as well (the Owner notice would go to the same, possibly compromised,
 * mailbox). Signing in with a code or a recovery code during the wait cancels it, and so does the link in the mails.
 * Super admins are excluded: they recover on the server console (`superadmin:reset-password --reset-two-factor`).
 * Rows live in `two_factor_recoveries` (operational; the removal itself is the `TwoFactorDisabled` event).
 */

export const RECOVERY_LINK_TTL_MS = 24 * 3600_000;
export const RECOVERY_WAIT_MS = 24 * 3600_000;
/** Links one account may ask for in 24 h. */
export const RECOVERY_LINKS_PER_DAY = 3;

interface Meta {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

const fmt = (d: Date) => d.toUTCString();
// The token rides in the fragment: a browser never sends it to the server, so it never reaches a log line.
const linkOf = (ctx: Ctx, token: string) => `${ctx.config.publicOrigin}/recover-2fa#${token}`;

function stateOf(ctx: Ctx, r: Row): TwoFactorRecoveryStatus {
  const effectiveAt = r.effective_at ? new Date(r.effective_at).toISOString() : null;
  if (r.done_at) return { state: 'done', effectiveAt };
  if (r.cancelled_at) return { state: 'cancelled', effectiveAt };
  if (r.confirmed_at) return { state: 'waiting', effectiveAt };
  if (new Date(r.created_at).getTime() + RECOVERY_LINK_TTL_MS <= ctx.clock.now().getTime())
    return { state: 'expired', effectiveAt: null };
  return { state: 'awaiting_confirmation', effectiveAt: null };
}

async function byToken(db: Queryable, token: string, lock = false): Promise<Row> {
  const r = await one(
    db,
    `SELECT * FROM two_factor_recoveries WHERE token_hash=$1${lock ? ' FOR UPDATE' : ''}`,
    [sha256Hex(token)],
  );
  if (!r) throw notFound('this recovery link is not known', 'recovery_not_found');
  return r;
}

/** The Owners to tell about a member's recovery (never the user themself), and whether the user owns an organization. */
async function ownersOf(
  db: Queryable,
  userId: string,
): Promise<{ owners: Array<{ email: string; name: string; orgName: string }>; ownsOrg: boolean }> {
  const list = await rows(
    db,
    `SELECT DISTINCT o.name AS org_name, o.owner_user_id, u.email, u.display_name
       FROM org_members m JOIN organizations o ON o.id = m.org_id JOIN users u ON u.id = o.owner_user_id
      WHERE m.user_id=$1 AND m.status='active' AND u.status='active'
      ORDER BY o.name`,
    [userId],
  );
  return {
    owners: list
      .filter((r) => r.owner_user_id !== userId)
      .map((r) => ({ email: r.email, name: r.display_name, orgName: r.org_name })),
    ownsOrg: !!(await one(
      db,
      `SELECT 1 AS x FROM organizations WHERE owner_user_id=$1 AND status <> 'cancelled' LIMIT 1`,
      [userId],
    )),
  };
}

/** Mails the Owners (and, for an Owner's own recovery, every super admin) about a confirmed or completed recovery. */
async function tellOthers(
  ctx: Ctx,
  user: { id: string; email: string; display_name: string },
  stage: 'confirmed' | 'done',
  effectiveAt: Date,
): Promise<void> {
  const { owners, ownsOrg } = await ownersOf(ctx.pool, user.id);
  const what =
    stage === 'confirmed'
      ? `asked to remove their two-factor login. It is removed ${fmt(effectiveAt)} unless they cancel it or sign in with a code first.`
      : 'no longer has two-factor login: they recovered their account by email after the 24-hour wait.';
  for (const o of owners)
    await sendQuietly(
      ctx,
      securityNoticeMail({
        to: o.email,
        subject: `${user.display_name} ${stage === 'confirmed' ? 'is recovering their two-factor login' : 'recovered their two-factor login'}`,
        heading: stage === 'confirmed' ? 'Two-factor recovery started' : 'Two-factor login removed',
        paragraphs: [
          `Hello ${o.name},`,
          `${user.display_name} (${user.email}), a member of ${o.orgName}, ${what}`,
          'If that is unexpected, talk to them. Your organization can require two-factor login, so they set it up again at their next sign-in.',
        ],
        origin: ctx.config.publicOrigin,
      }),
    );
  if (ownsOrg)
    await notifySuperAdmins(ctx, {
      subject: `Two-factor recovery ${stage === 'confirmed' ? 'confirmed' : 'completed'} for an organization Owner`,
      heading: 'An Owner is recovering their two-factor login',
      facts: [
        ['Account', `${user.display_name} <${user.email}>`],
        [
          'Stage',
          stage === 'confirmed' ? `Confirmed; removed ${fmt(effectiveAt)}` : 'Two-factor login removed',
        ],
      ],
      path: '/platform/users',
      linkLabel: 'Open the users',
    });
}

/**
 * Starts a recovery from the two-factor step of a sign-in: the challenge proves the password was right. The sign-in
 * protection applies (a locked account gets 429 and a `locked` row); the challenge is spent. Returns the state.
 */
export async function startTwoFactorRecovery(
  ctx: Ctx,
  challenge: string,
  meta: Meta = {},
): Promise<TwoFactorRecoveryStatus> {
  const c = await one<{ user_id: string; expires_at: Date; attempts: number }>(
    ctx.pool,
    'SELECT user_id, expires_at, attempts FROM login_challenges WHERE id=$1',
    [sha256Hex(challenge)],
  );
  if (!c || new Date(c.expires_at) <= ctx.clock.now() || c.attempts >= MAX_CHALLENGE_ATTEMPTS)
    throw unauthorized('the sign-in expired: sign in again');
  const user = await one(ctx.pool, 'SELECT id, email, display_name, kind, status FROM users WHERE id=$1', [
    c.user_id,
  ]);
  if (!user || user.status !== 'active') throw unauthorized('the sign-in expired: sign in again');
  if (user.kind === 'super_admin')
    throw forbidden('a platform account recovers its two-factor login on the server console');
  const guard = await checkLoginGuard(ctx, {
    email: user.email,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent,
  });
  if (guard.locked) {
    await recordLoginFailure(ctx, {
      reason: 'locked',
      email: user.email,
      userId: user.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    throw new HttpError(429, TOO_MANY_ATTEMPTS, 'too many attempts: try again later', {
      retryAfterSec: guard.retryAfterSec,
    });
  }
  const now = ctx.clock.now();
  const token = randomToken(32);
  const out = await withAppendTx(ctx.pool, async (tx) => {
    await one(tx, 'SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
    const waiting = await one(
      tx,
      `SELECT * FROM two_factor_recoveries WHERE user_id=$1 AND confirmed_at IS NOT NULL AND cancelled_at IS NULL
          AND done_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [user.id],
    );
    if (waiting) return { status: stateOf(ctx, waiting), send: false };
    const recent = await one<{ n: number }>(
      tx,
      `SELECT count(*)::int AS n FROM two_factor_recoveries WHERE user_id=$1 AND created_at > $2`,
      [user.id, new Date(now.getTime() - 24 * 3600_000)],
    );
    if ((recent?.n ?? 0) >= RECOVERY_LINKS_PER_DAY)
      throw new HttpError(
        429,
        'recovery_limit',
        'three recovery links were sent in the last 24 hours: use the latest one',
      );
    // One open link at a time: an older unconfirmed one stops working.
    await exec(
      tx,
      `UPDATE two_factor_recoveries SET cancelled_at=$2 WHERE user_id=$1 AND confirmed_at IS NULL
          AND cancelled_at IS NULL AND done_at IS NULL`,
      [user.id, now],
    );
    await exec(
      tx,
      `INSERT INTO two_factor_recoveries (id, user_id, token_hash, created_at) VALUES ($1,$2,$3,$4)`,
      [randomUUID(), user.id, sha256Hex(token), now],
    );
    await exec(tx, 'DELETE FROM login_challenges WHERE id=$1', [sha256Hex(challenge)]);
    return {
      status: { state: 'awaiting_confirmation', effectiveAt: null } as TwoFactorRecoveryStatus,
      send: true,
    };
  });
  if (out.send)
    await sendQuietly(
      ctx,
      securityNoticeMail({
        to: user.email,
        subject: 'Confirm removing your two-factor login',
        heading: 'Lost your authenticator?',
        paragraphs: [
          `Hello ${user.display_name},`,
          'Someone who knows your password, hopefully you, asked to remove the two-factor login of your account because the authenticator is lost.',
          'Confirm it with the button below. For your safety, two-factor login is removed 24 hours after you confirm, and the Owners of your organizations are told. Signing in with a code or a recovery code in the meantime cancels it.',
        ],
        cta: { label: 'Confirm the recovery', url: linkOf(ctx, token) },
        note: `This link expires ${fmt(new Date(now.getTime() + RECOVERY_LINK_TTL_MS))}. If you did not ask for it, change your password: whoever asked knows it.`,
        origin: ctx.config.publicOrigin,
      }),
    );
  return out.status;
}

export async function twoFactorRecoveryStatus(ctx: Ctx, token: string): Promise<TwoFactorRecoveryStatus> {
  return stateOf(ctx, await byToken(ctx.pool, token));
}

/** Confirms the mailed link: two-factor login goes 24 h from now. Mails the user and the Owners (and super admins). */
export async function confirmTwoFactorRecovery(ctx: Ctx, token: string): Promise<TwoFactorRecoveryStatus> {
  const now = ctx.clock.now();
  const effectiveAt = new Date(now.getTime() + RECOVERY_WAIT_MS);
  const r = await withAppendTx(ctx.pool, async (tx) => {
    const row = await byToken(tx, token, true);
    const s = stateOf(ctx, row);
    if (s.state !== 'awaiting_confirmation')
      throw conflict('recovery_not_open', `this recovery is ${s.state.replace('_', ' ')}`, s);
    await exec(tx, `UPDATE two_factor_recoveries SET confirmed_at=$2, effective_at=$3 WHERE id=$1`, [
      row.id,
      now,
      effectiveAt,
    ]);
    return row;
  });
  const user = await one(ctx.pool, 'SELECT id, email, display_name FROM users WHERE id=$1', [r.user_id]);
  if (user) {
    await sendQuietly(
      ctx,
      securityNoticeMail({
        to: user.email,
        subject: 'Your two-factor login will be removed in 24 hours',
        heading: 'Two-factor recovery confirmed',
        paragraphs: [
          `Hello ${user.display_name},`,
          `Your two-factor login is removed ${fmt(effectiveAt)}. After that you sign in with your password and set up a new authenticator.`,
          'If this was not you, cancel it now with the button below and change your password. Signing in with a code or a recovery code cancels it too.',
        ],
        cta: { label: 'Review or cancel', url: linkOf(ctx, token) },
        origin: ctx.config.publicOrigin,
      }),
    );
    await tellOthers(
      ctx,
      user as { id: string; email: string; display_name: string },
      'confirmed',
      effectiveAt,
    );
  }
  return { state: 'waiting', effectiveAt: effectiveAt.toISOString() };
}

/** Cancels an open recovery from the link in the mails. */
export async function cancelTwoFactorRecovery(ctx: Ctx, token: string): Promise<TwoFactorRecoveryStatus> {
  return withAppendTx(ctx.pool, async (tx) => {
    const row = await byToken(tx, token, true);
    const s = stateOf(ctx, row);
    if (s.state !== 'awaiting_confirmation' && s.state !== 'waiting')
      throw conflict('recovery_not_open', `this recovery is ${s.state.replace('_', ' ')}`, s);
    await exec(tx, 'UPDATE two_factor_recoveries SET cancelled_at=$2 WHERE id=$1', [row.id, ctx.clock.now()]);
    return { state: 'cancelled', effectiveAt: s.effectiveAt };
  });
}

/**
 * A sign-in with a code or a recovery code proves the authenticator (or the codes) are not lost: every open recovery of
 * the account ends. Returns how many were cancelled.
 */
export async function cancelRecoveriesOnSignIn(ctx: Ctx, userId: string): Promise<number> {
  const r = await ctx.pool.query(
    `UPDATE two_factor_recoveries SET cancelled_at=$2
      WHERE user_id=$1 AND cancelled_at IS NULL AND done_at IS NULL`,
    [userId, ctx.clock.now()],
  );
  return r.rowCount ?? 0;
}

/**
 * Removes two-factor login for every recovery whose wait is over (scheduler, every pass). The account's sessions end.
 * Returns the user ids done.
 */
export async function twoFactorRecoveryTick(ctx: Ctx): Promise<string[]> {
  const now = ctx.clock.now();
  const due = await rows<{ id: string }>(
    ctx.pool,
    `SELECT id FROM two_factor_recoveries
      WHERE confirmed_at IS NOT NULL AND cancelled_at IS NULL AND done_at IS NULL AND effective_at <= $1
      ORDER BY effective_at LIMIT 50`,
    [now],
  );
  const done: string[] = [];
  for (const d of due) {
    const userId = await withAppendTx(ctx.pool, async (tx) => {
      const r = await one(
        tx,
        `SELECT * FROM two_factor_recoveries WHERE id=$1 AND cancelled_at IS NULL AND done_at IS NULL
          FOR UPDATE SKIP LOCKED`,
        [d.id],
      );
      if (!r) return null;
      await exec(tx, 'UPDATE two_factor_recoveries SET done_at=$2 WHERE id=$1', [r.id, now]);
      const u = await one(tx, 'SELECT two_factor_enabled, kind FROM users WHERE id=$1 FOR UPDATE', [
        r.user_id,
      ]);
      if (!u?.two_factor_enabled || u.kind === 'super_admin') return null;
      await disableTwoFactorIn(ctx, tx, r.user_id, r.user_id, 'reset', SYSTEM_ACTOR);
      await exec(tx, 'DELETE FROM auth_sessions WHERE user_id=$1', [r.user_id]);
      return r.user_id as string;
    });
    if (!userId) continue;
    done.push(userId);
    ctx.services.browser.closeUser(userId);
    const user = await one(ctx.pool, 'SELECT id, email, display_name FROM users WHERE id=$1', [userId]);
    if (!user) continue;
    await sendQuietly(
      ctx,
      securityNoticeMail({
        to: user.email,
        subject: 'Your two-factor login was removed',
        heading: 'Two-factor login removed',
        paragraphs: [
          `Hello ${user.display_name},`,
          'The 24-hour wait is over and the two-factor login of your account is removed, as you confirmed. Sign in with your password and set up a new authenticator.',
          'If you did not ask for this, change your password and set up two-factor login again right away.',
        ],
        cta: { label: 'Sign in', url: `${ctx.config.publicOrigin}/login` },
        origin: ctx.config.publicOrigin,
      }),
    );
    await tellOthers(ctx, user as { id: string; email: string; display_name: string }, 'done', now);
  }
  return done;
}

/**
 * The Owner's reset of a member's two-factor login (R6, R17-2) goes through the same wait: it counts as confirmed now
 * and removes two-factor login 24 h later, unless the member cancels it from the mail (they may still have their
 * authenticator, and the request may not be theirs) or signs in with a code. Call inside the Owner's transaction; the
 * mail goes out after it. Returns when it takes effect.
 */
export async function scheduleOwnerTwoFactorReset(
  ctx: Ctx,
  tx: Queryable,
  userId: string,
): Promise<{ effectiveAt: Date; token: string }> {
  const now = ctx.clock.now();
  const effectiveAt = new Date(now.getTime() + RECOVERY_WAIT_MS);
  const token = randomToken(32);
  await exec(
    tx,
    `UPDATE two_factor_recoveries SET cancelled_at=$2 WHERE user_id=$1 AND cancelled_at IS NULL AND done_at IS NULL`,
    [userId, now],
  );
  await exec(
    tx,
    `INSERT INTO two_factor_recoveries (id, user_id, token_hash, created_at, confirmed_at, effective_at)
     VALUES ($1,$2,$3,$4,$4,$5)`,
    [randomUUID(), userId, sha256Hex(token), now, effectiveAt],
  );
  return { effectiveAt, token };
}

/** The member's mail about an Owner's reset (after the Owner's transaction committed). */
export async function mailOwnerTwoFactorReset(
  ctx: Ctx,
  userId: string,
  ownerName: string,
  orgName: string,
  r: { effectiveAt: Date; token: string },
): Promise<void> {
  const u = await one(ctx.pool, 'SELECT email, display_name FROM users WHERE id=$1', [userId]);
  if (!u) return;
  await sendQuietly(
    ctx,
    securityNoticeMail({
      to: u.email,
      subject: 'Your two-factor login will be reset in 24 hours',
      heading: 'Two-factor reset requested',
      paragraphs: [
        `Hello ${u.display_name},`,
        `${ownerName}, the Owner of ${orgName}, asked to reset your two-factor login. It is removed ${fmt(r.effectiveAt)}; after that you sign in with your password and set up a new authenticator.`,
        'If you still have your authenticator, or did not ask for this, cancel it with the button below. Signing in with a code cancels it too.',
      ],
      cta: { label: 'Review or cancel', url: linkOf(ctx, r.token) },
      origin: ctx.config.publicOrigin,
    }),
  );
}
