import type { Ctx } from '../context.ts';
import { exec, one, rows } from '../db/sql.ts';
import { platformNoticeMail } from '../mail/templates.ts';
import { flagSetting, NOTIFY_KEYS, sendQuietly, supportAddresses } from './support.ts';

/**
 * Optional mail to the support address(es) about what happens on the super admin console beyond tickets and Contact us
 * (those always mail, see support.ts): new organizations and sign-ups, and platform audit events. Both are switches
 * on the Support page, off by default. Every mail is sent after the event's transaction has committed; a mail that
 * fails is logged and never fails the action.
 */

const CURSOR_KEY = 'notify_audit_cursor';
const MAX_PER_TICK = 20;

async function notify(
  ctx: Ctx,
  n: { subject: string; heading: string; facts: Array<[string, string]>; path: string; linkLabel: string },
): Promise<void> {
  const origin = ctx.config.publicOrigin;
  for (const to of await supportAddresses(ctx))
    await sendQuietly(
      ctx,
      platformNoticeMail({
        to,
        subject: n.subject,
        heading: n.heading,
        facts: n.facts,
        link: `${origin}${n.path}`,
        linkLabel: n.linkLabel,
        origin,
      }),
    );
}

/** An invitation was accepted: a new organization (and its Owner) or a person joining one. One mail per acceptance. */
export async function notifySignup(
  ctx: Ctx,
  s: { kind: string; email: string; displayName: string; orgName: string | null },
): Promise<void> {
  try {
    if (!(await flagSetting(ctx, NOTIFY_KEYS.notifyNewOrgs))) return;
    const org = s.orgName ?? 'an organization';
    const newOrg = s.kind === 'new_org' || s.kind === 'legacy';
    await notify(ctx, {
      subject: newOrg ? `New organization: ${org}` : `New member in ${org}: ${s.displayName}`,
      heading: newOrg ? 'A new organization signed up' : 'An invitation was accepted',
      facts: [
        ['Organization', org],
        ['Person', `${s.displayName} <${s.email}>`],
        ['What', newOrg ? 'Organization created, the person is its Owner' : 'Joined by invitation'],
      ],
      path: '/platform/organizations',
      linkLabel: 'Open the organizations',
    });
  } catch (err) {
    ctx.log.warn({ err }, 'sign-up notification failed');
  }
}

/** Marks everything in the audit log up to now as seen (called when the switch is turned on). */
export async function resetAuditCursor(ctx: Ctx): Promise<void> {
  const m = await one(ctx.pool, `SELECT coalesce(max(seq), 0)::text AS seq FROM platform_audit_log`);
  await exec(
    ctx.pool,
    `INSERT INTO platform_settings (key, value, updated_at) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [CURSOR_KEY, JSON.stringify(String(m?.seq ?? '0')), ctx.clock.now()],
  );
}

/** Mails each new platform audit entry once (the cursor moves first, so a crash never mails twice). */
export async function auditMailTick(ctx: Ctx): Promise<number> {
  if (!(await flagSetting(ctx, NOTIFY_KEYS.notifyAuditEvents))) return 0;
  const c = await one(ctx.pool, `SELECT value FROM platform_settings WHERE key=$1`, [CURSOR_KEY]);
  if (typeof c?.value !== 'string') {
    await resetAuditCursor(ctx);
    return 0;
  }
  const entries = await rows(
    ctx.pool,
    `SELECT a.seq::text AS seq, a.at, a.action, a.summary, a.actor_kind, u.display_name AS actor, o.name AS org_name
       FROM platform_audit_log a LEFT JOIN users u ON u.id = a.actor_user_id LEFT JOIN organizations o ON o.id = a.org_id
      WHERE a.seq > $1::bigint ORDER BY a.seq LIMIT ${MAX_PER_TICK}`,
    [c.value],
  );
  for (const e of entries) {
    await exec(ctx.pool, `UPDATE platform_settings SET value=$2::jsonb WHERE key=$1`, [
      CURSOR_KEY,
      JSON.stringify(e.seq),
    ]);
    await notify(ctx, {
      subject: `Platform audit: ${e.summary}`,
      heading: 'Platform audit event',
      facts: [
        ['Event', e.summary],
        ['Action', e.action],
        ['By', e.actor_kind === 'system' ? 'The system' : (e.actor ?? 'a super admin')],
        ...(e.org_name ? ([['Organization', e.org_name]] as Array<[string, string]>) : []),
        ['At', new Date(e.at).toISOString()],
      ],
      path: '/platform/audit',
      linkLabel: 'Open the audit log',
    });
  }
  return entries.length;
}
