import { type PasswordResetLinkState, streamId } from '@aom/shared';
import { screenAddress } from '../auth/address-policy.ts';
import { clearLoginLock, recordFailedSignIn } from '../auth/login-guard.ts';
import { hashPassword } from '../auth/password.ts';
import { sendPasswordChangedMail } from '../auth/security-mail.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { hasTwoFactor, verifySecondFactor } from '../auth/two-factor.ts';
import type { Ctx } from '../context.ts';
import { randomToken, sha256Hex } from '../crypto.ts';
import { exec, one, type Queryable, rows } from '../db/sql.ts';
import { afterCommit, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, HttpError, notFound } from '../errors.ts';
import { passwordResetMail } from '../mail/templates.ts';
import { userActor } from './common.ts';

/**
 * Password reset (docs/SPEC.md, "Forgot password"). A link is emailed; it works once for an hour. Setting the new
 * password signs the account out everywhere and does NOT sign it in: the next sign-in is the normal one, so a second
 * factor (TOTP) is still asked. Only the token's hash is stored. 1.10.0 (R3): a two-factor account must also give a
 * code (TOTP or recovery) to complete the reset; five wrong codes end the link; at most five links per account a day.
 */

export const RESET_TTL_MS = 60 * 60 * 1000;
/** A second request inside this window is answered the same way but sends nothing (mail bombing, double clicks). */
const RESEND_AFTER_MS = 2 * 60 * 1000;
/** Self-service links per account per 24 h (R3); more requests are answered the same way and send nothing. */
export const RESET_LINKS_PER_DAY = 5;
/** Wrong second-factor answers on one link before it dies (R3). */
export const RESET_MAX_CODE_ATTEMPTS = 5;

export const resetLink = (ctx: Ctx, token: string) => `${ctx.config.publicOrigin}/reset-password/${token}`;

/**
 * Makes a fresh link for the user: earlier unused links stop working. Also used by the members list (orgs.ts, R6),
 * which passes its own transaction as `db`.
 */
export async function issue(
  ctx: Ctx,
  userId: string,
  requestedBy: string | null,
  ip: string | null,
  db: Queryable = ctx.pool,
): Promise<{ token: string; expiresAt: Date; id: string }> {
  const now = ctx.clock.now();
  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + RESET_TTL_MS);
  await exec(db, 'UPDATE password_resets SET used_at=$2 WHERE user_id=$1 AND used_at IS NULL', [userId, now]);
  const r = await one(
    db,
    `INSERT INTO password_resets (user_id, token_hash, requested_by, created_at, expires_at, ip)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [userId, sha256Hex(token), requestedBy, now, expiresAt, ip],
  );
  return { token, expiresAt, id: String(r?.id) };
}

/**
 * "Forgot password?": always succeeds, whether or not the email belongs to an account (nobody can probe which emails
 * exist). Platform accounts may use it too (their two-factor code is still asked at the next sign-in). The mail is sent
 * without waiting for it and its failure is only logged, so timing and errors do not tell either.
 */
export async function requestPasswordReset(ctx: Ctx, email: string, ip: string | null): Promise<void> {
  const u = await one(
    ctx.pool,
    `SELECT id, display_name, email, status, kind FROM users WHERE lower(email)=lower($1)`,
    [email.trim()],
  );
  if (!u || u.status !== 'active') return;
  // R1: a blocked address or IP gets the same silent answer and no mail.
  if (await screenAddress(ctx, { email: u.email, ip, purpose: 'password_reset' })) return;
  // R3: at most five links per account in 24 h, counted in the database.
  const today = await one<{ n: number }>(
    ctx.pool,
    `SELECT count(*)::int AS n FROM password_resets WHERE user_id=$1 AND requested_by IS NULL AND created_at > $2`,
    [u.id, new Date(ctx.clock.now().getTime() - 24 * 3600_000)],
  );
  if ((today?.n ?? 0) >= RESET_LINKS_PER_DAY) return;
  const recent = await one(
    ctx.pool,
    `SELECT 1 FROM password_resets WHERE user_id=$1 AND used_at IS NULL AND created_at > $2`,
    [u.id, new Date(ctx.clock.now().getTime() - RESEND_AFTER_MS)],
  );
  if (recent) return;
  const { token, expiresAt } = await issue(ctx, u.id, null, ip);
  // Detached (R2 uniform answers): the request never waits for the mail server, so a known address does not answer
  // measurably slower than an unknown one.
  void ctx.mailer
    .send(
      passwordResetMail({
        to: u.email,
        name: u.display_name,
        link: resetLink(ctx, token),
        expiresAt,
        origin: ctx.config.publicOrigin,
      }),
    )
    .catch((err) => ctx.log.error({ err }, 'failed to send password reset mail'));
}

/**
 * A super admin sends the link to any account. Unlike the self-service request this answers truthfully (the admin
 * needs to know it went out): 404 for an unknown account, 409 for a deactivated account, 502 when the
 * mail could not be sent. The send is an audit entry (`PasswordResetLinkSent`).
 */
export async function sendPasswordResetAsAdmin(
  ctx: Ctx,
  admin: AuthSession,
  userId: string,
  meta: { ip?: string | undefined; userAgent?: string | undefined },
): Promise<{ sentTo: string; expiresAt: string }> {
  const u = await one(ctx.pool, `SELECT id, display_name, email, status, kind FROM users WHERE id=$1`, [
    userId,
  ]);
  if (!u) throw notFound('user not found');
  if (u.status !== 'active') throw conflict('user_deactivated', 'this account is deactivated');
  const { token, expiresAt, id } = await issue(ctx, u.id, admin.user.id, meta.ip ?? null);
  try {
    await ctx.mailer.send(
      passwordResetMail({
        to: u.email,
        name: u.display_name,
        link: resetLink(ctx, token),
        expiresAt,
        origin: ctx.config.publicOrigin,
        byTeam: true,
      }),
    );
  } catch (err) {
    ctx.log.error({ err }, 'failed to send password reset mail');
    await exec(ctx.pool, 'DELETE FROM password_resets WHERE id=$1', [id]);
    throw new HttpError(502, 'mail_failed', 'the email could not be sent; try again in a moment');
  }
  await ctx.store.append([
    {
      streamId: streamId.user(u.id),
      event: {
        type: 'PasswordResetLinkSent',
        payload: {
          userId: u.id,
          by: admin.user.id,
          meta: {
            ...(meta.ip ? { ip: meta.ip } : {}),
            ...(meta.userAgent ? { userAgent: meta.userAgent.slice(0, 400) } : {}),
          },
        },
      },
      actor: userActor(admin.user.id),
      scope: { orgId: null, projectId: null, audience: 'admin' },
    },
  ]);
  return { sentTo: u.email, expiresAt: expiresAt.toISOString() };
}

/** A link that can still be used: its row and the account it resets. */
async function liveLink(
  ctx: Ctx,
  token: string,
): Promise<{ id: string; user_id: string; email: string; attempts: number } | null> {
  const r = await one<{ id: string; user_id: string; email: string; attempts: number }>(
    ctx.pool,
    `SELECT r.id::text AS id, r.user_id, u.email, r.attempts FROM password_resets r JOIN users u ON u.id = r.user_id
      WHERE r.token_hash=$1 AND r.used_at IS NULL AND r.expires_at > $2 AND u.status='active'`,
    [sha256Hex(token), ctx.clock.now()],
  );
  return r ?? null;
}

/**
 * Whether a link can still be used, and whether completing it needs a second factor (the set-password page asks before
 * it shows the form, and shows the code field for two-factor accounts).
 */
export async function resetLinkState(ctx: Ctx, token: string): Promise<PasswordResetLinkState> {
  const r = await liveLink(ctx, token);
  if (!r) return { valid: false, secondFactor: false };
  return { valid: true, secondFactor: await hasTwoFactor(ctx.pool, r.user_id) };
}

/**
 * R3: a two-factor account completes a reset only with a code (TOTP or recovery). A missing code is 400
 * `second_factor_required`; a wrong one is 400 `invalid_code` with `attemptsLeft`, a `reset_second_factor` failure row,
 * and at the fifth the link dies.
 */
async function checkResetSecondFactor(
  ctx: Ctx,
  link: { id: string; user_id: string; email: string; attempts: number },
  code: string | undefined,
  meta: { ip?: string | undefined; userAgent?: string | undefined },
): Promise<void> {
  if (!(await hasTwoFactor(ctx.pool, link.user_id))) return;
  if (!code)
    throw badRequest(
      'second_factor_required',
      'enter the code from your authenticator app, or a recovery code, to set the new password',
      { attemptsLeft: Math.max(0, RESET_MAX_CODE_ATTEMPTS - link.attempts) },
    );
  if (await verifySecondFactor(ctx, link.user_id, code)) return;
  const r = await one<{ attempts: number }>(
    ctx.pool,
    `UPDATE password_resets SET attempts = attempts + 1,
            used_at = CASE WHEN attempts + 1 >= $2 THEN $3 ELSE used_at END
      WHERE id = $1::uuid RETURNING attempts`,
    [link.id, RESET_MAX_CODE_ATTEMPTS, ctx.clock.now()],
  );
  await recordFailedSignIn(ctx, {
    reason: 'reset_second_factor',
    email: link.email,
    userId: link.user_id,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  const attemptsLeft = Math.max(0, RESET_MAX_CODE_ATTEMPTS - (r?.attempts ?? RESET_MAX_CODE_ATTEMPTS));
  if (attemptsLeft === 0)
    throw badRequest(
      'reset_link_invalid',
      'too many wrong codes: this link no longer works, ask for a new one',
    );
  throw badRequest('invalid_code', 'that code is not right', { attemptsLeft });
}

/**
 * Sets the new password from a link: the link is spent, the password changes (`PasswordChanged`), every session of the
 * account and any half-finished two-factor sign-in end. No session is created: the person signs in again, with their
 * second factor if they use one.
 */
export async function resetPassword(
  ctx: Ctx,
  token: string,
  password: string,
  opts: { code?: string | undefined; ip?: string | undefined; userAgent?: string | undefined } = {},
): Promise<void> {
  const link = await liveLink(ctx, token);
  if (!link)
    throw badRequest('reset_link_invalid', 'this link has expired or was already used: ask for a new one');
  await checkResetSecondFactor(ctx, link, opts.code, opts);
  const passwordHash = await hashPassword(password);
  const userId = await withAppendTx(ctx.pool, async (tx) => {
    const r = await one(
      tx,
      `SELECT r.id, r.user_id, u.email FROM password_resets r JOIN users u ON u.id = r.user_id
        WHERE r.token_hash=$1 AND r.used_at IS NULL AND r.expires_at > $2 AND u.status='active' FOR UPDATE OF r`,
      [sha256Hex(token), ctx.clock.now()],
    );
    if (!r)
      throw badRequest('reset_link_invalid', 'this link has expired or was already used: ask for a new one');
    const id = String(r.user_id);
    await exec(tx, 'UPDATE password_resets SET used_at=$2 WHERE user_id=$1 AND used_at IS NULL', [
      id,
      ctx.clock.now(),
    ]);
    await ctx.store.append(
      [
        {
          streamId: streamId.user(id),
          event: {
            type: 'PasswordChanged',
            payload: {
              userId: id,
              passwordHash,
              via: 'reset_link',
              meta: {
                ...(opts.ip ? { ip: opts.ip.slice(0, 64) } : {}),
                ...(opts.userAgent ? { userAgent: opts.userAgent.slice(0, 400) } : {}),
              },
            },
          },
          actor: userActor(id),
          scope: { orgId: null, projectId: null, audience: 'admin' },
        },
      ],
      { tx },
    );
    await exec(tx, 'DELETE FROM login_challenges WHERE user_id=$1', [id]);
    // R2 exemption b: a completed reset ends the account lock.
    await clearLoginLock(ctx, { email: String(r.email), userId: id, ip: opts.ip }, tx);
    afterCommit(tx, () => sendPasswordChangedMail(ctx, id, 'reset_link', opts.ip ?? null));
    return id;
  });
  const sessions = await rows<{ id: string }>(ctx.pool, 'SELECT id FROM auth_sessions WHERE user_id=$1', [
    userId,
  ]);
  await exec(ctx.pool, 'DELETE FROM auth_sessions WHERE user_id=$1', [userId]);
  for (const s of sessions) ctx.services.browser.closeSession(s.id);
}

/** What the console reset needs (the CLI has no running app, so it passes these pieces, not a full `Ctx`). */
export type ConsoleResetCtx = Pick<Ctx, 'pool' | 'store' | 'clock' | 'mailer' | 'log'> & {
  config: Pick<Ctx['config'], 'publicOrigin'>;
};

/**
 * `superadmin:reset-password`: the emergency reset of a super admin's password (`PasswordChanged` via `cli`, the system
 * as actor, so it is audited and replayable) and, with `resetTwoFactor`, of their two-factor login. Every session ends,
 * the account lock is cleared (R2 b) and the account is mailed (R3).
 */
export async function consoleResetSuperAdminPassword(
  cctx: ConsoleResetCtx,
  input: { email: string; password: string; resetTwoFactor?: boolean },
): Promise<{ userId: string }> {
  const ctx = cctx as unknown as Ctx;
  const passwordHash = await hashPassword(input.password);
  const userId = await withAppendTx(ctx.pool, async (tx) => {
    const u = await one<{ id: string; kind: string; email: string }>(
      tx,
      `SELECT id, kind, email FROM users WHERE lower(email)=lower($1)`,
      [input.email],
    );
    if (!u) throw new Error(`no account with email ${input.email}`);
    if (u.kind !== 'super_admin')
      throw new Error(`${input.email} is not a super admin: its password is changed in the app`);
    const system = { kind: 'system' as const, id: null };
    const scope = { orgId: null, projectId: null, audience: 'admin' as const };
    await ctx.store.append(
      [
        {
          streamId: streamId.user(u.id),
          event: { type: 'PasswordChanged', payload: { userId: u.id, passwordHash, via: 'cli' } },
          actor: system,
          scope,
        },
      ],
      { tx },
    );
    if (input.resetTwoFactor) {
      await exec(tx, 'DELETE FROM user_totp WHERE user_id=$1', [u.id]);
      await exec(tx, 'DELETE FROM user_recovery_codes WHERE user_id=$1', [u.id]);
      await ctx.store.append(
        [
          {
            streamId: streamId.user(u.id),
            event: { type: 'TwoFactorDisabled', payload: { userId: u.id, by: u.id, reason: 'reset' } },
            actor: system,
            scope,
          },
        ],
        { tx },
      );
    }
    await exec(tx, 'DELETE FROM auth_sessions WHERE user_id=$1', [u.id]);
    await clearLoginLock(ctx, { email: u.email, userId: u.id }, tx);
    return u.id;
  });
  await sendPasswordChangedMail(ctx, userId, 'cli');
  if (input.resetTwoFactor) await sendPasswordChangedMail(ctx, userId, 'two_factor_reset_cli');
  return { userId };
}
