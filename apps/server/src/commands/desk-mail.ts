import { randomUUID } from 'node:crypto';
import type { Ctx } from '../context.ts';
import { exec, one, rows } from '../db/sql.ts';
import type { MailMessage } from '../mail/mailer.ts';
import { type DeskMailItem, deskDigestMail, deskItemMail } from '../mail/templates.ts';
import { deskMailSettings, supportAddresses } from './support.ts';

/**
 * Desk mail (docs/design/desk-mail.md): every NEW desk item on a desk the platform operator works is mailed once to the
 * support address(es). A polling pass (the scheduler, every 15 s) outside any event transaction; `desk_mail_log` holds
 * the once-only marker (claimed before sending, so two servers never both mail an item, and a projection rebuild or a
 * reboot never re-sends).
 *
 * The super admin account itself has no desk (a platform account never joins an organization), so "the super user desk"
 * is the desk of the organizations the operator belongs to (scope `operator`: an Owner or Admin whose login is one of
 * the support addresses), or of every organization (scope `all`, the operator's choice).
 */

/** Items older than this when first seen are not mailed (a server that was off, or a support address set late). */
export const STALE_MS = 6 * 3_600_000;
/** Up to this many items in one pass get their own mail; more are listed in one digest. */
export const BURST_LIMIT = 3;
/** At most this many mails (a digest counts as one) go out per hour; the rest waits for the next hour. */
export const MAILS_PER_HOUR = 20;
const DIGEST_LIST_MAX = 25;

const KIND_LABELS: Record<string, string> = {
  question: 'Question',
  approval: 'Approval',
  escalation: 'Escalation',
  alert: 'Alert',
  rating: 'Rating',
  report: 'Report',
};

const label = (kind: string): string => KIND_LABELS[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);

/** Never mail a credential that slipped into an item's text. */
export function redact(s: string): string {
  return s
    .replace(/\b(?:sk|pk|ghp|gho|ghs|github_pat|xox[abpr]|AKIA)[-_A-Za-z0-9]{12,}/g, '[hidden]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [hidden]')
    .replace(/\b(password|passwd|secret|token|api[_-]?key)(\s*[:=]\s*)\S+/gi, '$1$2[hidden]');
}

const summaryOf = (body: string, doing: string): string => {
  const t = redact((body || doing || '').replace(/\s+/g, ' ').trim());
  return t.length > 280 ? `${t.slice(0, 277)}...` : t;
};

interface Candidate {
  id: string;
  kind: string;
  title: string;
  body: string;
  doing: string;
  blocking: boolean;
  pinned: boolean;
  status: string;
  created_at: Date;
  org_name: string | null;
  project_key: string | null;
  project_name: string | null;
  in_scope: boolean;
}

const priorityOf = (c: Pick<Candidate, 'blocking' | 'pinned'>): 'blocking' | 'pinned' | 'normal' =>
  c.blocking ? 'blocking' : c.pinned ? 'pinned' : 'normal';
const PRIORITY_LABEL = { blocking: 'Blocking', pinned: 'Urgent (pinned)', normal: 'Normal' } as const;

/** One pass. Returns how many mails went out and how many items were handled. */
export async function deskMailTick(ctx: Ctx): Promise<{ mails: number; items: number }> {
  const now = ctx.clock.now();
  const [addresses, settings] = await Promise.all([supportAddresses(ctx), deskMailSettings(ctx)]);
  const active = settings.deskMailEnabled && addresses.length > 0;
  const lower = addresses.map((a) => a.toLowerCase());

  const cands = await rows<Candidate>(
    ctx.pool,
    `SELECT d.id, d.kind, d.title, d.body, d.doing, d.blocking, d.pinned, d.status, d.created_at,
            o.name AS org_name, p.key AS project_key, p.name AS project_name,
            ($2::text = 'all' OR EXISTS (
               SELECT 1 FROM org_members om JOIN users u ON u.id = om.user_id
                WHERE om.org_id = d.org_id AND om.status = 'active' AND om.role IN ('owner','admin')
                  AND lower(u.email) = ANY($1::text[]))) AS in_scope
       FROM desk_items d
       LEFT JOIN organizations o ON o.id = d.org_id
       LEFT JOIN projects p ON p.id = d.project_id
      WHERE d.triage <> 'pending'
        AND NOT EXISTS (SELECT 1 FROM desk_mail_log l WHERE l.desk_item_id = d.id)
      ORDER BY d.created_at, d.id
      LIMIT 200`,
    [lower, settings.deskMailScope],
  );
  if (cands.length === 0) return { mails: 0, items: 0 };

  const skip = async (ids: string[]) => {
    if (ids.length === 0) return;
    await exec(
      ctx.pool,
      `INSERT INTO desk_mail_log (desk_item_id, state, mailed_at) SELECT unnest($1::uuid[]), 'skipped', $2 ON CONFLICT DO NOTHING`,
      [ids, now],
    );
  };

  const rank = { normal: 0, pinned: 1, blocking: 2 } as const;
  const minRank = { all: 0, pinned: 1, blocking: 2 }[settings.deskMailMinPriority];
  const skipped: string[] = [];
  const send: Candidate[] = [];
  for (const c of cands) {
    const tooOld = now.getTime() - c.created_at.getTime() > STALE_MS;
    if (!active || tooOld || c.status !== 'open' || !c.in_scope || rank[priorityOf(c)] < minRank)
      skipped.push(c.id);
    else send.push(c);
  }
  await skip(skipped);
  if (send.length === 0) return { mails: 0, items: skipped.length };

  // The hourly cap: what is left waits (and goes stale after STALE_MS) rather than flooding the inbox.
  const sentLastHour = Number(
    (
      await one(
        ctx.pool,
        `SELECT count(DISTINCT batch_id)::int AS n FROM desk_mail_log WHERE state <> 'skipped' AND mailed_at > $1`,
        [new Date(now.getTime() - 3_600_000)],
      )
    )?.n ?? 0,
  );
  const room = MAILS_PER_HOUR - sentLastHour;
  if (room <= 0) return { mails: 0, items: skipped.length };

  const origin = ctx.config.publicOrigin;
  const toItem = (c: Candidate): DeskMailItem => ({
    kindLabel: label(c.kind),
    title: redact(c.title),
    org: c.org_name ?? 'Unknown organization',
    project: c.project_name ? `${c.project_name}${c.project_key ? ` (${c.project_key})` : ''}` : null,
    priorityLabel: PRIORITY_LABEL[priorityOf(c)],
    summary: summaryOf(c.body, c.doing),
    link: `${origin}/desk#desk-item-${c.id}`,
  });

  /** Claim the items (the once-only marker), mail them, and give the claim back when no mail could be sent. */
  const deliver = async (
    group: Candidate[],
    state: 'sent' | 'digest',
    build: (to: string) => MailMessage,
  ): Promise<boolean> => {
    const batch = randomUUID();
    const claimed = await rows(
      ctx.pool,
      `INSERT INTO desk_mail_log (desk_item_id, state, batch_id, mailed_at)
         SELECT unnest($1::uuid[]), $2, $3, $4 ON CONFLICT DO NOTHING RETURNING desk_item_id`,
      [group.map((g) => g.id), state, batch, now],
    );
    if (claimed.length === 0) return false; // another server got there first
    let delivered = 0;
    for (const to of addresses) {
      try {
        await ctx.mailer.send(build(to));
        delivered++;
      } catch (err) {
        ctx.log.warn({ err, to }, 'desk mail was not sent');
      }
    }
    if (delivered === 0) await exec(ctx.pool, `DELETE FROM desk_mail_log WHERE batch_id=$1`, [batch]); // try again next pass
    return delivered > 0;
  };

  let mails = 0;
  if (send.length <= BURST_LIMIT && send.length <= room) {
    for (const c of send)
      if (await deliver([c], 'sent', (to) => deskItemMail({ to, item: toItem(c), origin }))) mails++;
  } else {
    const listed = send.slice(0, DIGEST_LIST_MAX).map(toItem);
    const more = send.length - listed.length;
    if (await deliver(send, 'digest', (to) => deskDigestMail({ to, items: listed, more, origin }))) mails++;
  }
  return { mails, items: skipped.length + send.length };
}
