import { type PlatformSettings, splitEmails } from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { exec, one } from '../db/sql.ts';
import type { MailMessage } from '../mail/mailer.ts';
import { securityNoticeMail } from '../mail/security-notices.ts';
import { resetAuditCursor } from './platform-notify.ts';

// The platform administrator's notification settings: who is mailed about new organizations, audit events and (in a
// hosted build) support requests. They live in `platform_settings`.

export async function sendQuietly(ctx: Ctx, msg: MailMessage): Promise<void> {
  try {
    await ctx.mailer.send(msg);
  } catch (err) {
    // a mail problem never loses the request or the notice
    ctx.log.warn({ err, to: msg.to, subject: msg.subject }, 'notification mail was not sent');
  }
}

export const NOTIFY_KEYS = {
  notifyNewOrgs: 'notify_new_orgs',
  notifyAuditEvents: 'notify_audit_events',
} as const;

/** An on/off platform setting; unset means off. */
export async function flagSetting(ctx: Ctx, key: string): Promise<boolean> {
  const r = await one(ctx.pool, `SELECT value FROM platform_settings WHERE key=$1`, [key]);
  return r?.value === true;
}

const SETTING_KEYS = { supportEmail: 'support_email', contactEmail: 'contact_email' } as const;

async function emailSetting(ctx: Ctx, key: string): Promise<string | null> {
  const r = await one(ctx.pool, `SELECT value FROM platform_settings WHERE key=$1`, [key]);
  const v = r?.value;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** The addresses new support requests (and follow-ups) are emailed to: the platform setting, else `AOM_SUPPORT_EMAIL`. */
export async function supportAddresses(ctx: Ctx): Promise<string[]> {
  return splitEmails((await emailSetting(ctx, 'support_email')) ?? ctx.config.supportEmail ?? null);
}

/** The addresses new Contact us messages (from visitors) go to: their own setting, else the support addresses. */
export async function contactAddresses(ctx: Ctx): Promise<string[]> {
  const own = splitEmails(await emailSetting(ctx, 'contact_email'));
  return own.length ? own : supportAddresses(ctx);
}

export async function platformSettings(ctx: Ctx): Promise<PlatformSettings> {
  return {
    supportEmail: await emailSetting(ctx, 'support_email'),
    contactEmail: await emailSetting(ctx, 'contact_email'),
    notifyNewOrgs: await flagSetting(ctx, NOTIFY_KEYS.notifyNewOrgs),
    notifyAuditEvents: await flagSetting(ctx, NOTIFY_KEYS.notifyAuditEvents),
  };
}

export async function patchPlatformSettings(
  ctx: Ctx,
  by: AuthSession['user'],
  patch: {
    supportEmail?: string | undefined;
    contactEmail?: string | undefined;
    notifyNewOrgs?: boolean | undefined;
    notifyAuditEvents?: boolean | undefined;
  },
): Promise<PlatformSettings> {
  const changed: Array<{ field: keyof typeof SETTING_KEYS; before: string[] }> = [];
  for (const field of Object.keys(NOTIFY_KEYS) as Array<keyof typeof NOTIFY_KEYS>) {
    const v = patch[field];
    if (v === undefined) continue;
    await exec(
      ctx.pool,
      `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, $4)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
      [NOTIFY_KEYS[field], JSON.stringify(v), by.id, ctx.clock.now()],
    );
    // Switching audit mail on starts from now: the history is never mailed.
    if (field === 'notifyAuditEvents' && v) await resetAuditCursor(ctx);
  }
  for (const field of Object.keys(SETTING_KEYS) as Array<keyof typeof SETTING_KEYS>) {
    const v = patch[field];
    if (v === undefined) continue;
    const key = SETTING_KEYS[field];
    const before = field === 'supportEmail' ? await supportAddresses(ctx) : await contactAddresses(ctx);
    changed.push({ field, before });
    if (v === '') await exec(ctx.pool, `DELETE FROM platform_settings WHERE key=$1`, [key]);
    else
      await exec(
        ctx.pool,
        `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, $4)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
        [key, JSON.stringify(splitEmails(v).join(', ')), by.id, ctx.clock.now()],
      );
  }
  for (const c of changed) {
    const after = c.field === 'supportEmail' ? await supportAddresses(ctx) : await contactAddresses(ctx);
    await mailOldAddresses(ctx, c.field, c.before, after, by);
  }
  return platformSettings(ctx);
}

/**
 * R17-7: changing where support (or Contact us) mail goes tells the addresses that received it until now, so a
 * compromised super admin cannot quietly steer the notices away. Nothing is sent when the addresses stay the same.
 */
async function mailOldAddresses(
  ctx: Ctx,
  field: keyof typeof SETTING_KEYS,
  before: string[],
  after: string[],
  by: AuthSession['user'],
): Promise<void> {
  const same = before.length === after.length && before.every((a) => after.includes(a));
  if (same) return;
  const label = field === 'supportEmail' ? 'support' : 'Contact us';
  for (const to of before)
    await sendQuietly(
      ctx,
      securityNoticeMail({
        to,
        subject: `The ${label} address of ${ctx.config.publicOrigin} changed`,
        heading: `The ${label} address changed`,
        paragraphs: [
          `${label === 'support' ? 'Support requests and platform notices' : 'Contact us messages'} for ${ctx.config.publicOrigin} no longer come to this address only.`,
          'If you did not expect this, check the platform account that made the change.',
        ],
        facts: [
          ['Before', before.join(', ') || '(none)'],
          ['Now', after.join(', ') || '(none)'],
          ['Changed by', by.email],
        ],
        origin: ctx.config.publicOrigin,
      }),
    );
}
