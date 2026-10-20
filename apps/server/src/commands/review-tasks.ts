import {
  REPORTER,
  REPORTER_OUTCOME,
  type ReporterTask,
  type RunnerToServerOf,
  ScheduledBriefDataSchema,
  streamId,
} from '@aom/shared';
import { ceoReviewItemOfTask } from '../ceo/decisions.ts';
import {
  isFinalReviewTask,
  reviewAnalysisEvents,
  reviewConclusionEvents,
  reviewFacts,
} from '../ceo/review.ts';
import { releaseHeldEvents } from '../ceo/signals.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { orgScope, projectScope, SYSTEM_ACTOR } from './common.ts';
import type { ReportResult, WsRef } from './shifts.ts';

/**
 * The BA reporter is retired (docs/design/ceo-front-door.md step 3): triage, urgent notes, signal analysis, the floor
 * report and schedules' `scheduled_brief` are CEO work now. The one BA task of the old reporter kinds that remains is the
 * CEO-BA review of a corrected decision (`ceo/review.ts`): it travels as a `scheduled_brief` task, the BA analyses read-only
 * and the analysis goes to the CEO's decision item. Everything else of a retired kind is closed without work.
 */

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

/** Is this BA task one that still runs: the CEO's review analysis (and its final turn). */
export const isReviewTask = (task: Row): boolean => task.kind === 'scheduled_brief';

/** What the BA is given for a review task: the CEO's instructions and the facts of the decision. */
export async function buildReviewTask(_ctx: Ctx, db: Queryable, task: Row): Promise<ReporterTask> {
  const base: ReporterTask = {
    items: [],
    signals: [],
    openItems: [],
    triageWindowMinutes: REPORTER.triageWindowMinutes,
  };
  if (task.kind !== 'scheduled_brief') return base;
  const p = task.project_id
    ? await one(db, 'SELECT key FROM projects WHERE id=$1', [task.project_id])
    : undefined;
  // The CEO-BA review adds the facts of the decision (and, in the final turn, the CEO's reply) at shift start.
  const reviewItem = await ceoReviewItemOfTask(db, task);
  const facts = reviewItem ? await reviewFacts(db, task, reviewItem) : '';
  base.brief = {
    scheduleName: task.schedule_name ?? 'Review',
    instructions: [task.instructions ?? '', facts].filter(Boolean).join('\n\n'),
    deliver: task.deliver === 'chat' ? 'chat' : 'desk_notice',
    projectKey: p?.key ?? null,
  };
  return base;
}

/** Terminal report of a review task (`aom report brief`). */
export async function applyReviewReport(
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
    return { accepted: false, error: 'there are no questions in a background task: put it into your report' };
  if (task.kind !== 'scheduled_brief')
    return {
      accepted: false,
      error: 'this reporter task was retired: the CEO does this work now. Finish without reporting.',
    };
  if (report.outcomeId !== REPORTER_OUTCOME.brief)
    return {
      accepted: false,
      error: `outcome '${report.outcomeId}' is not available (allowed: ${REPORTER_OUTCOME.brief})`,
    };
  const data = ScheduledBriefDataSchema.safeParse(report.data);
  if (!data.success) return { accepted: false, error: `invalid report data: ${data.error.message}` };
  const review = await ceoReviewItemOfTask(tx, task);
  if (!review) {
    // A schedule's old BA task that was running when the reporter was retired: nobody reads a BA report any more.
    await ctx.store.append([taskCompleted(task, 'cancelled', 'the BA reporter was retired')], { tx });
    return { accepted: true };
  }
  await ctx.store.append(
    [
      ...(isFinalReviewTask(task)
        ? await reviewConclusionEvents(ctx, tx, review, {
            report: data.data.report,
            baAgentId: shift.agent_id,
          })
        : await reviewAnalysisEvents(tx, review, {
            analysis: data.data.report,
            baAgentId: shift.agent_id,
          })),
      taskCompleted(task, 'done'),
    ],
    { tx },
  );
  return { accepted: true };
}

/**
 * No agent ever blocks: a review task no BA takes in time is done by the server (the review continues without the BA's
 * analysis). A task of a retired kind is closed; held items it still named reach the owner unchanged. Appends in `tx`.
 */
export async function runReviewFallback(ctx: Ctx, tx: Tx, task: Row): Promise<void> {
  const events: AppendInput[] = [];
  if (task.kind === 'scheduled_brief') {
    const review = await ceoReviewItemOfTask(tx, task);
    if (review && isFinalReviewTask(task)) {
      events.push(...(await reviewConclusionEvents(ctx, tx, review, { fallback: true })));
    } else if (review) {
      const analysis = "No BA was available, so the review rests on the owner's correction alone.";
      events.push(...(await reviewAnalysisEvents(tx, review, { analysis, fallback: true })));
    }
    events.push(
      taskCompleted(task, review ? 'fallback' : 'cancelled', review ? 'no BA available' : 'retired'),
    );
  } else {
    if (task.kind === 'desk_triage')
      events.push(...(await releaseHeldEvents(tx, task.desk_item_ids, 'the BA reporter was retired')));
    events.push(taskCompleted(task, 'cancelled', 'the BA reporter was retired'));
  }
  await ctx.store.append(events, { tx });
}
