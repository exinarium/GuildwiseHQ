import { randomUUID } from 'node:crypto';
import {
  allowedOutcomes,
  BRIEF_STAGE_ID,
  BuildEvidenceInputSchema,
  buildEvidenceProblem,
  type ClaimReleaseReason,
  capDiff,
  DEFAULT_OWNER_APPROVAL_POLICY,
  DESK_SUBKIND,
  type DiffStats,
  type DigestData,
  getOutcome,
  getStage,
  highRiskPaths,
  highRiskSummary,
  type InvestigationData,
  isBriefWorkflowKey,
  isSuiteOrigin,
  isValidReportPath,
  type LedgerMatch,
  NO_COMMIT_IDENTITY_CODE,
  NO_COMMIT_IDENTITY_MESSAGE,
  OWNER_APPROVAL_REASON_TEXT,
  type OwnerApprovalPolicy,
  type OwnerApprovalReason,
  outcomeDataSchema,
  ownerApprovalDecision,
  type RunnerToServerOf,
  requiredMissing,
  resolveOutcome,
  type ShiftEndOutcome,
  type StoredBuildEvidence,
  streamId,
  type TestEvidence,
  WorkflowResolveError,
} from '@aom/shared';
import { loadWorkflowById } from '../catalogue/loader.ts';
import { applyCeoReport } from '../ceo/report.ts';
import { endCeoShift, rejectionText } from '../ceo/shift.ts';
import type { Ctx } from '../context.ts';
import { exec, one, type Row } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import { dependencyStates } from '../dispatcher/dependencies.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { baFinalizeEvents } from './ba-finalize.ts';
import { applyBaTaskReport, endBaTaskShift } from './ba-tasks.ts';
import { cardView, workflowView } from './cards.ts';
import { markAccountOut } from './claude-accounts.ts';
import { agentActor, cardMessage, orgScope, projectScope, runnerActor, SYSTEM_ACTOR } from './common.ts';
import { cardConflictAttemptEvents } from './conflict-attempts.ts';
import { raiseOrCoalesce } from './desk-coalesce.ts';
import { applyDevopsReport, endDevopsShift } from './devops.ts';
import { applyQuestionReport, endQuestionShift } from './escalation.ts';
import { buildDigestEvents } from './feeds.ts';
import { workingBranchQuestionEvents } from './hygiene.ts';
import { loopBreakerPlan, rejectionBackoffEvents } from './loop-breaker.ts';
import { qaStepsEvents } from './qa.ts';
import { checkBriefNote } from './brief-check.ts';
import { QA_STEPS_STAGE } from './qa-flow.ts';
import { affinityEvent } from './question-flow.ts';
import { raiseQuestion } from './questions.ts';
import { rebaseConflictEvents } from './rebase.ts';
import { buildPublicationEvents } from './research.ts';
import { mergeRisk, riskFields, type StoredRisk, withoutRisk } from './review-risk.ts';
import { cardUsage, limitReached, stopLossBudget, stopLossEvents } from './stop-loss.ts';
import {
  endTestEnvironmentIn,
  openSuitesOf,
  reviewApprovedPlan,
  runProblemEvents,
  stageEnvironmentOf,
} from './test-environments.ts';
import { environmentNotReadyEvents, suiteOutcomeEvents, testFailedEvents } from './testing.ts';
import { deliver } from './workstation-setup.ts';

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
  /** Accepted, but not terminal: the runner keeps the shift going. */
  continueShift?: boolean;
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
  if (shift.kind === 'ceo') return applyCeoReport(ctx, tx, ws, msg, shift);
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
  const workflowCard = workflowView(card);
  let resolved: ReturnType<typeof resolveOutcome>;
  try {
    resolved = resolveOutcome(wf.definition, workflowCard, card.stage, outcome.id);
  } catch (err) {
    if (err instanceof WorkflowResolveError && err.code === 'outcome_not_allowed') {
      const allowed = allowedOutcomes(wf.definition, workflowCard, card.stage)
        .map((o) => o.id)
        .join(', ');
      return {
        accepted: false,
        error: `outcome '${outcome.id}' does not apply to ${card.ref}${card.investigation_only ? ' (an investigation-only card ends with its report)' : ''}; allowed outcomes: ${allowed || 'none'}`,
      };
    }
    throw err;
  }
  // The stage the card moves to must be enterable: refuse a report that would leave the next stage without what it needs.
  if (outcome.kind === 'success') {
    const next = getStage(wf.definition, resolved.toStage);
    const missing = next?.kind === 'agent' ? requiredMissing(cardView(card), next) : [];
    if (missing.length)
      return {
        accepted: false,
        error: `${card.ref} cannot move to ${next?.label ?? resolved.toStage}: required fields are missing (${missing.join(', ')}); ask the manager or update the card`,
      };
  }

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

  // lean team: a review verdict is for the commit the build evidence is bound to; a verdict for another commit is refused.
  if (outcome.kind === 'success' && REVIEW_STAGES.has(card.stage) && card.build_evidence) {
    const problem = reviewShaProblem(card, shift);
    if (problem) return { accepted: false, error: problem };
  }

  // The pre-review does not rate the risk (the Opus review does): whatever risk call it sent (a reviewer covering the
  // pre-review has been seen to attach an existing document, the architect's report) is neither stored on the card nor
  // kept on the handoff.
  let handoffData: Record<string, unknown> =
    card.stage === 'pre_review' ? withoutRisk(payloadData) : payloadData;
  let main: AppendInput | undefined;
  let mains: AppendInput[] | null = null;
  const after: AppendInput[] = [];
  /** Events that belong to the outcome and follow it (desk items, thread notes). */
  const followUps: AppendInput[] = [];
  let acceptMessage: string | undefined;
  /** Refs of the unlanded dependencies when this design is held for the assumption review. */
  let holdDesign: string[] | undefined;
  switch (outcome.event) {
    case 'ReviewRequested': {
      const diffStats = msg.diffStats ?? ZERO_DIFF;
      const riskTier =
        card.risk_tier_overridden && card.risk_tier ? card.risk_tier : (msg.riskTier ?? 'small');
      handoffData = { diffStats, riskTier };
      // lean team: the handoff carries build and unit test evidence bound to the commit the runner measured; the server
      // computes the high-risk flag from the paths of the diff (an agent cannot lower it) and keeps the diff for the owner.
      let lean: Extract<ReturnType<typeof leanHandoff>, { ok: true }> | undefined;
      if (stage.requireBuildEvidence) {
        const built = leanHandoff(ctx, agent.id, payloadData, msg);
        if (!built.ok) return { accepted: false, error: built.error };
        lean = built;
        handoffData = { diffStats, riskTier, buildEvidence: built.evidence, highRisk: built.highRisk };
        await storeCardDiff(ctx, tx, cardId, built.evidence.sha, msg);
        if (built.highRisk)
          followUps.push(
            cardMessage(
              card,
              { kind: 'system' },
              'system',
              `${card.ref} touches high-risk paths (${highRiskSummary(built.highRiskPaths).labels.join('; ')}): it needs a second Opus review and the owner's approval.`,
            ),
          );
      }
      main = mk({
        type: 'ReviewRequested',
        payload: {
          cardId,
          fromStage: 'build',
          toStage: resolved.toStage,
          riskTier,
          diffStats,
          ...(lean
            ? {
                headSha: lean.evidence.sha,
                evidence: lean.evidence,
                highRisk: lean.highRisk,
                highRiskPaths: lean.highRiskPaths.slice(0, 50),
              }
            : {}),
        },
      });
      break;
    }
    case 'ReviewApproved': {
      const tier = (card.risk_tier ?? 'small') as 'small' | 'large';
      // lean team: a high-risk change (paths computed by the server) needs a second Opus approval.
      const required = Math.max(stage.approvals?.[tier] ?? 1, card.high_risk === true ? 2 : 1);
      const soFar = Number(card.review_approvals) + 1;
      // The last approval: a card on an older `code` version moves to the one with the integration test guard, and a card
      // that never had `integrationTests` takes the project's setting now (docs/design/run-and-integration-tests.md D8).
      const plan = soFar >= required ? await reviewApprovedPlan(tx, card, wf, outcome.id) : null;
      let toStage = soFar >= required ? (plan?.toStage ?? resolved.toStage) : card.stage;
      // lean team: the owner approval decision of the last approval (policy, size, high risk), recorded with its reason.
      let ownerApproval: { required: boolean; reason: OwnerApprovalReason } | undefined;
      if (soFar >= required && getStage(wf.definition, 'owner_approval')) {
        const project = (await one(tx, 'SELECT * FROM projects WHERE id=$1', [card.project_id])) as Row;
        ownerApproval = ownerApprovalDecision({
          policy: (project.owner_approval_policy ?? DEFAULT_OWNER_APPROVAL_POLICY) as OwnerApprovalPolicy,
          highRisk: card.high_risk === true,
          reviewerHighRisk:
            mergeRisk(card.review_risk as StoredRisk | null, riskFields(payloadData)).level === 'high',
          riskTier: tier,
          largeWaived: project.merge_large_without_approval === true,
        });
        toStage = resolveOutcome(
          wf.definition,
          { ...workflowCard, ownerApproval: ownerApproval.required },
          card.stage,
          outcome.id,
        ).toStage;
        followUps.push(
          cardMessage(
            card,
            { kind: 'system' },
            'system',
            ownerApproval.required
              ? `Owner approval required for ${card.ref}: ${OWNER_APPROVAL_REASON_TEXT[ownerApproval.reason]}.`
              : `Owner approval not required for ${card.ref}: ${OWNER_APPROVAL_REASON_TEXT[ownerApproval.reason]}.`,
          ),
        );
      }
      // The second approval of a high-risk card comes from another reviewer when one is hired.
      const another =
        soFar < required && card.high_risk === true
          ? await one(
              tx,
              `SELECT 1 AS ok FROM agents a WHERE a.org_id=$1 AND a.status='active' AND a.paused_at IS NULL AND NOT a.is_devops
                  AND a.role_key=$2 AND a.id <> $3 AND NOT (a.id = ANY ($5::uuid[])) AND a.seniority='senior'
                  AND (a.allowed_project_ids IS NULL OR $4::uuid = ANY (a.allowed_project_ids)) LIMIT 1`,
              [card.org_id, agent.role_key, agent.id, card.project_id, card.excluded_agent_ids ?? []],
            )
          : null;
      main = mk({
        type: 'ReviewApproved',
        payload: {
          cardId,
          reviewerAgentId: agent.id,
          score: payloadData.score,
          comments: report.note,
          ...(card.stage === 'pre_review' ? {} : riskFields(payloadData)),
          approvalsSoFar: soFar,
          approvalsRequired: required,
          toStage,
          ...(plan?.workflowVersionId ? { workflowVersionId: plan.workflowVersionId } : {}),
          ...(plan?.integrationTests !== undefined ? { integrationTests: plan.integrationTests } : {}),
          ...(soFar < required && card.high_risk === true && !another ? { excludeReviewer: false } : {}),
          ...(ownerApproval ? { ownerApproval } : {}),
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
          fromStage: card.stage === 'pre_review' || card.stage === 'merge_review' ? card.stage : 'review',
          toStage: 'build',
          reviewerAgentId: agent.id,
          reasons: payloadData.reasons ?? [],
          score: payloadData.score,
          criteriaMissed: payloadData.criteriaMissed ?? [],
          comments: report.note,
          ...(card.stage === 'pre_review' ? {} : riskFields(payloadData)),
        },
      });
      // Stop-loss (design 11): a card that used its review rounds or build passes is parked for the architect;
      // otherwise the findings go back to the builder, who keeps affinity to the card (and resumes its session).
      const usage = await cardUsage(tx, cardId);
      const budget = await stopLossBudget(tx, card);
      // The pre-review (lean team) is not an Opus review round: only the build passes cap its loop.
      const limit = limitReached(
        usage,
        budget,
        card.stage === 'pre_review' ? { preReview: true } : { reviewRound: true },
      );
      if (limit) {
        followUps.push(
          ...(await stopLossEvents(
            ctx,
            tx,
            card,
            limit,
            { ...usage, reviewRounds: usage.reviewRounds + 1 },
            budget,
          )),
        );
      } else {
        const builderId =
          (
            await one<{ agent_id: string }>(
              tx,
              `SELECT agent_id FROM card_handoffs WHERE card_id=$1 AND stage='build' AND agent_id IS NOT NULL
                ORDER BY created_at DESC, event_seq DESC LIMIT 1`,
              [cardId],
            )
          )?.agent_id ?? card.original_builder_agent_id;
        if (builderId) followUps.push(affinityEvent(ctx, card, builderId, 'review'));
      }
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
        mains = await testFailedEvents(ctx, tx, card, agent.id, report.note, ev, shift.start_sha ?? null);
        break;
      }
      // Integration tests: the pass is refused while a confirmed suite of the project has no passing result in this shift.
      const open = await openSuitesOf(tx, card, shift);
      if (open.length > 0)
        return {
          accepted: false,
          error: `${open.length === 1 ? 'a suite has' : 'suites have'} no passing result yet: ${open.join(', ')}. Run ${open.length === 1 ? 'it' : 'them'} and report each with \`aom test suite --name <suite> --status passed|failed|timeout|skipped\`; a failure is reported with \`aom test fail\`.`,
        };
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
      if (isBriefWorkflowKey(wf.definition.key) && card.stage === BRIEF_STAGE_ID) {
        // A brief is checked before it is accepted: the cap, and only cards and rules of this organization.
        const problem = await checkBriefNote(tx, card, report.note);
        if (problem) return { accepted: false, error: problem };
      }
      if (card.stage === QA_STEPS_STAGE) {
        // Manual QA: the note is the agent's test steps; they are posted on the card for the person who tests it.
        if (!report.note.trim())
          return { accepted: false, error: 'the QA steps are empty: write the steps and report again' };
        followUps.push(...qaStepsEvents(card, agent.id, report.note.trim()));
        acceptMessage = 'Recorded. The steps are on the card for the person who tests it. Finish now.';
      }
      if (outcome.data === 'investigation') {
        const inv = payloadData as InvestigationData;
        const pending = card.design_review?.state === 'waiting';
        const states = await dependencyStates(tx, cardId);
        const unlanded = states.filter((d) => !d.landed);
        // A design made before the dependencies landed (no card branch yet): its assumptions are recorded and the card
        // is held in the design stage until they land (backlog #80).
        const early =
          !pending &&
          !card.investigation_only &&
          unlanded.length > 0 &&
          !card.worktree_path &&
          String(card.stage).startsWith('investigate');
        const total = ((card.investigation?.assumptions ?? []) as unknown[]).length;
        if (inv.review && !pending)
          return { accepted: false, error: 'no assumption review is pending on this card: use `aom design`' };
        if (pending && !inv.review)
          return {
            accepted: false,
            error:
              'this is the assumption review of a design made before its dependencies landed: finish with `aom design confirm` or `aom design revise`',
          };
        if (early && !inv.assumptions?.length && !inv.noAssumptions)
          return {
            accepted: false,
            error: `${card.ref} is designed before ${unlanded.map((d) => d.ref).join(', ')} landed: record the assumptions you made about them (\`--assumption "<assumption> | <dependency ref> | <what changes if wrong>"\`, repeatable) or say there are none with \`--no-assumptions "<why>"\``,
          };
        const review = inv.review;
        const confirming = pending && review?.decision === 'confirm';
        if (review) {
          const revised = [...new Set(review.revised)];
          if (revised.some((n) => n > total))
            return {
              accepted: false,
              error: `the design has ${total} recorded assumptions: --revised numbers them 1..${total}`,
            };
          if (review.decision === 'confirm' && revised.length > 0)
            return {
              accepted: false,
              error:
                '`aom design confirm` confirms every assumption: use `aom design revise --revised <numbers>`',
            };
          if (review.decision === 'revise' && revised.length === 0)
            return {
              accepted: false,
              error: '`aom design revise` needs --revised <numbers> (the assumptions that did not hold)',
            };
          followUps.push(
            mk({
              type: 'DesignReviewed',
              payload: {
                cardId,
                decision: review.decision,
                confirmed: total - revised.length,
                revised: revised.length,
                note: review.note,
                agentId: agent.id,
              },
            }),
            cardMessage(
              card,
              { kind: 'agent', agentId: agent.id },
              'comment',
              `Assumption review: ${total - revised.length} confirmed, ${revised.length} revised.${review.note ? `\n\n${review.note}` : ''}`,
            ),
          );
        }
        if (!confirming) {
          if (!isValidReportPath(inv.reportPath))
            return {
              accepted: false,
              error: `the report path '${inv.reportPath}' is not a valid relative path`,
            };
          followUps.push(
            {
              streamId: streamId.card(cardId),
              event: {
                type: 'InvestigationReported',
                payload: {
                  cardId,
                  reportPath: inv.reportPath,
                  location: inv.location,
                  summary: inv.summary,
                  ...(inv.commit ? { commit: inv.commit } : {}),
                  ...(inv.body ? { body: inv.body } : {}),
                  ...(inv.assumptions?.length ? { assumptions: inv.assumptions } : {}),
                  investigationOnly: !!card.investigation_only,
                },
              },
              actor,
              scope,
            },
            cardMessage(
              card,
              { kind: 'agent', agentId: agent.id },
              'comment',
              `Investigation report ${inv.location === 'vault' ? 'in the vault' : inv.body ? 'carried on the card (committed when Build starts)' : 'on the card branch'}: ${inv.reportPath}\n\n${inv.summary}${inv.assumptions?.length ? `\n\nAssumptions about ${unlanded.map((d) => d.ref).join(', ')}:\n${inv.assumptions.map((a, i) => `${i + 1}. ${a.assumption} (${a.dependency}); if wrong: ${a.ifWrong}`).join('\n')}` : ''}`,
            ),
          );
        }
        if (early && inv.assumptions?.length) holdDesign = unlanded.map((d) => d.ref);
        acceptMessage = holdDesign
          ? 'Recorded. The card waits until its dependencies have landed; you review the assumptions then. Finish now.'
          : card.investigation_only
            ? 'Recorded. The BA records the result next. Finish now.'
            : 'Recorded. The card goes to the builder with your design. Finish now.';
      }
      main = holdDesign
        ? mk({ type: 'DesignHeld', payload: { cardId, dependencies: holdDesign, agentId: agent.id } })
        : mk({
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
      handoffData = { action: fin.action };
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
  // A stage that ran against the project's environment is over: stop it (kept for a while after a failure).
  if ((await stageEnvironmentOf(tx, card)) === 'project') {
    const nudge = await endTestEnvironmentIn(ctx, tx, card, outcome.kind === 'failure');
    if (nudge) deliver(ctx, [nudge]);
  }
  return { accepted: true, ...(acceptMessage ? { message: acceptMessage } : {}) };
}

const REVIEW_STAGES = new Set(['pre_review', 'review', 'merge_review']);

/** Why a review verdict cannot be taken: the evidence, the branch and the commit the reviewer read must be one commit. */
export function reviewShaProblem(card: Row, shift: Row): string | null {
  const ev = card.build_evidence as { sha?: string } | null;
  const head = card.head_sha as string | null;
  if (!ev?.sha || !head) return null;
  if (ev.sha !== head)
    return `the build evidence is for commit ${ev.sha.slice(0, 10)} but the card branch is at ${head.slice(0, 10)}: the code changed after the builder's evidence. Request changes so the builder runs the build and tests again and hands off`;
  const read = shift.start_sha as string | null;
  if (read && read !== head)
    return `you read commit ${read.slice(0, 10)} but the card branch is at ${head.slice(0, 10)} now: this verdict is not for the commit that will merge. Finish the shift without a verdict; the card is reviewed again`;
  return null;
}

/** A lean team build handoff: the evidence the builder passed, bound to the commit the runner measured, and the high-risk flag. */
function leanHandoff(
  ctx: Ctx,
  agentId: string,
  data: Record<string, any>,
  msg: RunnerToServerOf<'shift.report'>,
):
  | { ok: true; evidence: StoredBuildEvidence; highRisk: boolean; highRiskPaths: string[] }
  | { ok: false; error: string } {
  const parsed = BuildEvidenceInputSchema.safeParse(data.buildEvidence);
  const problem = buildEvidenceProblem(parsed.success ? parsed.data : undefined);
  if (problem) return { ok: false, error: problem };
  if (!parsed.success) return { ok: false, error: 'the build evidence is not valid' };
  if (!msg.headSha)
    return {
      ok: false,
      error:
        'the runner did not report the commit of this handoff, so the evidence cannot be bound to it: update the runner on this workstation',
    };
  const paths = highRiskPaths(msg.changedPaths ?? []);
  return {
    ok: true,
    evidence: { ...parsed.data, sha: msg.headSha, at: ctx.clock.now().toISOString(), agentId },
    highRisk: paths.length > 0,
    highRiskPaths: paths,
  };
}

/** Keeps the diff the runner uploaded (capped at 2 MB, cut with a note) for the owner's approval view. */
async function storeCardDiff(
  ctx: Ctx,
  tx: Tx,
  cardId: string,
  sha: string,
  msg: RunnerToServerOf<'shift.report'>,
): Promise<void> {
  if (!msg.diff) return;
  const capped = capDiff(msg.diff.text);
  await exec(
    tx,
    `INSERT INTO card_diffs (card_id, sha, base, body, bytes, truncated, files, created_at, paths)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
     ON CONFLICT (card_id) DO UPDATE SET sha=EXCLUDED.sha, base=EXCLUDED.base, body=EXCLUDED.body, bytes=EXCLUDED.bytes,
       truncated=EXCLUDED.truncated, files=EXCLUDED.files, created_at=EXCLUDED.created_at, paths=EXCLUDED.paths`,
    [
      cardId,
      sha,
      msg.diff.base,
      capped.text,
      Math.max(msg.diff.bytes, capped.bytes),
      msg.diff.truncated || capped.truncated,
      msg.diffStats?.files ?? 0,
      ctx.clock.now(),
      JSON.stringify(msg.changedPaths ?? []),
    ],
  );
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
      ...(card?.repo_id && msg.originBranches
        ? [
            {
              streamId: streamId.project(card.project_id),
              event: {
                type: 'ProjectRepoBranchesObserved' as const,
                payload: { projectId: card.project_id, repoId: card.repo_id, branches: msg.originBranches },
              },
              actor: runnerActor(ws.id),
              scope: projectScope(card.org_id, card.project_id),
            },
          ]
        : []),
      ...(card && msg.syncMain ? await mainSyncEvents(tx, ws, card, msg.syncMain) : []),
      ...(card && created
        ? [
            cardMessage(
              card,
              { kind: 'system' },
              'system',
              `Created working branch ${created.base} from ${created.from}${created.pushed ? ' and pushed it to origin' : ''}: it did not exist in the repository.${created.mainBranchSet === false ? ` The main branch is not set for this repository, so the runner used the host's default (${created.from}).` : ''}`,
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
            ...(created.mainBranchSet === false ? [mainBranchUnsetNotice(card, created.from)] : []),
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
      ...(card && msg.worktree ? await leanHeadEvents(tx, ws, card, s, msg.worktree) : []),
    ],
    { tx },
  );
}

/**
 * lean team: the commit a card shift started at against the commit the server knows. A clean rebase, a documentation commit
 * and a builder's own commits move the head and are recorded (the evidence and the approvals follow a rebase and a
 * documentation commit). A review shift that finds the branch at another commit than the build evidence is not for the
 * commit that will merge: the card goes back to Build for fresh evidence and the shift is released (the runner stops it).
 * Only a card that already has a recorded head is looked at, so cards of the older workflows are never touched.
 */
async function leanHeadEvents(
  tx: Tx,
  ws: WsRef,
  card: Row,
  s: Row,
  wt: NonNullable<RunnerToServerOf<'shift.started'>['worktree']>,
): Promise<AppendInput[]> {
  const known = card.head_sha as string | null;
  if (!known || known === wt.headSha) return [];
  const scope = projectScope(card.org_id, card.project_id);
  const observed = (source: 'rebase' | 'docs' | 'bugfix' | 'shift_start' | 'conflict'): AppendInput => ({
    streamId: streamId.card(card.id),
    event: { type: 'CardHeadObserved', payload: { cardId: card.id, sha: wt.headSha, source, from: known } },
    actor: runnerActor(ws.id),
    scope,
  });
  if (wt.rebased) return [observed('rebase')];
  // A merge review reads the commit DevOps resolved a conflict to: the branch moved on purpose, the approvals follow.
  if (card.stage === 'merge_review') return [observed('conflict')];
  if (REVIEW_STAGES.has(card.stage) && card.build_evidence) {
    const text = `The review of ${card.ref} found the card branch at ${wt.headSha.slice(0, 10)} but the build evidence is for ${known.slice(0, 10)}: the code changed after the builder's evidence. The card goes back to Build; the builder runs the build and the unit tests again and hands off.`;
    return [
      {
        streamId: streamId.card(card.id),
        event: {
          type: 'EvidenceLapsed',
          payload: { cardId: card.id, stage: card.stage, expectedSha: known, actualSha: wt.headSha },
        },
        actor: runnerActor(ws.id),
        scope,
      },
      cardMessage(card, { kind: 'system' }, 'system', text),
      ...(await releaseClaimEvents(tx, card, 'runner_rejected', null, 'rejected')),
    ];
  }
  if (card.stage === 'docs') return [observed('docs')];
  if (card.stage === 'build' || card.stage === 'investigate') return [observed('shift_start')];
  return [observed('bugfix')];
}

/**
 * `shift.session`: Claude's session id (only known after `shift.started`), the session's context size and, once, what
 * the runner did with a resume request. Recorded as an event so a replay rebuilds `shifts.runtime_session_id`.
 */
export async function applyShiftSession(
  ctx: Ctx,
  tx: Tx,
  ws: WsRef,
  msg: {
    shiftId: string;
    runtimeSessionId?: string | undefined;
    contextTokens?: number | undefined;
    resume?: RunnerToServerOf<'shift.session'>['resume'];
  },
) {
  const s = await one(tx, 'SELECT * FROM shifts WHERE id=$1 AND workstation_id=$2', [msg.shiftId, ws.id]);
  if (!s) return;
  const card = s.card_id
    ? await one(tx, 'SELECT org_id, project_id FROM cards WHERE id=$1', [s.card_id])
    : undefined;
  await ctx.store.append(
    [
      {
        streamId: streamId.shift(s.id),
        event: {
          type: 'ShiftSessionRecorded',
          payload: {
            shiftId: s.id,
            ...(msg.runtimeSessionId ? { runtimeSessionId: msg.runtimeSessionId } : {}),
            ...(msg.contextTokens !== undefined ? { contextTokens: msg.contextTokens } : {}),
            ...(msg.resume ? { resumeState: msg.resume.state } : {}),
          },
        },
        actor: runnerActor(ws.id),
        scope: card ? projectScope(card.org_id, card.project_id) : orgScope(s.org_id),
      },
    ],
    { tx },
  );
}

const SYNC_NOTES: Record<NonNullable<RunnerToServerOf<'shift.started'>['syncMain']>['result'], string> = {
  merged_into_working:
    'The latest main branch was merged into the working branch and pushed before work started.',
  merged_into_card:
    'The working branch could not take the main branch directly (protected or moved), so the latest main branch was merged into the card branch.',
  conflict_in_card:
    'Merging the latest main branch conflicts: the merge is left in the card worktree for the architect to resolve.',
  skipped_conflict:
    'The latest main branch conflicts with the working branch and no architect is on this card: it was not merged, the work goes ahead on the working branch as it is.',
};

/** `shift.started.syncMain`: records what the "merge latest main first" step did, as a thread note and, when skipped, a desk notice. */
async function mainSyncEvents(
  tx: Tx,
  ws: WsRef,
  card: Row,
  sync: NonNullable<RunnerToServerOf<'shift.started'>['syncMain']>,
): Promise<AppendInput[]> {
  if (!card.repo_id) return [];
  const repo = await one(tx, 'SELECT name, main_branch, working_branch FROM project_repos WHERE id=$1', [
    card.repo_id,
  ]);
  const project = await one(tx, 'SELECT working_branch FROM projects WHERE id=$1', [card.project_id]);
  const files = sync.files ?? [];
  const events: AppendInput[] = [
    {
      streamId: streamId.card(card.id),
      event: {
        type: 'CardMainSynced',
        payload: {
          cardId: card.id,
          repoId: card.repo_id,
          result: sync.result,
          ...(repo?.main_branch ? { mainBranch: repo.main_branch } : {}),
          workingBranch: repo?.working_branch ?? project?.working_branch,
          ...(sync.commit ? { commit: sync.commit } : {}),
          ...(files.length ? { files } : {}),
        },
      },
      actor: runnerActor(ws.id),
      scope: projectScope(card.org_id, card.project_id),
    },
    cardMessage(
      card,
      { kind: 'system' },
      'system',
      `${SYNC_NOTES[sync.result]}${files.length ? ` Files: ${files.slice(0, 10).join(', ')}.` : ''}`,
    ),
  ];
  if (sync.result === 'skipped_conflict') {
    const deskItemId = randomUUID();
    events.push({
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId,
          kind: 'alert',
          subkind: DESK_SUBKIND.mainMergeSkipped,
          title: `${card.ref}: main could not be merged into the working branch`,
          body: `The latest main branch conflicts with the working branch${repo?.name ? ` of ${repo.name}` : ''}${files.length ? ` in ${files.slice(0, 10).join(', ')}` : ''}. ${card.ref} was built on the working branch without it; merge main into the working branch by hand or switch on Investigate & design so the architect can resolve it.`,
          options: [],
          blocking: false,
          pinned: false,
          cardId: card.id,
          projectId: card.project_id,
          affectedCardIds: [],
          askedBy: { kind: 'system' },
        },
      },
      actor: SYSTEM_ACTOR,
      scope: projectScope(card.org_id, card.project_id),
    });
  }
  return events;
}

/** A working branch was created from the host's default because the project has no main branch set: tell the owner. */
function mainBranchUnsetNotice(card: Row, from: string): AppendInput {
  const deskItemId = randomUUID();
  return {
    streamId: streamId.desk(deskItemId),
    event: {
      type: 'DeskItemCreated',
      payload: {
        deskItemId,
        kind: 'alert',
        subkind: DESK_SUBKIND.mainBranchUnset,
        title: `${card.ref}: working branch created without a main branch set`,
        body: `The working branch was created from ${from}, the host's default, because no main branch is set for the repository. If ${from} is not your main branch, set it in Project settings.`,
        options: [],
        blocking: false,
        pinned: false,
        cardId: card.id,
        projectId: card.project_id,
        affectedCardIds: [],
        askedBy: { kind: 'system' },
      },
    },
    actor: SYSTEM_ACTOR,
    scope: projectScope(card.org_id, card.project_id),
  };
}

/** One open alert per workstation and project when the runner refuses to commit for lack of an identity (backlog #65). */
async function noCommitIdentityNotice(tx: Tx, ws: WsRef, card: Row): Promise<AppendInput[]> {
  const w = await one<{ name: string }>(tx, 'SELECT name FROM workstations WHERE id=$1', [ws.id]);
  const title = `Nothing can be committed on ${w?.name ?? 'a workstation'}: no commit identity is set`;
  const open = await one(
    tx,
    `SELECT id FROM desk_items WHERE project_id=$1 AND subkind=$2 AND status='open' AND title=$3`,
    [card.project_id, DESK_SUBKIND.noCommitIdentity, title],
  );
  if (open) return [];
  const deskItemId = randomUUID();
  return [
    {
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId,
          kind: 'alert',
          subkind: DESK_SUBKIND.noCommitIdentity,
          title,
          body: NO_COMMIT_IDENTITY_MESSAGE,
          options: [],
          blocking: false,
          pinned: false,
          cardId: card.id,
          projectId: card.project_id,
          affectedCardIds: [],
          askedBy: { kind: 'system' },
        },
      },
      actor: SYSTEM_ACTOR,
      scope: projectScope(card.org_id, card.project_id),
    },
  ];
}

export async function applyShiftRejected(
  ctx: Ctx,
  tx: Tx,
  ws: WsRef,
  msg: RunnerToServerOf<'shift.rejected'>,
) {
  const s = await one(tx, 'SELECT * FROM shifts WHERE id=$1 AND workstation_id=$2', [msg.shiftId, ws.id]);
  if (!s || s.status === 'ended') return;
  // An account that is out (or missing) is known to the dispatcher at once (docs/design/claude-accounts.md 2.4).
  const accountKey = msg.accountKey ?? s.account_key ?? undefined;
  if (accountKey && msg.reason === 'usage_limited')
    await markAccountOut(
      tx,
      ws.id,
      accountKey,
      {
        usage: 'limited',
        limitedUntil: msg.limitedUntil ?? new Date(ctx.clock.now().getTime() + 3_600_000).toISOString(),
      },
      s.runtime,
    );
  else if (accountKey && msg.reason === 'auth_expired')
    await markAccountOut(tx, ws.id, accountKey, { login: 'expired' }, s.runtime);
  else if (
    accountKey &&
    msg.reason === 'runtime_unavailable' &&
    (msg.detail ?? '').startsWith('account_missing:')
  )
    await markAccountOut(tx, ws.id, accountKey, { login: 'none' }, s.runtime);
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
  if (s.kind === 'ceo') {
    const error = rejectionText(msg.reason, msg.detail);
    ctx.log.warn(
      { shiftId: s.id, reason: msg.reason, detail: msg.detail },
      'the runner rejected the CEO shift',
    );
    await ctx.store.append(await endCeoShift(tx, s, 'rejected', { error, at: ctx.clock.now() }), { tx });
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
    extra.push(
      ...(['run_plan_missing', 'run_failed', 'target_unreachable'].includes(msg.environment.problem)
        ? await runProblemEvents(ctx, tx, card, msg.environment)
        : await environmentNotReadyEvents(ctx, tx, ws, card, msg.environment)),
    );
  }
  let rejection: { reason: string; detail: string; kind?: 'branch'; repoId?: string } | undefined;
  if (msg.reason === 'worktree_failed' && msg.branchProblem && card.repo_id) {
    const branch = await branchProblemEvents(ctx, tx, card, msg.branchProblem);
    extra.push(...branch.events);
    rejection = branch.rejection;
  } else if (
    ['repo_missing', 'worktree_failed', 'runtime_unavailable', 'internal'].includes(msg.reason) &&
    // An account the runner does not have is a race the next pass settles (the account is marked out above): no penalty.
    !(msg.reason === 'runtime_unavailable' && (msg.detail ?? '').startsWith('account_missing:'))
  ) {
    rejection = { reason: msg.reason, detail: msg.detail ?? msg.reason.replaceAll('_', ' ') };
    // Every kind of rejection that will not fix itself holds the card back (1 min, doubling, up to 1 h), not only a
    // missing branch: 958 rejections in 10 hours came from a card that was claimed again every tick.
    extra.push(...rejectionBackoffEvents(ctx, card));
  }
  // Three identical rejections in a row: one desk item for the manager (further ones only raise its counter).
  if (rejection) {
    const same =
      card.last_rejection?.reason === rejection.reason && card.last_rejection?.detail === rejection.detail;
    const streak = Number(card.retry_failures ?? 0) + 1;
    if (same && streak >= REJECTION_DESK_AT) await raiseRejectionStormItem(ctx, tx, card, rejection, streak);
  }
  ctx.log.warn(
    { shiftId: s.id, cardId: card.id, ref: card.ref, reason: msg.reason, detail: msg.detail },
    'the runner rejected the shift',
  );
  const noIdentity =
    msg.reason === 'internal' && (msg.detail ?? '').startsWith(`${NO_COMMIT_IDENTITY_CODE}:`);
  if (noIdentity) extra.push(...(await noCommitIdentityNotice(tx, ws, card)));
  const text = noIdentity
    ? NO_COMMIT_IDENTITY_MESSAGE
    : accountKey && accountKey !== 'main' && msg.reason === 'usage_limited'
      ? `Paused: account \`${accountKey}\` reached its usage limit (resets ${(msg.detail ?? '').trim().slice(0, 100) || (msg.limitedUntil ? `${new Date(msg.limitedUntil).toISOString().slice(11, 16)} UTC` : 'at a later time')}). The card is back in the queue without penalty and goes on by itself once the account works again.`
      : accountKey && accountKey !== 'main' && msg.reason === 'auth_expired'
        ? `Paused: the login on account \`${accountKey}\` does not work, so the shift could not run. The card is back in the queue without penalty and resumes once the account is signed in again.`
        : msg.reason === 'usage_limited'
          ? `Paused: the model usage limit resets at ${(msg.detail ?? '').trim().slice(0, 100) || (msg.limitedUntil ? `${new Date(msg.limitedUntil).toISOString().slice(11, 16)} UTC` : 'a later time')}. The card is back in the queue without penalty and work resumes by itself.`
          : msg.reason === 'auth_expired'
            ? 'The Claude login on this workstation has expired, so the shift could not run. The card is back in the queue without penalty and resumes once the login works again.'
            : `Shift rejected by the runner (${msg.reason}${msg.detail ? `: ${msg.detail}` : ''}); the card is back in the queue.`;
  const released = await releaseClaimEvents(tx, card, 'runner_rejected', text, 'rejected', extra, rejection);
  // The reason is stored on the shift itself (measurement): what the runner said, not only that it said no.
  for (const ev of released)
    if (ev.event.type === 'ShiftEnded' && ev.event.payload.shiftId === s.id)
      ev.event.payload.rejectionReason = `${msg.reason}${msg.detail ? `: ${msg.detail}` : ''}`.slice(0, 600);
  await ctx.store.append(released, { tx });
}

/** How many identical rejections of one card in a row raise a desk item. */
export const REJECTION_DESK_AT = 3;

/**
 * One desk item for a card whose shifts keep being rejected for the same reason (a broken worktree, a missing runtime):
 * the dispatcher backs off by itself, but somebody has to fix the cause. Coalesced by card and reason, so later rejections
 * only raise the counter of the open item.
 */
async function raiseRejectionStormItem(
  ctx: Ctx,
  tx: Tx,
  card: Row,
  rejection: { reason: string; detail: string },
  streak: number,
): Promise<void> {
  await raiseOrCoalesce(
    ctx,
    {
      subjectKey: `rejections:${card.id}:${rejection.reason}:${rejection.detail.slice(0, 120)}`,
      orgId: card.org_id,
      kind: 'alert',
      subkind: 'worktree_rejections',
      title: `${card.ref} keeps being turned away: ${rejection.reason.replaceAll('_', ' ')}`,
      body: `The runner rejected the shifts of ${card.ref} (${card.title}) ${streak} times in a row for the same reason: ${rejection.detail}. The dispatcher holds the card back for longer after each rejection. Fix the cause on the workstation (the repository, its worktree, the runtime), or release the back-off on the card page to retry now.`,
      cardId: card.id,
      projectId: card.project_id,
      data: { reason: rejection.reason, detail: rejection.detail },
      actor: SYSTEM_ACTOR,
      scope: projectScope(card.org_id, card.project_id),
    },
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
  if (s?.status === 'ended') {
    // The server already ended this shift (a lost lease, a timeout) and priced it at zero; the runner now says what it
    // used (a crashed shift still burned tokens): record it once.
    const used =
      msg.usage.inputTokens + msg.usage.outputTokens + msg.usage.cacheReadTokens + msg.usage.cacheWriteTokens;
    const had =
      Number(s.tokens_input) +
      Number(s.tokens_output) +
      Number(s.tokens_cache_read) +
      Number(s.tokens_cache_write);
    if (used > 0 && had === 0)
      await ctx.store.append(
        [
          {
            streamId: streamId.shift(s.id),
            event: { type: 'ShiftUsageRecorded', payload: { shiftId: s.id, usage: msg.usage } },
            actor: runnerActor(ws.id),
            scope: { orgId: s.org_id, projectId: null, audience: 'org' },
          },
        ],
        { tx },
      );
    return;
  }
  if (!s) return;
  // What the shift took to find its way in the code (docs/design/project-graphs.md section 11): numbers beside the billed tokens.
  if (msg.context && msg.context.graphArm !== 'none' && s.kind === 'card' && s.card_id) {
    const c = await one(tx, 'SELECT project_id FROM cards WHERE id=$1', [s.card_id]);
    const projectId = s.project_id ?? c?.project_id;
    if (projectId)
      await ctx.store.append(
        [
          {
            streamId: streamId.shift(s.id),
            event: {
              type: 'ShiftContextMeasured',
              payload: {
                shiftId: s.id,
                cardId: s.card_id,
                projectId,
                orgId: s.org_id,
                billedInputTokens:
                  msg.usage.inputTokens + msg.usage.cacheReadTokens + msg.usage.cacheWriteTokens,
                outputTokens: msg.usage.outputTokens,
                ...msg.context,
              },
            },
            actor: runnerActor(ws.id),
            scope: { orgId: s.org_id, projectId, audience: 'project' } as never,
          },
        ],
        { tx },
      );
  }
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
  if (s.kind === 'ceo') {
    await ctx.store.append(
      await endCeoShift(tx, s, msg.outcome, {
        durationMs: msg.durationMs,
        usage: msg.usage,
        exitCode: msg.exitCode,
        guardViolations: msg.guardViolations,
        at: ctx.clock.now(),
        ...(msg.finalText
          ? { error: `${msg.outcome}: ${msg.finalText.replace(/\s+/g, ' ').slice(0, 400)}` }
          : {}),
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
    const keep = stopped && s.stop_keep_card === true;
    if (keep) ctx.services.dispatcher.prefer(card.id, s.agent_id);
    const text = stopped
      ? keep
        ? 'Shift stopped; the card stays with the same agent, which starts a fresh shift.'
        : 'Shift stopped; the card is back in the queue.'
      : `Shift ended without a report (${msg.outcome}); the card is back in the queue.${msg.finalText ? `\n\n${msg.finalText}` : ''}`;
    // Loop breaker: repeated failures put the card in back-off and collapse the repeated thread message.
    const plan =
      stopped || handoff || asked
        ? { message: text, events: [] as AppendInput[] }
        : await loopBreakerPlan(ctx, tx, card, text, msg.finalText, msg.outcome);
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
  // A shift that reported (the report was accepted) and was then stopped did its work: it ended as reported, not stopped.
  const reportOutcome = handoff?.outcome ?? (asked ? 'question' : undefined);
  const endedAs = msg.outcome === 'stopped' && reportOutcome ? 'reported' : msg.outcome;
  events.push(
    await shiftEndedFor(tx, s, endedAs, {
      reportOutcome,
      durationMs: msg.durationMs,
      usage: msg.usage,
      exitCode: msg.exitCode,
      guardViolations: msg.guardViolations,
    }),
  );
  await ctx.store.append(events, { tx });
}
