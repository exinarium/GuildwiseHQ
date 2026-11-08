import { randomUUID } from 'node:crypto';
import {
  DESK_SUBKIND,
  type FormDefinition,
  FormDefinitionSchema,
  OFFLINE_MAX_RESENDS,
  type OfflineNoticeInput,
  offlineNoticeText,
  streamId,
} from '@aom/shared';
import { orgRoleOf, type Who } from '../auth/org-context.ts';
import { decryptFor } from '../auth/secrets.ts';
import type { Ctx } from '../context.ts';
import { one, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, forbidden, HttpError, notFound } from '../errors.ts';
import { defaultAddressee } from '../journeys/waits.ts';
import { formSecureLinkMail } from '../mail/templates.ts';
import { orgScope, projectScope, SYSTEM_ACTOR, userActor } from './common.ts';
import { ev, lockInstance } from './journey-runtime.ts';
import { clientLinkUrl, createClientLinkIn, destinationsOf, revokeClientLinkIn } from './public-forms.ts';

/** The purpose key of the held email (auth/secrets.ts `encryptFor`). */
export const OFFLINE_EMAIL_PURPOSE = 'form-offline-contact';

const DAY = 86_400_000;
const CLAIM_STALE_MS = 5 * 60_000;
const BACKOFF_MIN = [1, 5, 15, 60];
const MAX_ATTEMPTS = 5;
const PRUNE_DAYS = 30;

type CaseResult = 'submitted' | 'continued' | 'expired' | 'failed' | 'cancelled';

/** Days the secure link of a form lasts: the form setting, else the server default. */
export function offlineLinkDays(ctx: Ctx, def: FormDefinition): number {
  return def.settings.offlineLinkDays ?? ctx.config.publicForms.offlineLinkDays;
}

/**
 * The storage workstations a form's published version writes to: the answers destination and every file field's.
 * `missing` when one has no active connection (that is "destination missing", not "offline").
 */
export async function destinationWorkstations(
  ctx: Ctx,
  orgId: string,
  def: FormDefinition,
): Promise<{ missing: boolean; workstations: string[] }> {
  const ids = new Set<string>();
  let missing = false;
  for (const d of destinationsOf(def)) {
    if (d.connectionId) ids.add(d.connectionId);
    else missing = true;
  }
  const r = ids.size
    ? await rows(
        ctx.pool,
        `SELECT id, workstation_id FROM storage_connections WHERE org_id=$1 AND status='active' AND id = ANY($2::uuid[])`,
        [orgId, [...ids]],
      )
    : [];
  if (r.length !== ids.size) missing = true;
  return { missing, workstations: [...new Set(r.map((x) => x.workstation_id as string))] };
}

async function publishedDefinition(
  ctx: Ctx,
  orgId: string,
  formId: string,
): Promise<{ version: number; publishedBy: string; def: FormDefinition; title: string } | null> {
  const p = await one(
    ctx.pool,
    `SELECT p.version, p.published_by, v.definition
       FROM form_publications p
       JOIN forms f ON f.id = p.form_id
       JOIN form_versions v ON v.form_id = p.form_id AND v.org_id = p.org_id AND v.version = p.version
      WHERE p.form_id=$1 AND p.org_id=$2 AND p.status='published' AND f.status='active'`,
    [formId, orgId],
  );
  if (!p) return null;
  const def = FormDefinitionSchema.parse(p.definition);
  return { version: p.version, publishedBy: p.published_by, def, title: def.settings.title };
}

const formEvent = (orgId: string, formId: string, event: any, by?: string) => ({
  streamId: streamId.form(formId),
  event,
  actor: by ? userActor(by) : SYSTEM_ACTOR,
  scope: orgScope(orgId),
});

/** Closes a case in `tx`: the email and its dedupe hash are cleared in the same transaction. */
async function closeCase(
  ctx: Ctx,
  tx: Tx,
  c: Row,
  status: CaseResult,
  opts: { error?: string; submissionId?: string; by?: string } = {},
): Promise<void> {
  const now = ctx.clock.now();
  await tx.query(
    `UPDATE form_offline_requests
        SET status=$2, email_enc=NULL, email_key=NULL, error_code=COALESCE($3, error_code),
            submission_id=COALESCE($4::uuid, submission_id), submitted_at=CASE WHEN $2='submitted' THEN $5 ELSE submitted_at END,
            closed_at=$5, updated_at=$5
      WHERE id=$1`,
    [c.id, status, opts.error ?? null, opts.submissionId ?? null, now],
  );
  await ctx.store.append(
    [
      formEvent(
        c.org_id,
        c.form_id,
        {
          type: 'FormOfflineClosed',
          payload: {
            requestId: c.id,
            formId: c.form_id,
            result: status,
            ...(opts.submissionId ? { submissionId: opts.submissionId } : {}),
            ...(opts.by ? { by: opts.by } : {}),
          },
        },
        opts.by,
      ),
    ],
    { tx },
  );
}

interface CaseContext {
  title: string;
  clientReference: string | null;
  recordName: string | null;
  journeyName: string | null;
  inst: Row | null;
}

async function contextOf(tx: Tx, c: Row, title: string): Promise<CaseContext> {
  let clientReference: string | null = null;
  if (c.origin_link_id) {
    const l = await one(tx, 'SELECT reference FROM form_client_links WHERE id=$1', [c.origin_link_id]);
    clientReference = (l?.reference as string | undefined) ?? null;
  }
  let inst: Row | null = null;
  let recordName: string | null = null;
  let journeyName: string | null = null;
  if (c.journey_instance_id) {
    inst = (await one(tx, 'SELECT * FROM journey_instances WHERE id=$1', [c.journey_instance_id])) ?? null;
    if (inst) {
      const r = await one(tx, 'SELECT display_name FROM journey_records WHERE id=$1', [inst.record_id]);
      recordName = (r?.display_name as string | undefined) ?? null;
      const j = await one(tx, 'SELECT name FROM journeys WHERE id=$1', [inst.journey_id]);
      journeyName = (j?.name as string | undefined) ?? null;
    }
  }
  return { title, clientReference, recordName, journeyName, inst };
}

/**
 * One desk alert for a case. Never takes the email address. A journey case is raised on the instance's project and
 * addressed to the default addressee (so they can press Continue); the wait id in `data` closes it with the wait.
 */
async function raiseCaseAlert(
  ctx: Ctx,
  tx: Tx,
  c: Row,
  cx: CaseContext,
  kind: OfflineNoticeInput['kind'],
  extra: { linkSentAt?: Date; linkExpiresAt?: Date } = {},
): Promise<string> {
  const text = offlineNoticeText({
    kind,
    formTitle: cx.title,
    clientReference: cx.clientReference,
    recordName: cx.recordName,
    journeyName: cx.journeyName,
    holdDays: ctx.config.publicForms.offlineHoldDays,
    journey: !!c.journey_wait_id,
  });
  const deskItemId = randomUUID();
  const addressee = cx.inst ? await defaultAddressee(tx, cx.inst) : undefined;
  const data: Record<string, string> = {
    requestId: c.id,
    formId: c.form_id,
    formTitle: cx.title,
    attemptedAt: new Date(c.attempted_at).toISOString(),
  };
  if (cx.clientReference) data.clientReference = cx.clientReference;
  if (cx.recordName) data.recordName = cx.recordName;
  if (extra.linkSentAt) data.linkSentAt = extra.linkSentAt.toISOString();
  if (extra.linkExpiresAt) data.linkExpiresAt = extra.linkExpiresAt.toISOString();
  if (cx.journeyName) data.journeyName = cx.journeyName;
  if (c.journey_instance_id) data.instanceId = c.journey_instance_id;
  if (c.journey_wait_id) data.waitId = c.journey_wait_id;
  if (cx.inst?.current_step_id) data.stepId = cx.inst.current_step_id;
  if (cx.inst?.record_id) data.recordId = cx.inst.record_id;
  await ctx.store.append(
    [
      {
        streamId: streamId.desk(deskItemId),
        event: {
          type: 'DeskItemCreated',
          payload: {
            deskItemId,
            kind: 'alert',
            subkind: kind === 'sent' ? DESK_SUBKIND.formOfflineLink : DESK_SUBKIND.formOfflineHoldExpired,
            title: text.title,
            body: text.body,
            options: [{ id: 'dismiss', label: 'Dismiss', description: 'Close this notice.' }],
            blocking: false,
            pinned: false,
            affectedCardIds: [],
            askedBy: { kind: 'system' },
            ...(cx.inst ? { projectId: cx.inst.project_id } : {}),
            ...(addressee ? { addresseeUserId: addressee } : {}),
            subjectKey: `form-offline:${c.id}${kind === 'sent' ? '' : `:${kind}`}`,
            data,
          },
        },
        actor: SYSTEM_ACTOR,
        scope: cx.inst ? projectScope(cx.inst.org_id, cx.inst.project_id) : orgScope(c.org_id),
      },
    ],
    { tx },
  );
  return deskItemId;
}

async function closeCaseDeskItem(ctx: Ctx, tx: Tx, c: Row, note: string): Promise<void> {
  if (!c.desk_item_id) return;
  const d = await one(tx, `SELECT org_id, project_id FROM desk_items WHERE id=$1 AND status='open'`, [
    c.desk_item_id,
  ]);
  if (!d) return;
  await ctx.store.append(
    [
      {
        streamId: streamId.desk(c.desk_item_id),
        event: {
          type: 'DeskItemResolved',
          payload: { deskItemId: c.desk_item_id, resolution: 'acknowledged', note, by: { kind: 'system' } },
        },
        actor: SYSTEM_ACTOR,
        scope: d.project_id ? projectScope(d.org_id, d.project_id) : orgScope(d.org_id),
      },
    ],
    { tx },
  );
}

// ------------------------------------------------------------------------------------------------ the sweep

/**
 * Sends the secure links of cases whose runner is back, and closes the cases that are done. Idempotent: every pass
 * is safe to repeat, from any number of processes. A case leaves `held` once (the claim), its link is made once, and
 * its desk alert is raised in the transaction that marks it `sent`.
 */
export async function sweepFormsOffline(ctx: Ctx): Promise<void> {
  await reclaimStale(ctx);
  await closeFinished(ctx);
  await sendDue(ctx);
  await pruneOffline(ctx);
}

async function reclaimStale(ctx: Ctx): Promise<void> {
  const cutoff = new Date(ctx.clock.now().getTime() - CLAIM_STALE_MS);
  await ctx.pool.query(
    `UPDATE form_offline_requests SET status='held', updated_at=$2 WHERE status='sending' AND updated_at < $1`,
    [cutoff, ctx.clock.now()],
  );
}

async function pruneOffline(ctx: Ctx): Promise<void> {
  await ctx.pool.query(`DELETE FROM form_offline_requests WHERE closed_at IS NOT NULL AND closed_at < $1`, [
    new Date(ctx.clock.now().getTime() - PRUNE_DAYS * DAY),
  ]);
}

/** Cases that ended without a send: hold ran out, link used or expired, wait ended, wait re-pointed, form unpublished. */
async function closeFinished(ctx: Ctx): Promise<void> {
  const open = await rows(
    ctx.pool,
    `SELECT id FROM form_offline_requests WHERE status IN ('held','sent') ORDER BY attempted_at LIMIT 200`,
  );
  for (const o of open) {
    try {
      await withAppendTx(ctx.pool, async (tx) => {
        const c = await one(
          tx,
          `SELECT * FROM form_offline_requests WHERE id=$1 AND status IN ('held','sent') FOR UPDATE`,
          [o.id],
        );
        if (!c) return;
        const now = ctx.clock.now();
        // a. the secure link was used
        if (c.link_id) {
          const l = await one(tx, 'SELECT used_by_submission FROM form_client_links WHERE id=$1', [
            c.link_id,
          ]);
          if (l?.used_by_submission) {
            await closeCaseDeskItemIfPublic(ctx, tx, c, 'Submission received.');
            await closeCase(ctx, tx, c, 'submitted', { submissionId: String(l.used_by_submission) });
            return;
          }
        }
        // b/c. the form wait of a journey case ended, or points at another link
        if (c.journey_wait_id) {
          const w = await one(tx, 'SELECT status, resolution, link_id FROM journey_waits WHERE id=$1', [
            c.journey_wait_id,
          ]);
          const open2 = w && (w.status === 'open' || w.status === 'escalated');
          if (!open2) {
            const how =
              w?.resolution === 'continued' || w?.resolution === 'form_submitted' ? 'continued' : 'cancelled';
            await closeCase(ctx, tx, c, how);
            return;
          }
          if (c.link_id && w.link_id !== c.link_id) {
            await closeCase(ctx, tx, c, 'cancelled', { error: 'link_replaced' });
            return;
          }
        }
        // unpublished (or archived) form
        const pub = await publishedDefinition(ctx, c.org_id, c.form_id);
        if (!pub) {
          const cx = await contextOf(tx, c, 'a form');
          await closeCase(ctx, tx, c, 'cancelled', { error: 'form_unpublished' });
          await raiseCaseAlert(ctx, tx, c, cx, 'cancelled');
          return;
        }
        // hold ran out (never sent)
        if (c.status === 'held' && new Date(c.hold_expires_at).getTime() <= now.getTime()) {
          const cx = await contextOf(tx, c, pub.title);
          await closeCase(ctx, tx, c, 'expired', { error: 'hold_expired' });
          await raiseCaseAlert(ctx, tx, c, cx, 'hold_expired');
          return;
        }
        // link expired unused
        if (
          c.status === 'sent' &&
          c.link_expires_at &&
          new Date(c.link_expires_at).getTime() <= now.getTime()
        ) {
          const cx = await contextOf(tx, c, pub.title);
          await closeCaseDeskItemIfPublic(ctx, tx, c, 'The secure link expired unused.');
          await closeCase(ctx, tx, c, 'expired', { error: 'link_expired' });
          await raiseCaseAlert(ctx, tx, c, cx, 'link_expired');
        }
      });
    } catch (err) {
      ctx.log.error({ err, requestId: o.id }, 'offline form case check failed');
    }
  }
}

/** A journey case's alert closes with its wait; a public-URL case's alert is closed here. */
async function closeCaseDeskItemIfPublic(ctx: Ctx, tx: Tx, c: Row, note: string): Promise<void> {
  if (c.journey_wait_id) return;
  await closeCaseDeskItem(ctx, tx, c, note);
}

async function sendDue(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now();
  const settle = new Date(now.getTime() - ctx.config.publicForms.offlineSettleSec * 1000);
  const due = await rows(
    ctx.pool,
    `SELECT id, org_id, form_id FROM form_offline_requests
      WHERE status='held' AND (next_attempt_at IS NULL OR next_attempt_at <= $1) AND hold_expires_at > $1
      ORDER BY attempted_at LIMIT 50`,
    [now],
  );
  for (const d of due) {
    try {
      const pub = await publishedDefinition(ctx, d.org_id, d.form_id);
      if (!pub) continue; // closeFinished cancels it
      const dest = await destinationWorkstations(ctx, d.org_id, pub.def);
      if (dest.missing || dest.workstations.length === 0) continue;
      const up = await one(
        ctx.pool,
        `SELECT count(*)::int AS n FROM workstations
          WHERE id = ANY($1::uuid[]) AND status='active' AND connected=true AND connected_at <= $2`,
        [dest.workstations, settle],
      );
      if (up?.n !== dest.workstations.length) continue;
      await sendOne(ctx, d.id, pub);
    } catch (err: any) {
      ctx.log.error({ requestId: d.id, code: err?.code ?? null }, 'offline form link failed');
    }
  }
}

/** Claim, make the link once, mail it, then mark it sent and raise the alert. */
async function sendOne(
  ctx: Ctx,
  id: string,
  pub: { version: number; publishedBy: string; def: FormDefinition; title: string },
): Promise<void> {
  const claimed = await ctx.pool.query(
    `UPDATE form_offline_requests SET status='sending', updated_at=$2 WHERE id=$1 AND status='held' RETURNING *`,
    [id, ctx.clock.now()],
  );
  const c = claimed.rows[0] as Row | undefined;
  if (!c) return; // another pass or process has it

  // Step 3: the link, once. A reclaimed row reuses the stored one.
  const issued = await withAppendTx(ctx.pool, async (tx) => {
    const cur = (await one(tx, 'SELECT * FROM form_offline_requests WHERE id=$1 FOR UPDATE', [id])) as Row;
    if (cur.link_id) return { linkId: cur.link_id as string, expiresAt: new Date(cur.link_expires_at) };
    const now = ctx.clock.now();
    let by = pub.publishedBy;
    let inst: Row | null = null;
    let wait: Row | null = null;
    if (cur.journey_wait_id) {
      wait =
        (await one(
          tx,
          `SELECT * FROM journey_waits WHERE id=$1 AND status IN ('open','escalated') FOR UPDATE`,
          [cur.journey_wait_id],
        )) ?? null;
      inst = wait ? await lockInstance(tx, wait.instance_id, wait.visit, 'waiting') : null;
      if (!wait || !inst) {
        // the wait already ended: the case closes in the next pass
        await tx.query(`UPDATE form_offline_requests SET status='held', updated_at=$2 WHERE id=$1`, [
          id,
          now,
        ]);
        return null;
      }
      by = inst.started_by;
    }
    const expiresAt = new Date(now.getTime() + offlineLinkDays(ctx, pub.def) * DAY);
    const l = await createClientLinkIn(tx, ctx, {
      orgId: cur.org_id,
      formId: cur.form_id,
      by,
      reference: (await referenceOf(tx, cur)).slice(0, 120),
      recordKind: cur.record_kind ?? undefined,
      recordId: cur.record_id ?? undefined,
      expiresAt,
      purpose: 'offline',
      offlineRequestId: id,
    });
    if (wait && inst) {
      const formId = (wait.config as { waitFor?: { formId?: string } })?.waitFor?.formId ?? cur.form_id;
      if (wait.link_id)
        await revokeClientLinkIn(tx, ctx, { orgId: cur.org_id, formId, linkId: wait.link_id, by });
      await ctx.store.append(
        [
          ev(inst, {
            type: 'JourneyWaitLinkSent',
            payload: {
              waitId: wait.id,
              linkId: l.linkId,
              via: 'offline_email',
              expiresAt: expiresAt.toISOString(),
            },
          }),
        ],
        { tx },
      );
    }
    await tx.query(
      `UPDATE form_offline_requests SET link_id=$2, link_expires_at=$3, updated_at=$4 WHERE id=$1`,
      [id, l.linkId, expiresAt, now],
    );
    return { linkId: l.linkId, expiresAt };
  });
  if (!issued) return;

  // Step 4: the mail. Only the firm name and the link.
  let sent = false;
  let keyUnreadable = false;
  try {
    const email = await decryptFor(ctx, OFFLINE_EMAIL_PURPOSE, id, c.email_enc);
    const url = await clientLinkUrl(ctx, c.org_id, c.form_id, issued.linkId);
    if (!url) throw new Error('link not available');
    await ctx.mailer.send(
      formSecureLinkMail({
        to: email,
        firmName: await firmName(ctx, c.org_id),
        link: url,
        expiresAt: issued.expiresAt,
        origin: ctx.config.publicOrigin,
      }),
    );
    sent = true;
  } catch (err: any) {
    keyUnreadable = /unsupported state|unable to authenticate|unknown secret format|bad decrypt/i.test(
      String(err?.message),
    );
    ctx.log.warn({ requestId: id, keyUnreadable }, 'offline form link mail failed');
  }

  await withAppendTx(ctx.pool, async (tx) => {
    const cur = (await one(tx, 'SELECT * FROM form_offline_requests WHERE id=$1 FOR UPDATE', [id])) as Row;
    if (cur.status !== 'sending') return;
    const now = ctx.clock.now();
    const cx = await contextOf(tx, cur, pub.title);
    if (sent) {
      const deskItemId = await raiseCaseAlert(ctx, tx, cur, cx, 'sent', {
        linkSentAt: now,
        linkExpiresAt: issued.expiresAt,
      });
      await tx.query(
        `UPDATE form_offline_requests SET status='sent', link_sent_at=$2, desk_item_id=$3, updated_at=$2, next_attempt_at=NULL WHERE id=$1`,
        [id, now, deskItemId],
      );
      await ctx.store.append(
        [
          formEvent(cur.org_id, cur.form_id, {
            type: 'FormOfflineLinkSent',
            payload: {
              requestId: id,
              formId: cur.form_id,
              linkId: issued.linkId,
              sentAt: now.toISOString(),
              expiresAt: issued.expiresAt.toISOString(),
            },
          }),
        ],
        { tx },
      );
      return;
    }
    const attempts = (cur.attempts as number) + 1;
    if (keyUnreadable || attempts >= MAX_ATTEMPTS) {
      await tx.query(`UPDATE form_offline_requests SET attempts=$2 WHERE id=$1`, [id, attempts]);
      await closeCase(ctx, tx, cur, 'failed', { error: keyUnreadable ? 'key_unreadable' : 'mail_failed' });
      await raiseCaseAlert(ctx, tx, cur, cx, 'failed');
      return;
    }
    const wait = BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)] as number;
    await tx.query(
      `UPDATE form_offline_requests SET status='held', attempts=$2, next_attempt_at=$3, updated_at=$4 WHERE id=$1`,
      [id, attempts, new Date(now.getTime() + wait * 60_000), now],
    );
  });
}

async function referenceOf(tx: Tx, c: Row): Promise<string> {
  if (!c.origin_link_id) return 'public';
  const l = await one(tx, 'SELECT reference FROM form_client_links WHERE id=$1', [c.origin_link_id]);
  return (l?.reference as string | undefined) ?? 'public';
}

async function firmName(ctx: Ctx, orgId: string): Promise<string> {
  const o = await one(ctx.pool, 'SELECT name FROM organizations WHERE id=$1', [orgId]);
  return (o?.name as string | undefined) ?? '';
}

// ------------------------------------------------------------------------------------------------ the service

export interface FormsOfflineService {
  /** A runner (re)connected: look again after the settle delay. */
  onReconnect(workstationId: string): void;
}

export function createFormsOfflineService(ctx: Ctx): FormsOfflineService {
  return {
    onReconnect: () => {
      const t = setTimeout(
        () => void sweepFormsOffline(ctx).catch((err) => ctx.log.error({ err }, 'offline form sweep failed')),
        ctx.config.publicForms.offlineSettleSec * 1000 + 1000,
      );
      t.unref();
    },
  };
}

// ------------------------------------------------------------------------------------------------ the desk (A2)

async function ownerOrAdmin(ctx: Ctx, who: Who): Promise<void> {
  const role = await orgRoleOf(ctx.pool, who.userId, who.orgId);
  if (role !== 'owner' && role !== 'admin') throw forbidden('only an Owner or Admin can do this');
}

async function openCase(ctx: Ctx, who: Who, id: string): Promise<Row> {
  const c = await one(ctx.pool, 'SELECT * FROM form_offline_requests WHERE id=$1 AND org_id=$2', [
    id,
    who.orgId,
  ]);
  if (!c) throw notFound('case not found');
  if (!['held', 'sending', 'sent'].includes(c.status) || !c.email_enc)
    throw badRequest('case_closed', 'This case is closed and the email address has been deleted.');
  return c;
}

/** Show email: decrypted on request, audited without the address, never stored in a desk item. */
export async function showOfflineEmail(ctx: Ctx, who: Who, id: string): Promise<{ email: string }> {
  await ownerOrAdmin(ctx, who);
  const c = await openCase(ctx, who, id);
  let email: string;
  try {
    email = await decryptFor(ctx, OFFLINE_EMAIL_PURPOSE, c.id, c.email_enc);
  } catch {
    throw badRequest('email_unreadable', 'The email address can no longer be read.');
  }
  await withAppendTx(ctx.pool, (tx) =>
    ctx.store.append(
      [
        formEvent(
          c.org_id,
          c.form_id,
          { type: 'FormOfflineEmailViewed', payload: { requestId: c.id, formId: c.form_id, by: who.userId } },
          who.userId,
        ),
      ],
      { tx },
    ),
  );
  return { email };
}

/** Resend link: the same link, while it is unused and unexpired, at most three times. */
export async function resendOfflineLink(ctx: Ctx, who: Who, id: string): Promise<{ resends: number }> {
  await ownerOrAdmin(ctx, who);
  const c = await openCase(ctx, who, id);
  if (c.status !== 'sent' || !c.link_id)
    throw badRequest('not_sent', 'The secure link has not been sent yet.');
  if (c.resends >= OFFLINE_MAX_RESENDS)
    throw badRequest('resend_limit', `The link was already sent again ${OFFLINE_MAX_RESENDS} times.`);
  const l = await one(ctx.pool, 'SELECT used_at, revoked_at, expires_at FROM form_client_links WHERE id=$1', [
    c.link_id,
  ]);
  if (!l || l.used_at || l.revoked_at || new Date(l.expires_at).getTime() <= ctx.clock.now().getTime())
    throw badRequest('link_not_usable', 'The secure link is used, revoked or expired.');
  let email: string;
  try {
    email = await decryptFor(ctx, OFFLINE_EMAIL_PURPOSE, c.id, c.email_enc);
  } catch {
    throw badRequest('email_unreadable', 'The email address can no longer be read.');
  }
  const url = await clientLinkUrl(ctx, c.org_id, c.form_id, c.link_id);
  if (!url) throw badRequest('link_not_usable', 'The form is not published.');
  // reserve a resend first, so a failing mail server cannot be used to send without limit
  const n = await withAppendTx(ctx.pool, async (tx) => {
    const r = await tx.query(
      `UPDATE form_offline_requests SET resends=resends+1, updated_at=$2 WHERE id=$1 AND resends < $3 AND status='sent' RETURNING resends`,
      [c.id, ctx.clock.now(), OFFLINE_MAX_RESENDS],
    );
    return (r.rows[0]?.resends as number | undefined) ?? null;
  });
  if (!n) throw badRequest('resend_limit', `The link was already sent again ${OFFLINE_MAX_RESENDS} times.`);
  try {
    await ctx.mailer.send(
      formSecureLinkMail({
        to: email,
        firmName: await firmName(ctx, c.org_id),
        link: url,
        expiresAt: new Date(l.expires_at),
        origin: ctx.config.publicOrigin,
      }),
    );
  } catch {
    // The transport error can quote the recipient: never log, return or rethrow it.
    try {
      await ctx.pool.query(
        'UPDATE form_offline_requests SET resends=resends-1, updated_at=$2 WHERE id=$1 AND resends > 0',
        [c.id, ctx.clock.now()],
      );
    } catch {
      // the resend stays used up: fails safe
    }
    ctx.log.warn({ requestId: c.id }, 'offline form link resend failed');
    throw new HttpError(503, 'mail_failed', 'The link could not be sent. Try again later.');
  }
  await withAppendTx(ctx.pool, async (tx) => {
    await ctx.store.append(
      [
        formEvent(
          c.org_id,
          c.form_id,
          {
            type: 'FormOfflineLinkResent',
            payload: { requestId: c.id, formId: c.form_id, by: who.userId, n },
          },
          who.userId,
        ),
      ],
      { tx },
    );
  });
  return { resends: n };
}

/** Cancel: the case closes, the email is cleared and the link is revoked. A journey wait keeps running. */
export async function cancelOfflineRequest(ctx: Ctx, who: Who, id: string): Promise<void> {
  await ownerOrAdmin(ctx, who);
  await openCase(ctx, who, id);
  await withAppendTx(ctx.pool, async (tx) => {
    const cur = await one(
      tx,
      `SELECT * FROM form_offline_requests WHERE id=$1 AND status IN ('held','sending','sent') FOR UPDATE`,
      [id],
    );
    if (!cur) return;
    if (cur.link_id)
      await revokeClientLinkIn(tx, ctx, {
        orgId: cur.org_id,
        formId: cur.form_id,
        linkId: cur.link_id,
        by: who.userId,
      });
    await closeCaseDeskItemIfPublic(ctx, tx, cur, 'Cancelled.');
    await closeCase(ctx, tx, cur, 'cancelled', { by: who.userId });
  });
}
