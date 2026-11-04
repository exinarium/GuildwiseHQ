import { randomUUID } from 'node:crypto';
import {
  type JourneyApprover,
  type JourneyDefinition,
  type JourneyWaitStep,
  type TimeoutAction,
  dateWaitFireAt,
  deadlineOf,
  durationMs,
  timeoutDecision,
  type WaitView,
} from '@aom/shared';
import { advanceIn, cancelInstanceIn, ev, kindOf, lockInstance, loadDefinition, Refused } from '../commands/journey-runtime.ts';
import { createClientLinkIn, revokeClientLinkIn } from '../commands/public-forms.ts';
import type { Ctx } from '../context.ts';
import { one, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { conflict } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { resolveJourneyApprover } from './approvers.ts';
import { deskQuestion, resolveDeskEvent } from './desk.ts';
import { endWaitSideEffects } from './wait-effects.ts';

const DAY = 86_400_000;
const iso = (d: Date): string => d.toISOString();

const ESCALATION_OPTIONS = [
  { id: 'extend', label: 'Extend', description: 'Wait longer.' },
  { id: 'continue', label: 'Continue now', description: 'Stop waiting and go on.' },
  { id: 'goto', label: 'Go to step', description: 'Go to another step of the journey.' },
  { id: 'cancel', label: 'Cancel the journey', description: 'End the journey here.' },
];

/** Who is asked when nothing else says: the project owner (falls back to the organization Owner). */
export async function defaultAddressee(db: Tx, inst: Row, to?: JourneyApprover): Promise<string> {
  const r = await resolveJourneyApprover(db, inst, to ?? { kind: 'project_owner' });
  return r.userIds[0] as string;
}

const GATE_REMINDER_OPTIONS = [
  { id: 'approve', label: 'Approve', description: 'Let the journey go on.' },
  { id: 'reject', label: 'Reject', description: 'Stop here: the journey follows its reject handoff. A note is required.' },
];

/** The longest time a wait with reminders can last, for the link's expiry. */
function lastDeadline(startedAt: Date, step: JourneyWaitStep): Date {
  const d = step.duration ? durationMs(step.duration) : 0;
  const t = step.onTimeout;
  if (t?.action === 'remind') {
    const every = t.every ? durationMs(t.every) : d;
    return new Date(startedAt.getTime() + d + every * t.maxReminders);
  }
  return new Date(startedAt.getTime() + d);
}

function escalationEvents(
  ctx: Ctx,
  inst: Row,
  w: { id: string; step_id: string; kind?: string },
  addressee: string,
  reason: 'timeout' | 'date_missing',
  firedFor: string | undefined,
  recordName: string,
): AppendInput[] {
  const deskItemId = randomUUID();
  return [
    deskQuestion(inst, {
      deskItemId,
      subkind: 'journeyWaitEscalated',
      doing: `The journey for ${recordName} waits at "${w.step_id}".`,
      question:
        reason === 'date_missing'
          ? `The date for "${w.step_id}" (${recordName}) could not be read. What should happen?`
          : `"${w.step_id}" for ${recordName} timed out. What should happen?`,
      options: ESCALATION_OPTIONS,
      addresseeUserId: addressee,
      data: { waitId: w.id, instanceId: inst.id, recordId: inst.record_id, stepId: w.step_id, ...(w.kind ? { waitKind: w.kind } : {}) },
    }),
    ev(inst, {
      type: 'JourneyWaitEscalated',
      payload: { waitId: w.id, ...(firedFor ? { firedFor } : {}), deskItemId, addresseeUserId: addressee, reason },
    }),
  ];
}

// ------------------------------------------------------------------------------------------------ entering

/** Executor for a configured `wait` step. Throws `Refused` for an unpublished form. */
export async function enterWaitStep(
  ctx: Ctx,
  tx: Tx,
  inst: Row,
  def: JourneyDefinition,
  run: Row,
): Promise<AppendInput[]> {
  const step = def.steps.find((s) => s.id === run.step_id) as JourneyWaitStep;
  const waitFor = step.waitFor;
  const now = ctx.clock.now();
  const waitId = randomUUID();
  const record = (await one(tx, 'SELECT * FROM journey_records WHERE id=$1', [inst.record_id])) as Row;
  const config = { waitFor, duration: step.duration, onTimeout: step.onTimeout } as Record<string, unknown>;
  const base = { waitId, instanceId: inst.id, visit: run.visit, stepId: run.step_id, startedAt: iso(now), config };

  if (!waitFor) return manualWait(inst, run, now);

  if (waitFor.kind === 'date') {
    const card = await one(
      tx,
      `SELECT c.* FROM journey_step_runs r JOIN cards c ON c.id = r.card_id
        WHERE r.instance_id=$1 AND r.card_id IS NOT NULL ORDER BY r.visit DESC LIMIT 1`,
      [inst.id],
    );
    const field = waitFor.dateFrom.field;
    const raw = card ? (field in card ? card[field] : (card.fields as Record<string, unknown> | null)?.[field]) : undefined;
    const fireAt = dateWaitFireAt(raw, waitFor.offset, waitFor.atTime, 'UTC');
    if (!fireAt) {
      const addressee = await defaultAddressee(tx, inst);
      return [
        ev(inst, { type: 'JourneyWaitStarted', payload: { ...base, kind: 'date' } }),
        ...escalationEvents(ctx, inst, { id: waitId, step_id: run.step_id }, addressee, 'date_missing', undefined, record.display_name),
      ];
    }
    return [
      ev(inst, {
        type: 'JourneyWaitStarted',
        payload: { ...base, kind: 'date', deadlineAt: iso(fireAt), nextFireAt: iso(fireAt) },
      }),
    ];
  }

  if (!step.duration) return manualWait(inst, run, now);
  const deadline = deadlineOf(now, step.duration);
  const timing = { deadlineAt: iso(deadline), nextFireAt: iso(deadline) };

  if (waitFor.kind === 'duration') return [ev(inst, { type: 'JourneyWaitStarted', payload: { ...base, kind: 'duration', ...timing } })];

  if (waitFor.kind === 'webhook')
    return [
      ev(inst, {
        type: 'JourneyWaitStarted',
        payload: { ...base, kind: 'webhook', ...timing, ...(waitFor.triggerId ? { triggerId: waitFor.triggerId } : {}) },
      }),
    ];

  // form
  if (!waitFor.formId) throw new Refused('invalid_mapping', 'The wait has no form.');
  const reference = ((record.external_id as string | null) ?? (record.display_name as string)).slice(0, 120);
  const expiresAt = new Date(Math.min(lastDeadline(now, step).getTime() + DAY, now.getTime() + 90 * DAY));
  let link: { linkId: string; expiresAt: Date };
  try {
    link = await createClientLinkIn(tx, ctx, {
      orgId: inst.org_id,
      formId: waitFor.formId,
      by: inst.started_by,
      reference,
      recordKind: record.record_type,
      recordId: record.id,
      expiresAt,
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'form_not_published')
      throw new Refused('not_published', 'Publish the form of this wait.');
    throw err;
  }
  const out: AppendInput[] = [
    ev(inst, {
      type: 'JourneyWaitStarted',
      payload: { ...base, kind: 'form', ...timing, linkId: link.linkId, linkExpiresAt: iso(link.expiresAt) },
    }),
  ];
  out.push(...(await linkDelivery(tx, inst, waitId, link.linkId, link.expiresAt, waitFor.send.via, record.display_name, run.step_id)));
  return out;
}

async function linkDelivery(
  tx: Tx,
  inst: Row,
  waitId: string,
  linkId: string,
  expiresAt: Date,
  via: 'desk' | 'webhook',
  recordName: string,
  stepId: string,
): Promise<AppendInput[]> {
  if (via === 'webhook')
    return [ev(inst, { type: 'JourneyWaitLinkSent', payload: { waitId, linkId, via, expiresAt: iso(expiresAt) } })];
  const deskItemId = randomUUID();
  const addressee = await defaultAddressee(tx, inst);
  return [
    deskQuestion(inst, {
      deskItemId,
      subkind: 'journeyWaitLink',
      doing: `The journey for ${recordName} waits for a form at "${stepId}".`,
      question: `Send the personal form link to ${recordName}.`,
      options: [{ id: 'sent', label: 'I sent it', description: 'Mark this task as done.' }],
      addresseeUserId: addressee,
      data: { waitId, instanceId: inst.id, recordId: inst.record_id, linkId },
    }),
    ev(inst, { type: 'JourneyWaitLinkSent', payload: { waitId, linkId, via, expiresAt: iso(expiresAt), deskItemId } }),
  ];
}

function manualWait(inst: Row, run: Row, now: Date): AppendInput[] {
  return [
    ev(inst, {
      type: 'JourneyWaitStarted',
      payload: {
        waitId: randomUUID(),
        instanceId: inst.id,
        visit: run.visit,
        stepId: run.step_id,
        kind: 'manual',
        startedAt: iso(now),
        config: {},
      },
    }),
  ];
}
export { manualWait };

// ------------------------------------------------------------------------------------------------ resolving

/** Ends a wait with `reason` and moves the journey along `done`. Instance and wait locked by the caller. */
async function resolveAndAdvance(
  ctx: Ctx,
  tx: Tx,
  inst: Row,
  w: Row,
  reason: 'elapsed' | 'date_reached' | 'form_submitted' | 'webhook_received' | 'continued',
  extra: { by?: string; submissionId?: string; firedFor?: string } = {},
  preEvents: AppendInput[] = [],
): Promise<void> {
  const def = await loadDefinition(tx, inst.journey_id, inst.journey_version);
  const run = await one(tx, 'SELECT * FROM journey_step_runs WHERE instance_id=$1 AND visit=$2', [inst.id, w.visit]);
  if (!run || run.status !== 'waiting') return;
  await ctx.store.append(
    [
      ...preEvents,
      ev(inst, {
        type: 'JourneyWaitResolved',
        payload: {
          waitId: w.id,
          reason,
          ...(extra.by ? { by: extra.by } : {}),
          ...(extra.submissionId ? { submissionId: extra.submissionId } : {}),
          ...(extra.firedFor ? { firedFor: extra.firedFor } : {}),
        },
      }),
    ],
    { tx },
  );
  await endWaitSideEffects(ctx, tx, inst, w.id);
  await advanceIn(ctx, tx, inst, def, run, 'done', null);
}

/** Wait-for-form: a submission was stored through the wait's link. True when something moved. */
export async function resolveFormWait(ctx: Ctx, waitId: string): Promise<boolean> {
  return withAppendTx(ctx.pool, async (tx) => {
    const w = await one(tx, `SELECT * FROM journey_waits WHERE id=$1 AND status IN ('open','escalated') FOR UPDATE`, [waitId]);
    if (!w || !w.link_id) return false;
    const link = await one(tx, 'SELECT used_by_submission FROM form_client_links WHERE id=$1', [w.link_id]);
    if (!link?.used_by_submission) return false;
    const inst = await lockInstance(tx, w.instance_id, w.visit, 'waiting');
    if (!inst) return false;
    const submissionId = String(link.used_by_submission);
    await resolveAndAdvance(ctx, tx, inst, w, 'form_submitted', { submissionId }, [
      ev(inst, {
        type: 'JourneyRecordReferenceAdded',
        payload: { recordId: inst.record_id, kind: 'form_submission', ref: submissionId, label: 'Form submission' },
      }),
    ]);
    return true;
  });
}

/** A person ends a wait (desk answer or the Continue button). */
export async function continueWait(ctx: Ctx, waitId: string, byUserId: string): Promise<boolean> {
  return withAppendTx(ctx.pool, async (tx) => {
    const w = await one(tx, `SELECT * FROM journey_waits WHERE id=$1 AND status IN ('open','escalated') FOR UPDATE`, [waitId]);
    if (!w) return false;
    if (w.kind === 'gate') throw conflict('gate_needs_decision', 'This step is an approval gate: approve or reject it.');
    const inst = await lockInstance(tx, w.instance_id, w.visit, 'waiting');
    if (!inst) return false;
    await resolveAndAdvance(ctx, tx, inst, w, 'continued', { by: byUserId });
    return true;
  });
}

export async function extendWait(ctx: Ctx, waitId: string, byUserId: string, ms: number): Promise<boolean> {
  return withAppendTx(ctx.pool, async (tx) => {
    const w = await one(tx, `SELECT * FROM journey_waits WHERE id=$1 AND status IN ('open','escalated') FOR UPDATE`, [waitId]);
    if (!w || w.kind === 'manual') return false;
    const inst = await lockInstance(tx, w.instance_id, w.visit, 'waiting');
    if (!inst) return false;
    const deadlineAt = new Date(ctx.clock.now().getTime() + ms);
    const out: AppendInput[] = [
      ev(inst, { type: 'JourneyWaitExtended', payload: { waitId, by: byUserId, deadlineAt: iso(deadlineAt) } }),
    ];
    if (w.desk_item_id && w.status === 'escalated') {
      const d = await one(tx, 'SELECT status FROM desk_items WHERE id=$1', [w.desk_item_id]);
      if (d?.status === 'open') out.push(resolveDeskEvent(inst, w.desk_item_id, 'acknowledged', 'Extended.', byUserId));
    }
    await ctx.store.append(out, { tx });
    return true;
  });
}

/** Ends the wait and enters another step (a timeout answer, or the `goto` action). */
export async function gotoIn(
  ctx: Ctx,
  tx: Tx,
  inst: Row,
  w: Row,
  stepId: string,
  extra: { by?: string; firedFor?: string } = {},
  pre: AppendInput[] = [],
): Promise<void> {
  const def = await loadDefinition(tx, inst.journey_id, inst.journey_version);
  const run = await one(tx, 'SELECT * FROM journey_step_runs WHERE instance_id=$1 AND visit=$2', [inst.id, w.visit]);
  if (!run || run.status !== 'waiting' || !def.steps.some((s) => s.id === stepId)) return;
  await ctx.store.append(
    [
      ...pre,
      ev(inst, {
        type: 'JourneyWaitResolved',
        payload: { waitId: w.id, reason: 'goto', ...(extra.by ? { by: extra.by } : {}), ...(extra.firedFor ? { firedFor: extra.firedFor } : {}) },
      }),
      ev(inst, { type: 'JourneyStepCompleted', payload: { instanceId: inst.id, visit: run.visit, result: 'skipped' } }),
      ev(inst, {
        type: 'JourneyStepEntered',
        payload: { instanceId: inst.id, visit: run.visit + 1, stepId, kind: kindOf(def, stepId), fromVisit: run.visit },
      }),
    ],
    { tx },
  );
  await endWaitSideEffects(ctx, tx, inst, w.id);
}

export async function gotoFromWait(ctx: Ctx, waitId: string, byUserId: string, stepId: string): Promise<boolean> {
  return withAppendTx(ctx.pool, async (tx) => {
    const w = await one(tx, `SELECT * FROM journey_waits WHERE id=$1 AND status IN ('open','escalated') FOR UPDATE`, [waitId]);
    if (!w || w.kind === 'gate') return false;
    const inst = await lockInstance(tx, w.instance_id, w.visit, 'waiting');
    if (!inst) return false;
    await gotoIn(ctx, tx, inst, w, stepId, { by: byUserId });
    return true;
  });
}

export async function cancelFromWait(ctx: Ctx, waitId: string, byUserId: string): Promise<boolean> {
  return withAppendTx(ctx.pool, async (tx) => {
    const w = await one(tx, `SELECT * FROM journey_waits WHERE id=$1 AND status IN ('open','escalated') FOR UPDATE`, [waitId]);
    if (!w) return false;
    const inst = await one(tx, 'SELECT * FROM journey_instances WHERE id=$1 FOR UPDATE', [w.instance_id]);
    if (!inst) return false;
    return cancelInstanceIn(tx, ctx, inst, byUserId, 'escalation');
  });
}

/** Issues a new link (the old one is revoked) and shows or passes it on again. */
export async function resendLink(ctx: Ctx, waitId: string): Promise<boolean> {
  return withAppendTx(ctx.pool, async (tx) => {
    const w = await one(tx, `SELECT * FROM journey_waits WHERE id=$1 AND status IN ('open','escalated') FOR UPDATE`, [waitId]);
    if (!w || w.kind !== 'form') return false;
    const inst = await lockInstance(tx, w.instance_id, w.visit, 'waiting');
    if (!inst) return false;
    await ctx.store.append(await refreshLink(ctx, tx, inst, w, true), { tx });
    return true;
  });
}

/** Keeps the link while it is unused and unexpired, else makes a new one and revokes the old. Then shows or passes it on. */
async function refreshLink(ctx: Ctx, tx: Tx, inst: Row, w: Row, force = false): Promise<AppendInput[]> {
  const cfg = w.config as { waitFor: { formId: string; send: { via: 'desk' | 'webhook' } } };
  const record = (await one(tx, 'SELECT * FROM journey_records WHERE id=$1', [inst.record_id])) as Row;
  const cur = w.link_id ? await one(tx, 'SELECT * FROM form_client_links WHERE id=$1', [w.link_id]) : null;
  const now = ctx.clock.now();
  const usable = cur && !cur.revoked_at && !cur.used_at && new Date(cur.expires_at).getTime() > now.getTime() + DAY / 2;
  let linkId = w.link_id as string;
  let expiresAt = new Date(w.link_expires_at ?? cur?.expires_at ?? now);
  if (force || !usable) {
    if (cur) await revokeClientLinkIn(tx, ctx, { orgId: inst.org_id, formId: cfg.waitFor.formId, linkId: cur.id, by: inst.started_by });
    expiresAt = new Date(now.getTime() + Math.min(90, 14) * DAY);
    const l = await createClientLinkIn(tx, ctx, {
      orgId: inst.org_id,
      formId: cfg.waitFor.formId,
      by: inst.started_by,
      reference: ((record.external_id as string | null) ?? (record.display_name as string)).slice(0, 120),
      recordKind: record.record_type,
      recordId: record.id,
      expiresAt,
    });
    linkId = l.linkId;
  }
  return linkDelivery(tx, inst, w.id, linkId, expiresAt, cfg.waitFor.send.via, record.display_name, w.step_id);
}

// ------------------------------------------------------------------------------------------------ timers

function viewOf(w: Row): WaitView {
  const cfg = w.config as { onTimeout?: TimeoutAction; deadline?: { onTimeout: TimeoutAction } };
  return {
    kind: w.kind,
    status: w.status,
    startedAt: new Date(w.started_at),
    deadlineAt: w.deadline_at ? new Date(w.deadline_at) : null,
    nextFireAt: w.next_fire_at ? new Date(w.next_fire_at) : null,
    remindersSent: w.reminders_sent,
    onTimeout: w.kind === 'gate' ? cfg.deadline?.onTimeout : cfg.onTimeout,
  };
}

/** Fires every due wait once: reads the due ids, then handles each in its own transaction. Returns how many fired. */
export async function fireDueWaits(ctx: Ctx, projectId: string | null = null): Promise<number> {
  const due = await rows(
    ctx.pool,
    `SELECT w.id FROM journey_waits w JOIN journey_instances i ON i.id = w.instance_id
      WHERE w.status='open' AND w.next_fire_at <= $1 AND i.status='waiting' AND i.current_visit = w.visit
        AND ($2::uuid IS NULL OR w.project_id = $2)
      ORDER BY w.next_fire_at, w.id LIMIT 50`,
    [ctx.clock.now(), projectId],
  );
  let n = 0;
  for (const d of due) {
    try {
      if (await fireOne(ctx, d.id)) n++;
    } catch (err) {
      ctx.log.error({ err, waitId: d.id }, 'journey wait failed');
    }
  }
  return n;
}

async function fireOne(ctx: Ctx, waitId: string): Promise<boolean> {
  return withAppendTx(ctx.pool, async (tx) => {
    const now = ctx.clock.now();
    const w = await one(
      tx,
      `SELECT * FROM journey_waits WHERE id=$1 AND status='open' AND next_fire_at <= $2 FOR UPDATE SKIP LOCKED`,
      [waitId, now],
    );
    if (!w) return false;
    const inst = await lockInstance(tx, w.instance_id, w.visit, 'waiting');
    if (!inst) return false;
    const firedFor = iso(new Date(w.next_fire_at));
    const d = timeoutDecision(viewOf(w), now);
    switch (d.kind) {
      case 'elapsed':
        await resolveAndAdvance(ctx, tx, inst, w, w.kind === 'date' ? 'date_reached' : 'elapsed', { firedFor });
        return true;
      case 'remind': {
        const out: AppendInput[] = [ev(inst, { type: 'JourneyWaitTimedOut', payload: { waitId, firedFor, action: 'remind', n: d.n } })];
        let linkId: string | undefined;
        if (w.kind === 'form') {
          const l = await refreshLink(ctx, tx, inst, w);
          out.push(...l);
          const sent = l.find((e) => e.event.type === 'JourneyWaitLinkSent');
          linkId = sent ? (sent.event as { payload: { linkId: string } }).payload.linkId : undefined;
        }
        let deskItemId: string | undefined;
        if (w.kind === 'gate') {
          // A reminder must be seen: the approver gets a fresh question on the desk and the old one is dismissed.
          const approver = (w.config as { approver?: Parameters<typeof resolveJourneyApprover>[2] }).approver;
          if (approver) {
            const r = await resolveJourneyApprover(tx, inst, approver);
            const record = (await one(tx, 'SELECT display_name FROM journey_records WHERE id=$1', [inst.record_id])) as Row;
            const cfg = w.config as { question?: string };
            deskItemId = randomUUID();
            if (w.desk_item_id) out.push(resolveDeskEvent(inst, w.desk_item_id, 'dismissed', `Reminder ${d.n} of ${d.of} sent.`));
            out.push(
              deskQuestion(inst, {
                deskItemId,
                subkind: 'journeyGate',
                doing: `Reminder ${d.n} of ${d.of}: the journey for ${record.display_name} still waits at "${w.step_id}".`,
                question: cfg.question ?? `Approve "${w.step_id}" for ${record.display_name}?`,
                options: GATE_REMINDER_OPTIONS,
                addresseeUserId: r.userIds[0] as string,
                data: { waitId, instanceId: inst.id, recordId: inst.record_id, stepId: w.step_id, ...(r.role ? { role: r.role } : {}) },
              }),
            );
          }
        }
        out.push(
          ev(inst, {
            type: 'JourneyWaitReminded',
            payload: {
              waitId,
              firedFor,
              n: d.n,
              of: d.of,
              nextFireAt: iso(d.nextFireAt),
              ...(linkId ? { linkId } : {}),
              ...(deskItemId ? { deskItemId } : {}),
            },
          }),
        );
        await ctx.store.append(out, { tx });
        return true;
      }
      case 'goto':
        await gotoIn(ctx, tx, inst, w, d.stepId, { firedFor }, [
          ev(inst, { type: 'JourneyWaitTimedOut', payload: { waitId, firedFor, action: 'goto' } }),
        ]);
        return true;
      case 'cancel':
        await ctx.store.append([ev(inst, { type: 'JourneyWaitTimedOut', payload: { waitId, firedFor, action: 'cancel' } })], { tx });
        await cancelInstanceIn(tx, ctx, inst, null, w.kind === 'gate' ? 'gate_timeout' : 'wait_timeout');
        return true;
      case 'escalate': {
        const record = (await one(tx, 'SELECT display_name FROM journey_records WHERE id=$1', [inst.record_id])) as Row;
        const addressee = await defaultAddressee(tx, inst, d.to);
        await ctx.store.append(
          [
            ev(inst, { type: 'JourneyWaitTimedOut', payload: { waitId, firedFor, action: 'escalate' } }),
            ...escalationEvents(ctx, inst, w as never, addressee, 'timeout', firedFor, record.display_name),
          ],
          { tx },
        );
        return true;
      }
    }
  });
}

export { resolveAndAdvance };
