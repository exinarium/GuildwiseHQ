import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import type { MailMessage } from '../mail/mailer.ts';
import { type PasswordChangeHow, passwordChangedMail } from '../mail/templates.ts';

/**
 * Account security mails (R2-R4): who gets them, how often, and how they are sent. Every mail goes out after the change
 * has committed and a mail problem is only logged, never failing the request.
 */

export async function sendSecurityMail(ctx: Ctx, msg: MailMessage): Promise<void> {
  try {
    await ctx.mailer.send(msg);
  } catch (err) {
    ctx.log.warn({ err, subject: msg.subject }, 'security mail was not sent');
  }
}

/**
 * Claims the right to send one notice of `kind` to `userId`: true at most once per `windowMs` (the lock notice once a
 * day, the "code wrong" notice once an hour). Kept in `security_notices`, so it holds across restarts and instances.
 */
export async function claimSecurityNotice(
  ctx: Ctx,
  userId: string,
  kind: string,
  windowMs: number,
): Promise<boolean> {
  const now = ctx.clock.now();
  const r = await one(
    ctx.pool,
    `INSERT INTO security_notices (user_id, kind, sent_at) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, kind) DO UPDATE SET sent_at = EXCLUDED.sent_at WHERE security_notices.sent_at <= $4
     RETURNING 1 AS ok`,
    [userId, kind, now, new Date(now.getTime() - windowMs)],
  );
  return !!r;
}

/** "Your password was changed" / "your two-factor login was reset" to the account's own address (R3). */
export async function sendPasswordChangedMail(
  ctx: Ctx,
  userId: string,
  how: PasswordChangeHow,
  ip?: string | null,
): Promise<void> {
  try {
    const u = await one<{ email: string; display_name: string }>(
      ctx.pool,
      'SELECT email, display_name FROM users WHERE id=$1',
      [userId],
    );
    if (!u) return;
    await sendSecurityMail(
      ctx,
      passwordChangedMail({
        to: u.email,
        name: u.display_name,
        when: ctx.clock.now(),
        ip: ip ?? null,
        how,
        origin: ctx.config.publicOrigin,
      }),
    );
  } catch (err) {
    ctx.log.warn({ err }, 'password changed mail failed');
  }
}
