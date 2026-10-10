import { streamId } from '@aom/shared';
import { hashPassword } from '../auth/password.ts';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { randomToken, sha256Hex } from '../crypto.ts';
import { exec, one, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, HttpError, notFound } from '../errors.ts';
import { passwordResetMail } from '../mail/templates.ts';
import { userActor } from './common.ts';

/**
 * Password reset (docs/SPEC.md, "Forgot password"). A link is emailed; it works once for an hour. Setting the new
 * password signs the account out everywhere and does NOT sign it in: the next sign-in is the normal one, so a second
 * factor (TOTP) is still asked. Only the token's hash is stored.
 */

export const RESET_TTL_MS = 60 * 60 * 1000;
/** A second request inside this window is answered the same way but sends nothing (mail bombing, double clicks). */
const RESEND_AFTER_MS = 2 * 60 * 1000;

export const resetLink = (ctx: Ctx, token: string) => `${ctx.config.publicOrigin}/reset-password/${token}`;

/** Makes a fresh link for the user: earlier unused links stop working. */
async function issue(
  ctx: Ctx,
  userId: string,
  requestedBy: string | null,
  ip: string | null,
): Promise<{ token: string; expiresAt: Date; id: string }> {
  const now = ctx.clock.now();
  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + RESET_TTL_MS);
  await exec(ctx.pool, 'UPDATE password_resets SET used_at=$2 WHERE user_id=$1 AND used_at IS NULL', [
    userId,
    now,
  ]);
  const r = await one(
    ctx.pool,
    `INSERT INTO password_resets (user_id, token_hash, requested_by, created_at, expires_at, ip)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [userId, sha256Hex(token), requestedBy, now, expiresAt, ip],
  );
  return { token, expiresAt, id: String(r?.id) };
}

/**
 * "Forgot password?": always succeeds, whether or not the email belongs to an account (nobody can probe which emails
 * exist). Platform accounts may use it too (their two-factor code is still asked at the next sign-in). The mail is sent after the answer is
 * decided and its failure is only logged, so timing and errors do not tell either.
 */
export async function requestPasswordReset(ctx: Ctx, email: string, ip: string | null): Promise<void> {
  const u = await one(
    ctx.pool,
    `SELECT id, display_name, email, status, kind FROM users WHERE lower(email)=lower($1)`,
    [email.trim()],
  );
  if (!u || u.status !== 'active') return;
  const recent = await one(
    ctx.pool,
    `SELECT 1 FROM password_resets WHERE user_id=$1 AND used_at IS NULL AND created_at > $2`,
    [u.id, new Date(ctx.clock.now().getTime() - RESEND_AFTER_MS)],
  );
  if (recent) return;
  const { token, expiresAt } = await issue(ctx, u.id, null, ip);
  try {
    await ctx.mailer.send(
      passwordResetMail({
        to: u.email,
        name: u.display_name,
        link: resetLink(ctx, token),
        expiresAt,
        origin: ctx.config.publicOrigin,
      }),
    );
  } catch (err) {
    ctx.log.error({ err }, 'failed to send password reset mail');
  }
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

/** Whether a link can still be used (the set-password page asks before it shows the form). */
export async function resetLinkState(ctx: Ctx, token: string): Promise<{ valid: boolean }> {
  const r = await one(
    ctx.pool,
    `SELECT 1 FROM password_resets r JOIN users u ON u.id = r.user_id
      WHERE r.token_hash=$1 AND r.used_at IS NULL AND r.expires_at > $2 AND u.status='active'`,
    [sha256Hex(token), ctx.clock.now()],
  );
  return { valid: !!r };
}

/**
 * Sets the new password from a link: the link is spent, the password changes (`PasswordChanged`), every session of the
 * account and any half-finished two-factor sign-in end. No session is created: the person signs in again, with their
 * second factor if they use one.
 */
export async function resetPassword(ctx: Ctx, token: string, password: string): Promise<void> {
  const passwordHash = await hashPassword(password);
  const userId = await withAppendTx(ctx.pool, async (tx) => {
    const r = await one(
      tx,
      `SELECT r.id, r.user_id FROM password_resets r JOIN users u ON u.id = r.user_id
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
          event: { type: 'PasswordChanged', payload: { userId: id, passwordHash } },
          actor: userActor(id),
          scope: { orgId: null, projectId: null, audience: 'admin' },
        },
      ],
      { tx },
    );
    await exec(tx, 'DELETE FROM login_challenges WHERE user_id=$1', [id]);
    return id;
  });
  const sessions = await rows<{ id: string }>(ctx.pool, 'SELECT id FROM auth_sessions WHERE user_id=$1', [
    userId,
  ]);
  await exec(ctx.pool, 'DELETE FROM auth_sessions WHERE user_id=$1', [userId]);
  for (const s of sessions) ctx.services.browser.closeSession(s.id);
}
