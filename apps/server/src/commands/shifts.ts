import { randomUUID } from 'node:crypto';
import {
  type ClaimReleaseReason,
  type DiffStats,
  type DigestData,
  getOutcome,
  getStage,
  isSuiteOrigin,
  type LedgerMatch,
  outcomeDataSchema,
  type RunnerToServerOf,
  resolveOutcome,
  type ShiftEndOutcome,
  streamId,
  type TestEvidence,
} from '@aom/shared';
import { loadWorkflowById } from '../catalogue/loader.ts';
import type { Ctx } from '../context.ts';
import { exec, one, type Row } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { baFinalizeEvents } from './ba-finalize.ts';
import { applyBaTaskReport, endBaTaskShift } from './ba-tasks.ts';
import { agentActor, cardMessage, orgScope, projectScope, runnerActor, SYSTEM_ACTOR } from './common.ts';
import { cardConflictAttemptEvents } from './conflict-attempts.ts';
import { applyDevopsReport, endDevopsShift } from './devops.ts';
import { applyQuestionReport, endQuestionShift } from './escalation.ts';
import { buildDigestEvents } from './feeds.ts';
import { workingBranchQuestionEvents } from './hygiene.ts';
import { loopBreakerPlan, rejectionBackoffEvents } from './loop-breaker.ts';
import { raiseQuestion } from './questions.ts';
import { rebaseConflictEvents } from './rebase.ts';
import { buildPublicationEvents } from './research.ts';
import { environmentNotReadyEvents, suiteOutcomeEvents, testFailedEvents } from './testing.ts';

export interface WsRef {
  id: string;
  userId: string;
}

export interface ReportResult {
  accepted: boolean;
  error?: string;
  /** Shown to the agent on acceptance. */
  message?: string;
  /** Ledger entries that matched a question. */
  matches?: LedgerMatch[];
}

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const ZERO_DIFF: DiffStats = { files: 0, added: 0, removed: 0, architecturalPaths: [] };

const lastHandoffId = async (tx: Tx, cardId: string): Promise<string | undefined> =>
  (
    await one<{ id: string }>(
      tx,
      'SELECT id FROM card_handoffs WHERE card_id=$1 ORDER BY created_at DESC, event_seq DESC LIMIT 1',
      [cardId],
    )
  )?.id;

const shiftEnded = (
  s: Row,
  outcome: ShiftEndOutcome,
  extra: {
    reportOutcome?: string;
    durationMs?: number;
    usage?: typeof ZERO_USAGE;
    exitCode?: number | null;
    guardViolations?: { rule: string; detail: string }[];
  } = {},
): AppendInput => ({
  streamId: streamId.shift(s.id),
  event: {
    type: 'ShiftEnded',
    payload: {
      shiftId: s.id,
      agentId: s.agent_id,
      cardId: s.card_id ?? undefined,
      outcome,
      reportOutcome: extra.reportOutcome,
      durationMs: extra.durationMs ?? 0,
      usage: extra.usage ?? ZERO_USAGE,
      exitCode: extra.exitCode,
      guardViolations: extra.guardViolations ?? [],
    },
  },
  actor: runnerActor(s.workstation_id),
  scope: s.card_id ? { orgId: s.org_id, projectId: null, audience: 'org' } : orgScope(s.org_id),
});

/** ShiftEnded scope: project when the shift has a card (needs the card's project). */
async function shiftEndedFor(
  tx: Tx,
  s: Row,
  outcome: ShiftEndOutcome,
  extra: Parameters<typeof shiftEnded>[2] = {},
): Promise<AppendInput> {
  const e = shiftEnded(s, outcome, extra);
  if (s.card_id) {
    const c = await one<{ project_id: string }>(tx, 'SELECT project_id FROM cards WHERE id=$1', [s.card_id]);
    if (c) e.scope = projectScope(s.org_id, c.project_id);
  }
  return e;
}

/**
 * Events that release a card's current claim and close its shift (server-side detection: lease expiry, lost shift,
 * runner rejection, ...). The caller appends them in its own transaction.
 */
export async function releaseClaimEvents(
  tx: Tx,
  card: Row,
  reason: ClaimReleaseReason,
  message: string | null,
  shiftOutcome: ShiftEndOutcome | null,
  extraEvents: AppendInput[] = [],
  rejection?: { reason: string; detail: string; kind?: 'branch'; repoId?: string },
): Promise<AppendInput[]> {
  const events: AppendInput[] = [...extraEvents];
  events.push({
    streamId: streamId.card(card.id),
    event: {
      type: 'ClaimReleased',
      payload: {
        cardId: card.id,
        claimId: card.claim_id,
        agentId: card.claimed_by_agent_id,
        reason,
        lastHandoffId: await lastHandoffId(tx, card.id),
        ...(rejection ? { rejection } : {}),
      },
    },
    actor: SYSTEM_ACTOR,
    scope: projectScope(card.org_id, card.project_id),
  });
  if (message !== null) events.push(cardMessage(card, { kind: 'system' }, 'system', message));
  if (shiftOutcome && card.claim_shift_id) {
    const s = await one(tx, `SELECT * FROM shifts WHERE id=$1 AND status <> 'ended'`, [card.claim_shift_id]);
    if (s) events.push(await shiftEndedFor(tx, s, shiftOutcome));
  }
  return events;
}

// ------------------------------------------------------------------------------------- reports

export async function applyShiftReport(
  ctx: Ctx,
  tx: Tx,
  ws: WsRef,
  msg: RunnerToServerOf<'shift.report'>,
): Promise<ReportResult> {
  const shift = await one(tx, 'SELECT * FROM shifts WHERE id=$1 AND workstation_id=$2', [msg.shiftId, ws.id]);
  if (!shift) return { accepted: false, error: 'unknown shift' };
  if (shift.status === 'ended') return { accepted: false, error: 'this shift has already ended' };
  if (shift.kind === 'devops') return applyDevopsReport(ctx, tx, ws, msg, shift);
  if (shift.kind === 'question') return applyQuestionReport(ctx, tx, ws, msg.report, shift);
  if (shift.kind === 'ba_task') return applyBaTaskReport(ctx, tx, ws, msg, shift);
  if (!shift.card_id) return { accepted: false, error: 'this shift has no card to report on' };
  const card = await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [shift.card_id]);
  if (!card) return { accepted: false, error: 'card not found' };
  const report = msg.report;

  if (report.kind !== 'comment') {
    const done = await one(tx, 'SELECT 1 FROM card_handoffs WHERE shift_id=$1', [shift.id]);
    if (done)
      return {
        accepted: false,
        error: 'already reported: exactly one terminal report is accepted per shift (409)',
      };
  }
  if (card.claim_shift_id !== shift.id) {
    return {
      accepted: false,
      error: `this shift no longer holds the claim on ${card.ref}; stop work and exit`,
    };
  }
  const agent = await one(tx, 'SELECT * FROM agents WHERE id=$1', [shift.agent_id]);
  if (!agent) return { accepted: false, error: 'agent not found' };

  if (report.kind === 'comment') {
    await ctx.store.append(
      [cardMessage(card, { kind: 'agent', agentId: agent.id }, 'comment', report.note)],
      { tx },
    );
    return { accepted: true };
  }
  if (report.kind === 'question') return raiseQuestion(ctx, tx, shift, card, agent, report);
  if (report.kind !== 'outcome')
    return { accepted: false, error: '`aom answer` and `aom escalate` are for question shifts only' };

  const wf = await loadWorkflowById(tx, card.workflow_version_id);
  if (!wf) return { accepted: false, error: 'workflow definition is missing' };
  const stage = getStage(wf.definition, card.stage);
  const outcome = getOutcome(wf.definition, card.stage, report.outcomeId);
  if (!stage || !outcome) {
    const allowed = (stage?.outcomes ?? []).map((o) => o.id).join(', ') || 'none';
    return {
      accepted: false,
      error: `outcome '${report.outcomeId}' is not available on stage '${card.stage}' (allowed: ${allowed})`,
    };
  }
  const data = outcomeDataSchema(outcome.data).safeParse(report.data);
  if (!data.success) {
    return {
      accepted: false,
      error: `invalid data for outcome '${outcome.id}': ${data.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    };
  }
  const payloadData = data.data as Record<string, any>;
  const resolved = resolveOutcome(
    wf.definition,
    { ...card, docsNeeded: card.docs_needed, fields: card.fields },
    card.stage,
    outcome.id,
  );

  const scope = projectScope(card.org_id, card.project_id);
  const actor = agentActor(agent.id);
  const handoffId = randomUUID();
  const cardId = card.id as string;
  const mk = (event: AppendInput['event']): AppendInput => ({
    streamId: streamId.card(cardId),
    event,
    actor,
    scope,
  });

  let handoffData: Record<string, unknown> = payloadData;
  let main: AppendInput | undefined;
  let mains: AppendInput[] | null = null;
  const after: AppendInput[] = [];
  /** Events that belong to the outcome and follow it (desk items, thread notes). */
  const followUps: AppendInput[] = [];
  let acceptMessage: string | undefined;
  switch (outcome.event) {
    case 'ReviewRequested': {
      const diffStats = msg.diffStats ?? ZERO_DIFF;
      const riskTier =
        card.risk_tier_overridden && card.risk_tier ? card.risk_tier : (msg.riskTier ?? 'small');
      handoffData = { diffStats, riskTier };
      main = mk({
        type: 'ReviewRequested',
        payload: { cardId, fromStage: 'build', toStage: resolved.toStage, riskTier, diffStats },
      });
      break;
    }
    case 'ReviewApproved': {
      if (await outOfScopeTestChange(tx, cardId))
        return {
          accepted: false,
          error:
            'the builder changed unit tests outside the card scope (flagged on the diff): request changes with `--reason out_of_scope_test_change`; this cannot be approved',
        };
      const tier = (card.risk_tier ?? 'small') as 'small' | 'large';
      const required = stage.approvals?.[tier] ?? 1;
      const soFar = Number(card.review_approvals) + 1;
      const toStage = soFar >= required ? resolved.toStage : card.stage;
      main = mk({
        type: 'ReviewApproved',
        payload: {
          cardId,
          reviewerAgentId: agent.id,
          score: payloadData.score,
          comments: report.note,
          approvalsSoFar: soFar,
          approvalsRequired: required,
          toStage,
        },
      });
      break;
    }
    case 'ChangesRequested': {
      if (resolved.toStage !== 'build')
        return { accepted: false, error: `unsupported transition to '${resolved.toStage}'` };
      main = mk({
        type: 'ChangesRequested',
        payload: {
          cardId,
          fromStage: 'review',
          toStage: 'build',
          reviewerAgentId: agent.id,
          reasons: (await outOfScopeTestChange(tx, cardId))
            ? [...new Set([...(payloadData.reasons ?? []), 'out_of_scope_test_change'])]
            : (payloadData.reasons ?? []),
          score: payloadData.score,
          criteriaMissed: payloadData.criteriaMissed ?? [],
          comments: report.note,
        },
      });
      break;
    }
    case 'TestPassed':
    case 'TestFailed': {
      const ev = payloadData as TestEvidence;
      if (isSuiteOrigin(card.origin)) {
        mains = await suiteOutcomeEvents(
          ctx,
          tx,
          card,
          ws,
          agent.id,
          outcome.event === 'TestPassed',
          report.note,
          ev,
        );
        break;
      }
      if (outcome.event === 'TestFailed') {
        mains = await testFailedEvents(tx, card, agent.id, report.note, ev);
        break;
      }
      main = mk({
        type: 'TestPassed',
        payload: {
          cardId,
          testerAgentId: agent.id,
          evidence: payloadData as never,
          toStage: resolved.toStage,
        },
      });
      break;
    }
    case 'StageCompleted':
      main = mk({
        type: 'StageCompleted',
        payload: {
          cardId,
          fromStage: card.stage,
          toStage: resolved.toStage,
          outcome: outcome.id,
          ...(outcome.rework ? { rework: true } : {}),
        },
      });
      if (outcome.effect === 'resume_parent' && card.parent_card_id) {
        const parent = await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [card.parent_card_id]);
        if (parent && parent.status === 'waiting') {
          after.push({
            streamId: streamId.card(parent.id),
            event: {
              type: 'ChildCardResolved',
              payload: { cardId: parent.id, childCardId: cardId, toStage: 'test' },
            },
            actor,
            scope,
          });
          after.push(
            cardMessage(
              parent,
              { kind: 'system' },
              'system',
              `${card.ref} (${card.title}) passed review: ${parent.ref} is back in the Test queue.`,
            ),
          );
        }
      }
      break;
    case 'DigestPosted': {
      const project = await one(tx, 'SELECT * FROM projects WHERE id=$1', [card.project_id]);
      const digest = await buildDigestEvents(tx, {
        card,
        agent,
        project: project as Row,
        note: report.note,
        data: payloadData as DigestData,
        now: ctx.clock.now(),
      });
      if (!digest.ok) return { accepted: false, error: digest.error };
      main = digest.events[0] as AppendInput;
      followUps.push(...digest.events.slice(1));
      acceptMessage = `${digest.summary} Finish now.`;
      break;
    }
    case 'CardFinalized': {
      // The BA's finalize queue: the completion action goes to the card's workstation (a large merge to the desk).
      const fin = await baFinalizeEvents(tx, {
        card,
        agent,
        action: payloadData.action,
        note: report.note,
      });
      if (!fin.ok) return { accepted: false, error: fin.error };
      mains = fin.events;
      handoffData = { action: payloadData.action };
      acceptMessage = fin.message;
      break;
    }
    case 'ResearchPublished': {
      const project = await one(tx, 'SELECT * FROM projects WHERE id=$1', [card.project_id]);
      const pub = buildPublicationEvents({ card, agent, project: project as Row, data: payloadData });
      if (!pub.ok) return { accepted: false, error: pub.error };
      main = pub.events[0] as AppendInput;
      followUps.push(...pub.events.slice(1));
      handoffData = pub.handoffData;
      acceptMessage = `${pub.summary} Finish now.`;
      break;
    }
    default:
      return {
        accepted: false,
        error: `outcome '${outcome.id}' (${outcome.event}) is not supported by this server version yet`,
      };
  }

  await ctx.store.append(
    [
      mk({
        type: 'HandoffWritten',
        payload: {
          cardId,
          handoffId,
          shiftId: shift.id,
          agentId: agent.id,
          stage: card.stage,
          outcome: outcome.id,
          note: report.note,
          data: handoffData,
        },
      }),
      ...(mains ?? (main ? [main] : [])),
      ...followUps,
      mk({
        type: 'ClaimReleased',
        payload: {
          cardId,
          claimId: card.claim_id,
          agentId: agent.id,
          reason: 'handoff',
          lastHandoffId: handoffId,
        },
      }),
      ...after,
    ],
    { tx },
  );
  return { accepted: true, ...(acceptMessage ? { message: acceptMessage } : {}) };
}

/** The latest build handoff's diff carries the out-of-scope unit test change flag (spec: an automatic bounce). */
async function outOfScopeTestChange(tx: Tx, cardId: string): Promise<boolean> {
  const h = await one(
    tx,
    `SELECT data FROM card_handoffs WHERE card_id=$1 AND data ? 'diffStats' ORDER BY created_at DESC, event_seq DESC LIMIT 1`,
    [cardId],
  );
  return h?.data?.diffStats?.outOfScopeTestChange === true;
}

// ----------------------------------------------------------------------------- shift lifecycle

export async function markShiftAccepted(ctx: Ctx, ws: WsRef, shiftId: string) {
  await exec(
    ctx.pool,
    'UPDATE shifts SET accepted_at=$3 WHERE id=$1 AND workstation_id=$2 AND accepted_at IS NULL',
    [shiftId, ws.id, ctx.clock.now()],
  );
}

export async function applyShiftStarted(ctx: Ctx, tx: Tx, ws: WsRef, msg: RunnerToServerOf<'shift.started'>) {
  const s = await one(tx, 'SELECT * FROM shifts WHERE id=$1 AND workstation_id=$2', [msg.shiftId, ws.id]);
  if (!s || s.status === 'ended') return;
  const card = s.card_id ? await one(tx, 'SELECT * FROM cards WHERE id=$1', [s.card_id]) : undefined;
  await exec(tx, 'UPDATE shifts SET accepted_at = COALESCE(accepted_at, $2) WHERE id=$1', [
    s.id,
    ctx.clock.now(),
  ]);
  const created = msg.branchCreated;
  await ctx.store.append(
    [
      ...(card && created
        ? [
            cardMessage(
              card,
              { kind: 'system' },
              'system',
              `Created working branch ${created.base} from ${created.from}${created.pushed ? ' and pushed it to origin' : ''}: it did not exist in the repository.`,
              { branchCreated: created },
            ),
            ...(card.repo_id
              ? [
                  {
                    streamId: streamId.project(card.project_id),
                    event: {
                      type: 'ProjectRepoWorkingBranchCreated' as const,
                      payload: {
                        projectId: card.project_id,
                        repoId: card.repo_id,
                        workingBranch: created.base,
                        from: created.from,
                        pushed: created.pushed,
                      },
                    },
                    actor: runnerActor(ws.id),
                    scope: projectScope(card.org_id, card.project_id),
                  },
                ]
              : []),
          ]
        : []),
      {
        streamId: streamId.shift(s.id),
        event: {
          type: 'ShiftStarted',
          payload: {
            shiftId: s.id,
            agentId: s.agent_id,
            workstationId: s.workstation_id,
            cardId: s.card_id ?? undefined,
            kind: s.kind,
            stage: s.stage ?? undefined,
            runtime: s.runtime,
            model: s.model,
            overflow: s.overflow,
            runtimeSessionId: msg.runtimeSessionId,
            worktree: msg.worktree,
          },
        },
        actor: runnerActor(ws.id),
        scope: card ? projectScope(card.org_id, card.project_id) : orgScope(s.org_id),
      },
    ],
    { tx },
  );
}

export async function applyShiftRejected(
  ctx: Ctx,
  tx: Tx,
  ws: WsRef,
  msg: RunnerToServerOf<'shift.rejected'>,
) {
  const s = await one(tx, 'SELECT * FROM shifts WHERE id=$1 AND workstation_id=$2', [msg.shiftId, ws.id]);
  if (!s || s.status === 'ended') return;
  if (s.kind === 'devops') {
    await ctx.store.append(await endDevopsShift(tx, s, 'rejected', { finalText: msg.detail }), { tx });
    return;
  }
  if (s.kind === 'question') {
    await ctx.store.append(endQuestionShift(s, 'rejected'), { tx });
    return;
  }
  if (s.kind === 'ba_task') {
    await ctx.store.append(await endBaTaskShift(tx, s, 'rejected'), { tx });
    return;
  }
  const card = s.card_id
    ? await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [s.card_id])
    : undefined;
  if (!card || card.claim_shift_id !== s.id) {
    await ctx.store.append([await shiftEndedFor(tx, s, 'rejected')], { tx });
    return;
  }
  const extra: AppendInput[] = [];
  if (msg.reason === 'rebase_conflict') {
    extra.push(
      ...rebaseConflictEvents(card, ws.id, card.stage, card.base_branch ?? '', msg.conflictedFiles ?? []),
      ...(await cardConflictAttemptEvents(
        ctx,
        tx,
        card,
        ws.id,
        card.stage,
        card.base_branch ?? '',
        msg.conflictedFiles ?? [],
      )),
    );
  } else if (msg.reason === 'environment_not_ready' && msg.environment) {
    extra.push(...(await environmentNotReadyEvents(ctx, tx, ws, card, msg.environment)));
  }
  let rejection: { reason: string; detail: string; kind?: 'branch'; repoId?: string } | undefined;
  if (msg.reason === 'worktree_failed' && msg.branchProblem && card.repo_id) {
    const branch = await branchProblemEvents(ctx, tx, card, msg.branchProblem);
    extra.push(...branch.events);
    rejection = branch.rejection;
  } else if (['repo_missing', 'worktree_failed', 'runtime_unavailable', 'internal'].includes(msg.reason)) {
    rejection = { reason: msg.reason, detail: msg.detail ?? msg.reason.replaceAll('_', ' ') };
  }
  const text = `Shift rejected by the runner (${msg.reason}${msg.detail ? `: ${msg.detail}` : ''}); the card is back in the queue.`;
  await ctx.store.append(
    await releaseClaimEvents(tx, card, 'runner_rejected', text, 'rejected', extra, rejection),
    { tx },
  );
}

/**
 * The runner says the card's working branch does not exist in its clone. Asks the manager (one open working-branch
 * question per repository: later rejections add nothing) with the repository's branches as options and its default
 * branch preselected, and holds the card back with a growing pause so the queue is not hammered. A branch the manager
 * confirmed is never changed here: the question offers it, the manager decides.
 */
async function branchProblemEvents(
  ctx: Ctx,
  tx: Tx,
  card: Row,
  problem: {
    base: string;
    defaultBranch?: string | undefined;
    branches: string[];
    createFailed?: string | undefined;
  },
): Promise<{
  events: AppendInput[];
  rejection: { reason: string; detail: string; kind: 'branch'; repoId: string };
}> {
  const repo = await one(tx, 'SELECT * FROM project_repos WHERE id=$1 AND removed_at IS NULL', [
    card.repo_id,
  ]);
  const project = await one(tx, 'SELECT * FROM projects WHERE id=$1', [card.project_id]);
  const where = repo?.name ?? 'the repository';
  const rejection = {
    reason: 'worktree_failed',
    detail: `working branch '${problem.base}' does not exist in ${where}${problem.defaultBranch ? ` (default branch is ${problem.defaultBranch})` : ''}`,
    kind: 'branch' as const,
    repoId: card.repo_id as string,
  };
  const events = rejectionBackoffEvents(ctx, card);
  if (repo && project) {
    events.push(
      ...(await workingBranchQuestionEvents(ctx, tx, project, repo, {
        reason: repo.working_branch ? 'manual' : 'unconfirmed',
        branches: problem.branches,
        missing: {
          base: problem.base,
          defaultBranch: problem.defaultBranch ?? null,
          cardId: card.id,
          cardRef: card.ref,
          ...(problem.createFailed ? { createFailed: problem.createFailed } : {}),
        },
      })),
    );
  }
  return { events, rejection };
}

export async function applyShiftEnded(ctx: Ctx, tx: Tx, ws: WsRef, msg: RunnerToServerOf<'shift.ended'>) {
  const s = await one(tx, 'SELECT * FROM shifts WHERE id=$1 AND workstation_id=$2', [msg.shiftId, ws.id]);
  if (!s || s.status === 'ended') return;
  if (s.kind === 'devops') {
    await ctx.store.append(
      await endDevopsShift(tx, s, msg.outcome, {
        durationMs: msg.durationMs,
        usage: msg.usage,
        exitCode: msg.exitCode,
        finalText: msg.finalText,
        guardViolations: msg.guardViolations,
      }),
      { tx },
    );
    return;
  }
  if (s.kind === 'ba_task') {
    await ctx.store.append(
      await endBaTaskShift(tx, s, msg.outcome, {
        durationMs: msg.durationMs,
        usage: msg.usage,
        exitCode: msg.exitCode,
        guardViolations: msg.guardViolations,
      }),
      { tx },
    );
    return;
  }
  if (s.kind === 'question') {
    await ctx.store.append(
      endQuestionShift(s, msg.outcome, {
        durationMs: msg.durationMs,
        usage: msg.usage,
        exitCode: msg.exitCode,
        guardViolations: msg.guardViolations,
      }),
      { tx },
    );
    return;
  }
  const events: AppendInput[] = [];
  const card = s.card_id
    ? await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [s.card_id])
    : undefined;
  const handoff = await one<{ outcome: string }>(
    tx,
    'SELECT outcome FROM card_handoffs WHERE shift_id=$1 ORDER BY created_at DESC, event_seq DESC LIMIT 1',
    [s.id],
  );
  const asked = handoff
    ? undefined
    : await one(tx, 'SELECT 1 FROM desk_items WHERE shift_id=$1 AND blocking LIMIT 1', [s.id]);
  if (card && card.claim_shift_id === s.id) {
    const stopped = msg.outcome === 'stopped';
    const text = stopped
      ? 'Shift stopped; the card is back in the queue.'
      : `Shift ended without a report (${msg.outcome}); the card is back in the queue.${msg.finalText ? `\n\n${msg.finalText}` : ''}`;
    // Loop breaker: repeated failures put the card in back-off and collapse the repeated thread message.
    const plan =
      stopped || handoff || asked
        ? { message: text, events: [] as AppendInput[] }
        : await loopBreakerPlan(ctx, tx, card, text, msg.finalText);
    events.push(
      ...(await releaseClaimEvents(
        tx,
        card,
        stopped ? 'manual' : 'shift_failed',
        plan.message,
        null,
        plan.events,
      )),
    );
  }
  events.push(
    await shiftEndedFor(tx, s, msg.outcome, {
      reportOutcome: handoff?.outcome ?? (asked ? 'question' : undefined),
      durationMs: msg.durationMs,
      usage: msg.usage,
      exitCode: msg.exitCode,
      guardViolations: msg.guardViolations,
    }),
  );
  await ctx.store.append(events, { tx });
}
