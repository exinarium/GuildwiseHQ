import {
  allowedDelegates,
  type DeskActor,
  FollowupBriefParamsSchema,
  FollowupDoneDataSchema,
  FollowupFailedDataSchema,
  type FollowupKind,
  isReporterTaskKind,
  PHASE_DESK_SUBKIND,
  PHASE_OUTCOME,
  type PhaseOutstanding,
  PhaseReportDataSchema,
  PhaseResultsDataSchema,
  type RunnerToServerOf,
  renderFollowupBriefFallback,
  renderPhaseReportFallback,
  renderResultsReportFallback,
  streamId,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { agentActor, orgScope, runnerActor, SYSTEM_ACTOR } from './common.ts';
import { effectiveCompletionAction } from './completion.ts';
import { intakeRpc } from './intake.ts';
import { applyBatchReport, batchRpcGuard } from './intake-batch.ts';
import { applyMailDraftReport, runMailDraftFallback } from './mail-draft.ts';
import {
  actorOf,
  agentBy,
  baTaskCompleted,
  computeOutstanding,
  createItemEvent,
  followupRows,
  labelsFor,
  phaseMessage,
  phaseReportEvents,
  phaseScope,
  systemBy,
} from './phase-events.ts';
import { followupFinishedEvent, outcomesOf, toTargetBrief } from './phase-followups.ts';
import { workingBranchOf } from './phases.ts';
import { applyReviewReport, runReviewFallback } from './review-tasks.ts';
import type { ReportResult, WsRef } from './shifts.ts';
import { applySpecCardReport, runSpecCardFallback } from './spec-card.ts';

// ------------------------------------------------------------------------------- results report

/** `PhaseResultsReported` and its desk notice (pinned when a follow-up failed), for the BA's report or the fallback. */
export async function resultsReportEvents(
  db: Queryable,
  phase: Row,
  input: { report: string; by: DeskActor },
): Promise<AppendInput[]> {
  const list = await followupRows(db, phase.id);
  const labels = await labelsFor(db, list);
  const ok = list.filter((f) => f.status === 'succeeded').length;
  const failed = list.filter((f) => f.status === 'failed').length;
  const skipped = list.filter((f) => f.status === 'skipped').length;
  const table = list.map((f, i) => {
    const links: string[] = [];
    for (const r of (f.evidence?.requests as Array<{ workstation: string; status: string }> | undefined) ??
      [])
      links.push(`DevOps on ${r.workstation}: ${r.status}`);
    for (const ref of (f.evidence?.cardRefs as string[] | undefined) ?? []) links.push(`card ${ref}`);
    for (const ref of (f.evidence?.bugRefs as string[] | undefined) ?? []) links.push(`bug ${ref}`);
    return `${f.position}. ${labels[i]}: ${f.status}${f.result_summary ? ` - ${String(f.result_summary).split('\n')[0]}` : ''}${links.length ? ` (${links.join(', ')})` : ''}`;
  });
  const item = createItemEvent(phase, {
    kind: 'alert',
    subkind: PHASE_DESK_SUBKIND.results,
    title: `${phase.ref} follow-ups finished: ${ok} succeeded${failed ? `, ${failed} failed` : ''}${skipped ? `, ${skipped} skipped` : ''}`,
    body: `${input.report}\n\n---\n${table.join('\n')}`,
    pinned: failed > 0,
    askedBy: input.by,
  });
  return [
    item.event,
    {
      streamId: streamId.phase(phase.id),
      event: {
        type: 'PhaseResultsReported',
        payload: {
          phaseId: phase.id,
          deskItemId: item.deskItemId,
          report: input.report,
          finalStatus: failed > 0 ? 'done_with_failures' : 'done',
          by: input.by,
        },
      },
      actor: actorOf(input.by),
      scope: phaseScope(phase),
    },
  ];
}

// ------------------------------------------------------------------------------------- reports

const projectOf = (db: Queryable, phase: Row) =>
  one(db, 'SELECT * FROM projects WHERE id=$1', [phase.project_id]) as Promise<Row>;

/**
 * Terminal and non-terminal reports of a `ba_task` shift (`aom phase report|ready|followup|results`, `aom comment`).
 * The same shape as `applyDevopsReport`. A BA never asks questions here: what the manager must decide goes into the
 * report.
 */
export async function applyBaTaskReport(
  ctx: Ctx,
  tx: Tx,
  _ws: WsRef,
  msg: RunnerToServerOf<'shift.report'>,
  shift: Row,
): Promise<ReportResult> {
  const task = await one(tx, 'SELECT * FROM ba_tasks WHERE shift_id=$1 FOR UPDATE', [shift.id]);
  const report = msg.report;
  if (!task || task.status !== 'running')
    return {
      accepted: false,
      error: 'this task is no longer open; there is nothing left to do. Finish now.',
    };
  if (task.kind === 'batch_intake') return applyBatchReport(ctx, tx, shift, task, msg.report);
  if (task.kind === 'mail_reply_draft') return applyMailDraftReport(ctx, tx, task, msg);
  if (task.kind === 'spec_card') return applySpecCardReport(ctx, tx, task, shift, msg);
  if (isReporterTaskKind(task.kind)) return applyReviewReport(ctx, tx, _ws, msg, shift, task);
  const phase = await one(tx, 'SELECT * FROM phases WHERE id=$1 FOR UPDATE', [task.phase_id]);
  if (!phase) return { accepted: false, error: 'the phase is gone. Finish now.' };
  const by = agentBy(shift.agent_id);

  if (report.kind === 'comment') {
    await ctx.store.append([phaseMessage(phase, { kind: 'agent', agentId: shift.agent_id }, report.note)], {
      tx,
    });
    return { accepted: true };
  }
  if (report.kind !== 'outcome')
    return {
      accepted: false,
      error:
        'there are no questions in a background task: put what the manager must decide into your report instead',
    };

  const cancelled = async (why: string): Promise<ReportResult> => {
    await ctx.store.append([baTaskCompleted(phase, task.id, 'cancelled', why)], { tx });
    return { accepted: false, error: `${why}. Finish now.` };
  };

  if (task.kind === 'phase_report') {
    if (report.outcomeId !== PHASE_OUTCOME.report)
      return {
        accepted: false,
        error: `outcome '${report.outcomeId}' is not available (allowed: ${PHASE_OUTCOME.report})`,
      };
    if (phase.status !== 'reporting')
      return cancelled(`${phase.ref} is ${phase.status}: it no longer waits for this report`);
    const data = PhaseReportDataSchema.safeParse(report.data);
    if (!data.success) return { accepted: false, error: `invalid report data: ${data.error.message}` };
    const outcomes = phase.card_outcomes ?? [];
    const outstanding: PhaseOutstanding[] = [
      ...(await computeOutstanding(tx, outcomes)),
      ...data.data.outstanding.map((text) => ({ kind: 'other' as const, text })),
    ].filter((o, i, all) => all.findIndex((x) => x.text.trim() === o.text.trim()) === i);
    await ctx.store.append(
      [
        ...(await phaseReportEvents(tx, phase, { report: data.data.report, outstanding, by })),
        baTaskCompleted(phase, task.id, 'done'),
      ],
      { tx },
    );
    return { accepted: true };
  }

  if (task.kind === 'followups_brief') {
    if (report.outcomeId !== PHASE_OUTCOME.ready)
      return {
        accepted: false,
        error: `outcome '${report.outcomeId}' is not available (allowed: ${PHASE_OUTCOME.ready})`,
      };
    if (phase.status !== 'running_followups')
      return cancelled(`${phase.ref} is ${phase.status}: it no longer needs briefs`);
    const missing = (await followupRows(tx, phase.id))
      .filter((f) => f.status === 'queued')
      .map((f) => f.position);
    if (missing.length)
      return {
        accepted: false,
        error: `follow-up ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not briefed yet: \`aom phase followup brief <n> --to devops|tester|ba --text "..."\` for each, then \`aom phase ready\``,
      };
    await ctx.store.append([baTaskCompleted(phase, task.id, 'done')], { tx });
    return { accepted: true };
  }

  if (task.kind === 'followup_custom') {
    const done = report.outcomeId === PHASE_OUTCOME.followupDone;
    if (!done && report.outcomeId !== PHASE_OUTCOME.followupFailed)
      return {
        accepted: false,
        error: `outcome '${report.outcomeId}' is not available (allowed: ${PHASE_OUTCOME.followupDone}, ${PHASE_OUTCOME.followupFailed})`,
      };
    const f = await one(tx, 'SELECT * FROM phase_followups WHERE id=$1 FOR UPDATE', [task.followup_id]);
    if (!f || f.status !== 'running') return cancelled('this follow-up is not running any more');
    const data = (done ? FollowupDoneDataSchema : FollowupFailedDataSchema).safeParse(report.data);
    if (!data.success) return { accepted: false, error: `invalid data: ${data.error.message}` };
    if (data.data.position !== f.position)
      return { accepted: false, error: `this task is follow-up ${f.position}, not ${data.data.position}` };
    const links: string[] = 'links' in data.data ? (data.data.links as string[]) : [];
    await ctx.store.append(
      [
        followupFinishedEvent(
          phase,
          f.id,
          done ? 'succeeded' : 'failed',
          data.data.summary,
          links.length ? { links } : {},
        ),
        phaseMessage(
          phase,
          { kind: 'agent', agentId: shift.agent_id },
          `Follow-up ${f.position} ${done ? 'done' : 'failed'}: ${data.data.summary}`,
        ),
        baTaskCompleted(phase, task.id, 'done'),
      ],
      { tx },
    );
    return { accepted: true };
  }

  // followups_report
  if (report.outcomeId !== PHASE_OUTCOME.results)
    return {
      accepted: false,
      error: `outcome '${report.outcomeId}' is not available (allowed: ${PHASE_OUTCOME.results})`,
    };
  if (phase.status !== 'reporting_results')
    return cancelled(`${phase.ref} is ${phase.status}: it no longer waits for this report`);
  const data = PhaseResultsDataSchema.safeParse(report.data);
  if (!data.success) return { accepted: false, error: `invalid report data: ${data.error.message}` };
  await ctx.store.append(
    [
      ...(await resultsReportEvents(tx, phase, { report: data.data.report, by })),
      baTaskCompleted(phase, task.id, 'done'),
    ],
    { tx },
  );
  return { accepted: true };
}

/** The intake verbs a batch intake shift may use (the BA's chat verbs, minus the conversation). */
const BATCH_RPC = new Set([
  'card.create',
  'card.update',
  'card.specify',
  'intake.map',
  'intake.unmapped',
  'phase.list',
  'phase.propose',
  'phase.assign',
  'phase.submit',
]);

/** `phase.followup.brief` (non-terminal) in a `followups_brief` shift: delegate one follow-up. */
export async function baTaskRpc(
  ctx: Ctx,
  shift: Row,
  method: string,
  params: Record<string, unknown>,
): Promise<[boolean, unknown?, string?]> {
  if (BATCH_RPC.has(method)) {
    const batch = await one(ctx.pool, `SELECT 1 FROM ba_tasks WHERE shift_id=$1 AND kind='batch_intake'`, [
      shift.id,
    ]);
    if (batch) {
      const refusal = await batchRpcGuard(ctx, shift, method, params);
      return refusal ? [false, undefined, refusal] : intakeRpc(ctx, shift, method, params);
    }
  }
  if (method === 'card.get' || method === 'thread.read') return readRpc(ctx, shift, method, params);
  if (method !== 'phase.followup.brief') return [false, undefined, `${method} is not available in this task`];
  const p = FollowupBriefParamsSchema.safeParse(params);
  if (!p.success)
    return [
      false,
      undefined,
      'usage: aom phase followup brief <n> --to devops|tester|ba --text "<instructions>"',
    ];
  return briefFollowup(ctx, shift, p.data);
}

/** Read-only views for a BA task: a member card of the phase by ref (`aom card <REF>`), and the phase thread. */
async function readRpc(
  ctx: Ctx,
  shift: Row,
  method: string,
  params: Record<string, unknown>,
): Promise<[boolean, unknown?, string?]> {
  const task = await one(ctx.pool, 'SELECT * FROM ba_tasks WHERE shift_id=$1', [shift.id]);
  if (!task?.phase_id) return [false, undefined, 'this shift has no task'];
  if (method === 'thread.read') {
    const messages = await rows(
      ctx.pool,
      `SELECT m.kind, m.body, m.created_at, m.author_kind, a.name AS agent_name FROM thread_messages m
         LEFT JOIN agents a ON a.id = m.author_agent_id WHERE m.thread_id=$1 ORDER BY m.created_at DESC, m.event_seq DESC LIMIT 30`,
      [task.phase_id],
    );
    return [
      true,
      {
        messages: messages.reverse().map((m) => ({
          authorName: m.agent_name ?? 'system',
          kind: m.kind,
          body: m.body,
          at: m.created_at,
        })),
      },
    ];
  }
  const ref = typeof params.ref === 'string' ? params.ref.toUpperCase() : '';
  if (!ref) return [false, undefined, 'usage: aom card <REF> (a card of this phase)'];
  const card = await one(ctx.pool, 'SELECT * FROM cards WHERE phase_id=$1 AND ref=$2', [task.phase_id, ref]);
  if (!card) return [false, undefined, `${ref} is not a card of this phase`];
  const handoffs = await rows(
    ctx.pool,
    'SELECT stage, outcome, note, created_at FROM card_handoffs WHERE card_id=$1 ORDER BY created_at, event_seq',
    [card.id],
  );
  return [
    true,
    {
      ref: card.ref,
      title: card.title,
      status: card.status,
      stage: card.stage,
      completionAction: await effectiveCompletionAction(ctx.pool, card),
      finalizeResult: card.finalize_result,
      fields: card.fields,
      handoffs: handoffs.map((h) => ({ stage: h.stage, outcome: h.outcome, note: h.note })),
    },
  ];
}

async function briefFollowup(
  ctx: Ctx,
  shift: Row,
  p: { position: number; to: 'devops' | 'tester' | 'ba'; text: string },
): Promise<[boolean, unknown?, string?]> {
  return withAppendTx(ctx.pool, async (tx): Promise<[boolean, unknown?, string?]> => {
    const task = await one(
      tx,
      `SELECT * FROM ba_tasks WHERE shift_id=$1 AND kind='followups_brief' AND status='running' FOR UPDATE`,
      [shift.id],
    );
    if (!task) return [false, undefined, 'briefs are written in a follow-ups brief task only'];
    const phase = await one(tx, 'SELECT * FROM phases WHERE id=$1 FOR UPDATE', [task.phase_id]);
    if (!phase || phase.status !== 'running_followups')
      return [false, undefined, 'the phase no longer needs briefs'];
    const f = (await followupRows(tx, phase.id)).find((x) => x.position === p.position);
    if (!f) return [false, undefined, `there is no follow-up ${p.position}`];
    if (!['queued', 'briefed'].includes(f.status))
      return [false, undefined, `follow-up ${p.position} is already ${f.status}`];
    if (!allowedDelegates(f.kind as FollowupKind).includes(p.to))
      return [
        false,
        undefined,
        `a ${f.kind} follow-up goes to ${allowedDelegates(f.kind as FollowupKind).join(' or ')}, not ${p.to}`,
      ];
    await ctx.store.append(
      [
        {
          streamId: streamId.phase(phase.id),
          event: {
            type: 'PhaseFollowupBriefed',
            payload: {
              phaseId: phase.id,
              followupId: f.id,
              delegate: p.to,
              brief: p.text,
              by: agentBy(shift.agent_id),
            },
          },
          actor: agentActor(shift.agent_id),
          scope: phaseScope(phase),
        },
        phaseMessage(
          phase,
          { kind: 'agent', agentId: shift.agent_id },
          `Briefed follow-up ${p.position} for ${p.to}:\n\n${p.text}`,
        ),
      ],
      { tx },
    );
    return [
      true,
      { position: p.position, to: p.to, message: 'Briefed. Brief the others, then `aom phase ready`.' },
    ];
  });
}

// ----------------------------------------------------------------------------------- shift end

type EndOutcome = 'rejected' | 'lost' | 'stopped' | 'no_report' | 'crashed' | 'timeout' | 'reported';

/**
 * `ShiftEnded` for a `ba_task` shift, and the task consequence when no terminal report was applied: a rejected, lost or
 * stopped shift goes back to the queue unharmed; a crash, timeout or missing report counts as a failed attempt. After
 * `BA_TASK_MAX_ATTEMPTS` the server does the task itself (`runBaTaskFallback`).
 */
export async function endBaTaskShift(
  tx: Queryable,
  shift: Row,
  outcome: EndOutcome,
  extra: {
    durationMs?: number;
    usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
    exitCode?: number | null;
    guardViolations?: { rule: string; detail: string }[];
  } = {},
): Promise<AppendInput[]> {
  const events: AppendInput[] = [
    {
      streamId: streamId.shift(shift.id),
      event: {
        type: 'ShiftEnded',
        payload: {
          shiftId: shift.id,
          agentId: shift.agent_id,
          outcome,
          durationMs: extra.durationMs ?? 0,
          usage: extra.usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          exitCode: extra.exitCode,
          guardViolations: extra.guardViolations ?? [],
        },
      },
      actor: runnerActor(shift.workstation_id),
      scope: orgScope(shift.org_id),
    },
  ];
  const task = await one(tx, `SELECT * FROM ba_tasks WHERE shift_id=$1 AND status='running'`, [shift.id]);
  if (task) {
    const failedAttempt = !(outcome === 'rejected' || outcome === 'lost' || outcome === 'stopped');
    events.push({
      streamId: streamId.baTask(task.id),
      event: {
        type: 'BaTaskRequeued',
        payload: {
          taskId: task.id,
          reason: outcome === 'reported' ? 'no_report' : outcome,
          attempt: failedAttempt,
        },
      },
      actor: SYSTEM_ACTOR,
      scope:
        shift.org_id && task.project_id
          ? { orgId: shift.org_id, projectId: task.project_id, audience: 'project' }
          : orgScope(shift.org_id),
    });
  }
  return events;
}

// ------------------------------------------------------------------------------------ fallback

/**
 * No agent ever blocks (owner decision A12): a task no BA takes in time is done by the server from a template and the
 * manager is told so. Appends in `tx`.
 */
export async function runBaTaskFallback(ctx: Ctx, tx: Tx, task: Row): Promise<void> {
  if (task.kind === 'batch_intake') {
    // No BA to work on the ticket: the item fails (the projection) and the owner can retry it.
    await ctx.store.append(
      [
        {
          streamId: streamId.baTask(task.id),
          event: {
            type: 'BaTaskCompleted',
            payload: {
              taskId: task.id,
              status: 'fallback',
              note: 'no BA was available to work on this ticket',
            },
          },
          actor: SYSTEM_ACTOR,
          scope: orgScope(task.org_id),
        },
      ],
      { tx },
    );
    return;
  }
  if (task.kind === 'mail_reply_draft') return runMailDraftFallback(ctx, tx, task);
  if (task.kind === 'spec_card') return runSpecCardFallback(ctx, tx, task);
  if (isReporterTaskKind(task.kind)) return runReviewFallback(ctx, tx, task);
  const phase = await one(tx, 'SELECT * FROM phases WHERE id=$1 FOR UPDATE', [task.phase_id]);
  const done = (note: string) =>
    baTaskCompleted(
      phase ?? { id: task.phase_id, org_id: task.org_id, project_id: task.project_id },
      task.id,
      'fallback',
      note,
    );
  if (!phase) {
    await ctx.store.append(
      [
        baTaskCompleted(
          { org_id: task.org_id, project_id: task.project_id },
          task.id,
          'cancelled',
          'the phase is gone',
        ),
      ],
      { tx },
    );
    return;
  }
  const project = await projectOf(tx, phase);
  const list = await followupRows(tx, phase.id);
  const labels = await labelsFor(tx, list);
  const fb = list.map((f, i) => ({
    position: f.position as number,
    kind: f.kind as FollowupKind,
    label: labels[i] as string,
    status: f.status as string,
    resultSummary: f.result_summary as string | null,
  }));
  const stale = (why: string) =>
    ctx.store.append([baTaskCompleted(phase, task.id, 'cancelled', why)], { tx });

  if (task.kind === 'phase_report') {
    if (phase.status !== 'reporting') return void (await stale(`${phase.ref} is ${phase.status}`));
    const outcomes = phase.card_outcomes ?? [];
    const outstanding = await computeOutstanding(tx, outcomes);
    const report = renderPhaseReportFallback({
      phaseRef: phase.ref,
      phaseName: phase.name,
      cards: outcomes,
      outstanding,
      followups: fb,
    });
    await ctx.store.append(
      [
        ...(await phaseReportEvents(tx, phase, { report, outstanding, by: systemBy })),
        phaseMessage(
          phase,
          { kind: 'system' },
          'No BA took the report task in time: the server posted a template report.',
        ),
        done('template report'),
      ],
      { tx },
    );
    return;
  }

  if (task.kind === 'followups_brief') {
    if (phase.status !== 'running_followups') return void (await stale(`${phase.ref} is ${phase.status}`));
    const outcomes = await outcomesOf(tx, phase);
    const events: AppendInput[] = [];
    for (const f of list.filter((x) => x.status === 'queued')) {
      const target = f.target_id
        ? await one(tx, 'SELECT * FROM deploy_targets WHERE id=$1', [f.target_id])
        : undefined;
      const delegate = f.kind === 'regression' ? 'tester' : 'devops';
      events.push({
        streamId: streamId.phase(phase.id),
        event: {
          type: 'PhaseFollowupBriefed',
          payload: {
            phaseId: phase.id,
            followupId: f.id,
            delegate,
            brief: renderFollowupBriefFallback({
              phaseRef: phase.ref,
              phaseName: phase.name,
              workingBranch: await workingBranchOf(
                tx,
                { project_id: project.id, repo_id: null, base_branch: null },
                phase,
              ),
              kind: f.kind,
              note: f.note,
              instruction: f.instruction,
              platform: f.platform,
              target: target ? toTargetBrief(target) : null,
              cards: outcomes,
            }),
            by: systemBy,
          },
        },
        actor: SYSTEM_ACTOR,
        scope: phaseScope(phase),
      });
    }
    events.push(
      phaseMessage(
        phase,
        { kind: 'system' },
        'No BA took the briefing task in time: the server wrote template briefs.',
      ),
      done('template briefs'),
    );
    await ctx.store.append(events, { tx });
    return;
  }

  if (task.kind === 'followup_custom') {
    const f = list.find((x) => x.id === task.followup_id);
    const events: AppendInput[] = [];
    if (f && f.status === 'running')
      events.push(
        followupFinishedEvent(phase, f.id, 'failed', 'no BA was available to carry out this instruction'),
        phaseMessage(
          phase,
          { kind: 'system' },
          `Follow-up ${f.position} failed: no BA was available to carry out this instruction.`,
        ),
      );
    events.push(done('no BA available'));
    await ctx.store.append(events, { tx });
    return;
  }

  // followups_report
  if (phase.status !== 'reporting_results') return void (await stale(`${phase.ref} is ${phase.status}`));
  const report = renderResultsReportFallback({ phaseRef: phase.ref, phaseName: phase.name, followups: fb });
  await ctx.store.append(
    [
      ...(await resultsReportEvents(tx, phase, { report, by: systemBy })),
      phaseMessage(
        phase,
        { kind: 'system' },
        'No BA took the results task in time: the server posted a template report.',
      ),
      done('template results'),
    ],
    { tx },
  );
}
