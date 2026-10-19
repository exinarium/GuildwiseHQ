import {
  type DeskActor,
  FloorReportDataSchema,
  localParts,
  NotesDataSchema,
  REPORTER,
  REPORTER_OUTCOME,
  type ReporterTask,
  type ReporterTaskKind,
  type RunnerToServerOf,
  renderFloorReportFallback,
  renderSignalFallback,
  ScheduledBriefDataSchema,
  SignalReportsDataSchema,
  streamId,
  TriageDataSchema,
} from '@aom/shared';
import { ceoReviewItemOfTask, reviewAnalysisEvents } from '../ceo/decisions.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { buildFloorDigest, toSignalBrief } from '../reporter/digest.ts';
import {
  agentBy,
  floorReportEvents,
  scheduledBriefEvents,
  signalReportEvents,
  systemBy,
} from '../reporter/report-items.ts';
import { reportingOf } from '../reporter/settings.ts';
import { orgScope, projectScope, SYSTEM_ACTOR } from './common.ts';
import { actorOf } from './phase-events.ts';
import type { ReportResult, WsRef } from './shifts.ts';

const taskScope = (task: Row) =>
  task.project_id ? projectScope(task.org_id, task.project_id) : orgScope(task.org_id);

const taskCompleted = (
  task: Row,
  status: 'done' | 'failed' | 'fallback' | 'cancelled',
  note?: string,
): AppendInput => ({
  streamId: streamId.baTask(task.id),
  event: { type: 'BaTaskCompleted', payload: { taskId: task.id, status, ...(note ? { note } : {}) } },
  actor: SYSTEM_ACTOR,
  scope: taskScope(task),
});

const itemScope = (item: Row) =>
  item.project_id ? projectScope(item.org_id, item.project_id) : orgScope(item.org_id);

/** `DeskItemTriaged released` for every listed item that is still held: the manager sees it unchanged. */
export async function releaseHeldEvents(
  db: Queryable,
  ids: string[],
  note: string,
  by: DeskActor = systemBy,
): Promise<AppendInput[]> {
  if (ids.length === 0) return [];
  const held = await rows(
    db,
    `SELECT * FROM desk_items WHERE id = ANY($1::uuid[]) AND triage='pending' AND status='open'`,
    [ids],
  );
  return held.map((item) => ({
    streamId: streamId.desk(item.id),
    event: { type: 'DeskItemTriaged', payload: { deskItemId: item.id, outcome: 'released', note, by } },
    actor: actorOf(by),
    scope: itemScope(item),
  }));
}

// ------------------------------------------------------------------------------------------- the brief

/** What the BA is given for a reporter task. */
export async function buildReporterTask(ctx: Ctx, db: Queryable, task: Row): Promise<ReporterTask> {
  const kind = task.kind as ReporterTaskKind;
  const base: ReporterTask = {
    items: [],
    signals: [],
    openItems: [],
    triageWindowMinutes: REPORTER.triageWindowMinutes,
  };
  if (kind === 'desk_triage' || kind === 'urgent_note') {
    const items = await rows(
      db,
      `SELECT d.*, p.key AS project_key, c.ref AS card_ref, a.name AS agent_name
         FROM desk_items d LEFT JOIN projects p ON p.id = d.project_id LEFT JOIN cards c ON c.id = d.card_id
         LEFT JOIN agents a ON a.id = d.asked_by_agent_id
        WHERE d.id = ANY($1::uuid[]) ORDER BY d.created_at, d.id`,
      [task.desk_item_ids],
    );
    base.items = items.map((d) => ({
      id: d.id,
      kind: d.kind,
      subkind: d.subkind,
      title: d.title,
      body: d.body,
      projectKey: d.project_key,
      cardRef: d.card_ref,
      blocking: d.blocking,
      askedBy: d.agent_name ? `${d.agent_name} (${d.asked_by_role ?? 'agent'})` : d.asked_by_kind,
      createdAt: new Date(d.created_at).toISOString(),
      held: d.triage === 'pending',
    }));
    if (kind === 'desk_triage') {
      const open = await rows(
        db,
        `SELECT id, title FROM desk_items WHERE org_id=$1 AND status='open' AND NOT (id = ANY($2::uuid[]))
          ORDER BY created_at DESC LIMIT 40`,
        [task.org_id, task.desk_item_ids],
      );
      base.openItems = open.map((o) => ({ id: o.id, title: o.title }));
    }
  }
  if (kind === 'floor_alert') {
    const sig = await rows(db, 'SELECT * FROM ba_signals WHERE id = ANY($1::uuid[]) ORDER BY first_seen_at', [
      task.signal_ids,
    ]);
    base.signals = sig.map(toSignalBrief);
  }
  if (kind === 'scheduled_brief') {
    const p = task.project_id
      ? await one(db, 'SELECT key FROM projects WHERE id=$1', [task.project_id])
      : undefined;
    base.brief = {
      scheduleName: task.schedule_name ?? 'Scheduled task',
      instructions: task.instructions ?? '',
      deliver: task.deliver === 'chat' ? 'chat' : 'desk_notice',
      projectKey: p?.key ?? null,
    };
  }
  if (kind === 'floor_report') {
    const prefs = await reportingOf(db, task.org_id);
    const localDate = task.local_date ?? localParts(ctx.clock.now(), prefs.timezone).date;
    base.digest = await buildFloorDigest(db, task.org_id, ctx.clock.now(), localDate);
  }
  return base;
}

// ------------------------------------------------------------------------------------------ the report

/** Terminal report of a reporter task (`aom report triage|notes|signals|floor`). Same shape as `applyBaTaskReport`. */
export async function applyReporterReport(
  ctx: Ctx,
  tx: Tx,
  _ws: WsRef,
  msg: RunnerToServerOf<'shift.report'>,
  shift: Row,
  task: Row,
): Promise<ReportResult> {
  const report = msg.report;
  if (report.kind === 'comment') return { accepted: true };
  if (report.kind !== 'outcome')
    return {
      accepted: false,
      error: 'there are no questions in a background task: put what the manager must decide into your report',
    };
  const by = agentBy(shift.agent_id);
  const bad = (m: string): ReportResult => ({ accepted: false, error: m });
  const kind = task.kind as ReporterTaskKind;
  const expected = {
    desk_triage: REPORTER_OUTCOME.triage,
    urgent_note: REPORTER_OUTCOME.notes,
    floor_alert: REPORTER_OUTCOME.signals,
    floor_report: REPORTER_OUTCOME.floor,
    scheduled_brief: REPORTER_OUTCOME.brief,
  }[kind];
  if (report.outcomeId !== expected)
    return bad(`outcome '${report.outcomeId}' is not available (allowed: ${expected})`);

  if (kind === 'desk_triage') {
    const data = TriageDataSchema.safeParse(report.data);
    if (!data.success) return bad(`invalid triage data: ${data.error.message}`);
    const mine = new Set<string>(task.desk_item_ids);
    const events: AppendInput[] = [];
    const decided = new Set<string>();
    for (const d of data.data.decisions) {
      if (!mine.has(d.itemId)) return bad(`item ${d.itemId} is not part of this task`);
      const item = await one(tx, 'SELECT * FROM desk_items WHERE id=$1 FOR UPDATE', [d.itemId]);
      if (!item) return bad(`item ${d.itemId} does not exist`);
      decided.add(d.itemId);
      if (item.triage !== 'pending' || item.status !== 'open') {
        // The time ran out and the manager can see it: only context may still be added.
        if (d.note)
          events.push({
            streamId: streamId.desk(item.id),
            event: {
              type: 'DeskItemAnnotated',
              payload: { deskItemId: item.id, note: d.note, by, relatedDeskItemIds: [] },
            },
            actor: actorOf(by),
            scope: itemScope(item),
          });
        continue;
      }
      if (d.action !== 'pass' && (item.kind !== 'alert' || item.blocking || item.pinned))
        return bad(`item ${d.itemId} needs the manager and cannot be dismissed or merged`);
      if (d.action === 'merge') {
        if (!d.into) return bad(`item ${d.itemId}: merge needs "into"`);
        const into = await one(tx, `SELECT id, status, org_id FROM desk_items WHERE id=$1`, [d.into]);
        if (!into || into.org_id !== item.org_id || into.status !== 'open' || into.id === item.id)
          return bad(`item ${d.itemId}: "into" must be another open item of this organization`);
      }
      events.push({
        streamId: streamId.desk(item.id),
        event: {
          type: 'DeskItemTriaged',
          payload: {
            deskItemId: item.id,
            outcome: d.action === 'pass' ? 'passed' : d.action === 'dismiss' ? 'dismissed' : 'merged',
            ...(d.note ? { note: d.note } : {}),
            ...(d.into ? { intoDeskItemId: d.into } : {}),
            by,
          },
        },
        actor: actorOf(by),
        scope: itemScope(item),
      });
    }
    // Anything the BA left out reaches the manager unchanged.
    events.push(
      ...(await releaseHeldEvents(
        tx,
        (task.desk_item_ids as string[]).filter((id) => !decided.has(id)),
        'the BA did not decide this one',
        by,
      )),
      taskCompleted(task, 'done'),
    );
    await ctx.store.append(events, { tx });
    return { accepted: true };
  }

  if (kind === 'urgent_note') {
    const data = NotesDataSchema.safeParse(report.data);
    if (!data.success) return bad(`invalid notes data: ${data.error.message}`);
    const events: AppendInput[] = [];
    for (const n of data.data.notes) {
      const item = await one(tx, 'SELECT * FROM desk_items WHERE id=$1 AND org_id=$2', [
        n.itemId,
        task.org_id,
      ]);
      if (!item) return bad(`item ${n.itemId} does not exist`);
      events.push({
        streamId: streamId.desk(item.id),
        event: {
          type: 'DeskItemAnnotated',
          payload: { deskItemId: item.id, note: n.note, by, relatedDeskItemIds: n.related ?? [] },
        },
        actor: actorOf(by),
        scope: itemScope(item),
      });
    }
    events.push(taskCompleted(task, 'done'));
    await ctx.store.append(events, { tx });
    return { accepted: true };
  }

  if (kind === 'floor_alert') {
    const data = SignalReportsDataSchema.safeParse(report.data);
    if (!data.success) return bad(`invalid signal reports: ${data.error.message}`);
    const events: AppendInput[] = [];
    for (const r of data.data.reports) {
      const sig = await one(tx, 'SELECT * FROM ba_signals WHERE id=$1 AND org_id=$2', [
        r.signalId,
        task.org_id,
      ]);
      if (!sig) return bad(`signal ${r.signalId} does not exist`);
      if (sig.status === 'resolved') continue;
      events.push(
        ...(await signalReportEvents(tx, sig, {
          summary: r.summary,
          by,
          annotateItemId: r.annotateItemId,
          baAgentId: shift.agent_id,
        })),
      );
    }
    events.push(taskCompleted(task, 'done'));
    await ctx.store.append(events, { tx });
    return { accepted: true };
  }

  if (kind === 'scheduled_brief') {
    const data = ScheduledBriefDataSchema.safeParse(report.data);
    if (!data.success) return bad(`invalid report data: ${data.error.message}`);
    // The CEO-BA review of a corrected decision: the analysis goes to the CEO's decision item, not to a desk notice.
    const review = await ceoReviewItemOfTask(tx, task);
    if (review) {
      await ctx.store.append(
        [
          ...(await reviewAnalysisEvents(tx, review, {
            analysis: data.data.report,
            baAgentId: shift.agent_id,
          })),
          taskCompleted(task, 'done'),
        ],
        { tx },
      );
      return { accepted: true };
    }
    await ctx.store.append(
      [
        ...(await scheduledBriefEvents(tx, task, {
          report: data.data.report,
          by,
          baAgentId: shift.agent_id,
        })),
        taskCompleted(task, 'done'),
      ],
      { tx },
    );
    return { accepted: true };
  }

  const data = FloorReportDataSchema.safeParse(report.data);
  if (!data.success) return bad(`invalid report data: ${data.error.message}`);
  const prefs = await reportingOf(tx, task.org_id);
  const digest = await buildFloorDigest(
    tx,
    task.org_id,
    ctx.clock.now(),
    task.local_date ?? localParts(ctx.clock.now(), prefs.timezone).date,
  );
  await ctx.store.append(
    [
      ...(await floorReportEvents(tx, task.org_id, {
        report: data.data.report,
        digest,
        by,
        baAgentId: shift.agent_id,
      })),
      taskCompleted(task, 'done'),
    ],
    { tx },
  );
  return { accepted: true };
}

// ------------------------------------------------------------------------------------------ fallback

/**
 * No agent ever blocks: a reporter task no BA takes in time is done by the server. Held items pass through unchanged,
 * urgent items need no note, signals and the floor report are posted from templates. Appends in `tx`.
 */
export async function runReporterFallback(ctx: Ctx, tx: Tx, task: Row): Promise<void> {
  const kind = task.kind as ReporterTaskKind;
  const events: AppendInput[] = [];
  if (kind === 'desk_triage') {
    events.push(...(await releaseHeldEvents(tx, task.desk_item_ids, 'no BA was available to look at this')));
  } else if (kind === 'floor_alert') {
    const sig = await rows(tx, `SELECT * FROM ba_signals WHERE id = ANY($1::uuid[]) AND status='open'`, [
      task.signal_ids,
    ]);
    for (const s of sig)
      events.push(
        ...(await signalReportEvents(tx, s, {
          summary: renderSignalFallback(toSignalBrief(s)),
          by: systemBy,
        })),
      );
  } else if (kind === 'scheduled_brief') {
    const review = await ceoReviewItemOfTask(tx, task);
    if (review) {
      const analysis = "No BA was available, so the review rests on the owner's correction alone.";
      events.push(...(await reviewAnalysisEvents(tx, review, { analysis, fallback: true })));
    } else
      events.push(
        ...(await scheduledBriefEvents(tx, task, {
          report: `No BA was available, so this task was not carried out.\n\nWhat the schedule asked for:\n\n${task.instructions ?? ''}`,
          by: systemBy,
          fallback: true,
        })),
      );
  } else if (kind === 'floor_report') {
    const prefs = await reportingOf(tx, task.org_id);
    const digest = await buildFloorDigest(
      tx,
      task.org_id,
      ctx.clock.now(),
      task.local_date ?? localParts(ctx.clock.now(), prefs.timezone).date,
    );
    events.push(
      ...(await floorReportEvents(tx, task.org_id, {
        report: `${renderFloorReportFallback(digest)}\nNo BA was available, so the server wrote this report from a template.\n`,
        digest,
        by: systemBy,
      })),
    );
  }
  events.push(taskCompleted(task, 'fallback', 'no BA available'));
  await ctx.store.append(events, { tx });
}
