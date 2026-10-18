import { randomUUID } from 'node:crypto';
import {
  type CompletionAction,
  DEFAULT_PR_BRANCH_PREFIX,
  DESK_SUBKIND,
  type FinalizeCardRequest,
  type FinalizeExecutePayload,
  type FinalizeResult,
  FinalizeResultSchema,
  getStage,
  isLeanTeamWorkflow,
  isSafeGitRef,
  type StoredCompletionAction,
  streamId,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadWorkflowById } from '../catalogue/loader.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { conflict } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { loadManageable } from './cards.ts';
import { loadCommitAs } from './commit-as.ts';
import { cardMessage, projectScope, SYSTEM_ACTOR, userActor } from './common.ts';
import { effectiveCompletionAction } from './completion.ts';
import { cardConflictAttemptEvents } from './conflict-attempts.ts';
import { qaOpenEvents } from './qa.ts';
import { finalizeNext, qaAssignee } from './qa-flow.ts';
import { rebaseConflictEvents } from './rebase.ts';
import { isHighRisk, riskOf } from './review-risk.ts';
import { spawnCardEvent } from './spawn.ts';

/** A large-tier merge, the kind that waits for the manager unless the owner's project setting lets it through. */
export const isLargeMerge = (card: Row, action: StoredCompletionAction): boolean =>
  action === 'merge' && card.risk_tier === 'large';

/** A merge of a change the reviewer rated high risk (backlog #70): always waits for the manager. */
export const isHighRiskMerge = (card: Row, action: StoredCompletionAction): boolean =>
  action === 'merge' && isHighRisk(card);

export type MergeGate = 'none' | 'approval' | 'waived';

/**
 * Does finalizing `card` with `action` wait for the manager's desk approval? `waived`: it is a large merge but the
 * project's "merge large changes without my approval" setting (owner only, default off) skips the approval.
 */
export async function mergeGate(
  db: Queryable,
  card: Row,
  action: StoredCompletionAction,
): Promise<MergeGate> {
  // lean team: the owner approved (or the policy waived it) at the approval step after the review, bound to the reviewed
  // commit; the merge does not ask again (the lapse check below guards the commit).
  if (await hasOwnerApprovalStep(db, card)) return 'none';
  if (isHighRiskMerge(card, action)) return 'approval'; // the project's waiver does not apply to a high risk
  if (!isLargeMerge(card, action)) return 'none';
  const p = await one(db, 'SELECT merge_large_without_approval AS waived FROM projects WHERE id=$1', [
    card.project_id,
  ]);
  return p?.waived ? 'waived' : 'approval';
}

/** Does the card's workflow have the owner approval step after the review (lean team)? */
export async function hasOwnerApprovalStep(db: Queryable, card: Row): Promise<boolean> {
  return !!(await one(
    db,
    `SELECT 1 FROM workflow_stages WHERE workflow_version_id=$1 AND stage_id='owner_approval'`,
    [card.workflow_version_id],
  ));
}

/**
 * The owner's approval is bound to the reviewed commit. When the branch is at another commit than the one the owner
 * approved, the approval no longer counts: nothing is merged and the card returns to the approval step.
 */
export async function ownerApprovalLapse(
  db: Queryable,
  card: Row,
): Promise<{ approvedSha: string; actualSha: string } | null> {
  if (card.owner_approval_required !== true || !card.head_sha || !card.owner_approved_sha) return null;
  if (card.owner_approved_sha === card.head_sha) return null;
  if (!(await hasOwnerApprovalStep(db, card))) return null;
  return { approvedSha: card.owner_approved_sha as string, actualSha: card.head_sha as string };
}

/** The events that send a card whose approval lapsed back to the approval step (the caller appends them). */
export function ownerApprovalLapsedEvents(
  card: Row,
  lapse: { approvedSha: string; actualSha: string },
): AppendInput[] {
  return [
    {
      streamId: streamId.card(card.id),
      event: {
        type: 'OwnerApprovalLapsed',
        payload: {
          cardId: card.id,
          approvedSha: lapse.approvedSha,
          actualSha: lapse.actualSha,
          fromStage: card.stage,
        },
      },
      actor: SYSTEM_ACTOR,
      scope: projectScope(card.org_id, card.project_id),
    },
    cardMessage(
      card,
      { kind: 'system' },
      'system',
      `The owner approved ${lapse.approvedSha.slice(0, 10)} but ${card.ref} is at ${lapse.actualSha.slice(0, 10)} now: the approval no longer counts and nothing was merged. The card is back at the owner approval for the new commit.`,
    ),
  ];
}

/** The ticket in a pull request branch name: the tracker key the card came from (Jira), else the card ref. */
export function prBranchTicket(externalKey: string | null | undefined, ref: string): string {
  const key = (externalKey ?? '').trim();
  return /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(key) ? key : ref;
}

/** `finalize.execute` for the card's home workstation (the runner executes the completion action; no agent). */
export async function queueExecute(tx: Tx, card: Row, action: CompletionAction): Promise<string> {
  if (!card.home_workstation_id || !card.repo_id || !card.branch_name)
    throw conflict('no_worktree', 'the card has no worktree on a workstation to finalize from');
  const repo = (await one(tx, 'SELECT * FROM project_repos WHERE id=$1', [card.repo_id])) as Row;
  const project = (await one(tx, 'SELECT * FROM projects WHERE id=$1', [card.project_id])) as Row;
  // The branch a pull request goes out under: the one used before (rework updates the same pull request), else
  // <prefix>/<ticket>. The local card branch keeps its name.
  const earlier = (card.finalize_result ?? {}) as { pushedBranch?: string };
  const intake = (await one(
    tx,
    `SELECT i.external_key FROM intake_cards ic JOIN intakes i ON i.id = ic.intake_id
      WHERE ic.card_id=$1 AND i.external_key IS NOT NULL ORDER BY ic.created_at LIMIT 1`,
    [card.id],
  )) as { external_key: string } | null;
  const ticket = prBranchTicket(intake?.external_key, card.ref);
  const payload: FinalizeExecutePayload = {
    cardId: card.id,
    ref: card.ref,
    title: card.title,
    projectKey: project.key,
    projectId: project.id,
    action,
    repoId: repo.id,
    remoteUrlNormalized: repo.remote_url_normalized,
    baseBranch: card.base_branch ?? repo.working_branch ?? project.working_branch,
    branchName: card.branch_name,
    prBranchPrefix: project.pr_branch_prefix || DEFAULT_PR_BRANCH_PREFIX,
    ticket,
    ...(earlier.pushedBranch && isSafeGitRef(earlier.pushedBranch)
      ? { remoteBranch: earlier.pushedBranch }
      : {}),
    worktreePath: card.worktree_path ?? null,
    // What clients read (backlog #65): the ticket key when the card came from a ticket, a plain title, no card ref.
    prTitle: ticket !== card.ref ? `${ticket}: ${card.title}` : card.title,
    prBody: card.title,
    ...(repo.forge_kind ? { forge: repo.forge_kind } : {}),
    commitAs: await loadCommitAs(tx, project.id),
    // lean team: the runner lands only the commit that was reviewed (and approved).
    ...(card.head_sha && card.build_evidence ? { expectedSha: card.head_sha as string } : {}),
  };
  await enqueueRunnerCommand(tx, card.home_workstation_id, 'finalize.execute', payload as never);
  return card.home_workstation_id;
}

/**
 * A large merge waits for the manager: the desk approval, `FinalizeApprovalRequested` and a note on the card thread
 * (used by the manager's Finalize button and by the BA's `aom finalize`).
 */
export function mergeApprovalEvents(
  card: Row,
  action: CompletionAction,
  who: { requestedBy: string; actor: AppendInput['actor']; by: string },
): { deskItemId: string; events: AppendInput[] } {
  const scope = projectScope(card.org_id, card.project_id);
  const deskItemId = randomUUID();
  return {
    deskItemId,
    events: [
      {
        streamId: streamId.desk(deskItemId),
        event: {
          type: 'DeskItemCreated',
          payload: {
            deskItemId,
            kind: 'approval',
            subkind: DESK_SUBKIND.largeMerge,
            title: `Approve merge of ${card.ref}: ${card.title}`,
            body: `${isHighRisk(card) ? `${card.ref} was rated HIGH risk by the reviewer (${riskOf(card)?.analysis.slice(0, 600) ?? ''}). ` : ''}${card.ref} is a ${card.risk_tier === 'large' ? 'large change (two reviewers approved)' : 'change'}. Approving merges ${card.branch_name} into the working branch (${card.base_branch ?? 'main'}); the runner does it, then a full E2E suite runs on the result.`,
            options: [],
            blocking: false,
            pinned: true,
            cardId: card.id,
            projectId: card.project_id,
            affectedCardIds: [card.id],
            askedBy: { kind: 'system' },
          },
        },
        actor: SYSTEM_ACTOR,
        scope,
      },
      {
        streamId: streamId.card(card.id),
        event: {
          type: 'FinalizeApprovalRequested',
          payload: { cardId: card.id, action, deskItemId, requestedBy: who.requestedBy },
        },
        actor: who.actor,
        scope,
      },
      cardMessage(
        card,
        { kind: 'system' },
        'system',
        `Finalize (merge) requested by ${who.by}; waiting for the manager's approval on the desk.`,
      ),
    ],
  };
}

export interface FinalizeOutcome {
  cardId: string;
  ref: string;
  state: 'awaiting_approval' | 'running';
  action: CompletionAction;
  deskItemId: string | null;
}

/**
 * Manager triggers finalize (docs/ARCHITECTURE.md section 24.22: until the BA exists in M7 the manager does it by
 * hand). Small cards go straight to the runner; a large-tier merge waits for a desk approval.
 */
export async function requestFinalize(
  ctx: Ctx,
  user: AuthSession['user'],
  idOrRef: string,
  req: FinalizeCardRequest,
): Promise<FinalizeOutcome> {
  let workstationId: string | null = null;
  const out = await withAppendTx(ctx.pool, async (tx): Promise<FinalizeOutcome> => {
    const card = await loadManageable(tx, user, idOrRef);
    if (card.stage !== 'finalize' || card.status !== 'queued' || card.claim_id)
      throw conflict('not_finalizable', 'only a card waiting in Finalize can be finalized');
    const inherited = await effectiveCompletionAction(tx, card);
    const action: CompletionAction | null = req.action ?? inherited;
    if (!action) throw conflict('no_completion_action', 'the card has no completion action');
    const lapse = await ownerApprovalLapse(tx, card);
    if (lapse) {
      await ctx.store.append(ownerApprovalLapsedEvents(card, lapse), { tx });
      return { cardId: card.id, ref: card.ref, state: 'awaiting_approval', action, deskItemId: null };
    }
    const scope = projectScope(card.org_id, card.project_id);
    const events: AppendInput[] = [];
    // Choosing what the card would get anyway stores nothing: only a different landing is a card-level override.
    if (action !== inherited)
      events.push({
        streamId: streamId.card(card.id),
        event: { type: 'CardUpdated', payload: { cardId: card.id, changes: { completionAction: action } } },
        actor: userActor(user.id),
        scope,
      });
    const gate = await mergeGate(tx, card, action);
    if (gate === 'approval') {
      const approval = mergeApprovalEvents(card, action, {
        requestedBy: user.id,
        actor: userActor(user.id),
        by: user.displayName,
      });
      events.push(...approval.events);
      const deskItemId = approval.deskItemId;
      await ctx.store.append(events, { tx });
      return { cardId: card.id, ref: card.ref, state: 'awaiting_approval', action, deskItemId };
    }
    events.push(
      {
        streamId: streamId.card(card.id),
        event: {
          type: 'FinalizeRequested',
          payload: {
            cardId: card.id,
            action,
            requestedBy: user.id,
            ...(gate === 'waived' ? { withoutApproval: true } : {}),
          },
        },
        actor: userActor(user.id),
        scope,
      },
      cardMessage(
        card,
        { kind: 'system' },
        'system',
        `Finalize (${action}) requested by ${user.displayName}${gate === 'waived' ? ': merged without manager approval (project setting)' : ''}.`,
      ),
    );
    workstationId = await queueExecute(tx, { ...card, completion_action: action }, action);
    await ctx.store.append(events, { tx });
    return { cardId: card.id, ref: card.ref, state: 'running', action, deskItemId: null };
  });
  if (workstationId) await ctx.services.gateway.deliverPending(workstationId);
  return out;
}

/** Desk resolution of a large-merge approval (called inside the desk resolve transaction). */
export async function resolveLargeMergeIn(
  ctx: Ctx,
  tx: Tx,
  user: { id: string; displayName?: string },
  item: Row,
  resolution: 'approved' | 'rejected' | 'acknowledged' | 'dismissed',
  note?: string,
): Promise<string | null> {
  const card = await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [item.card_id]);
  if (!card || card.status !== 'waiting' || card.finalize_state !== 'awaiting_approval') return null;
  const action = (card.finalize_action ?? (await effectiveCompletionAction(tx, card))) as CompletionAction;
  const scope = projectScope(card.org_id, card.project_id);
  if (resolution === 'approved') {
    const ws = await queueExecute(tx, card, action);
    await ctx.store.append(
      [
        {
          streamId: streamId.card(card.id),
          event: { type: 'FinalizeRequested', payload: { cardId: card.id, action, requestedBy: user.id } },
          actor: userActor(user.id),
          scope,
        },
        cardMessage(card, { kind: 'system' }, 'system', 'Merge approved on the desk; the runner is merging.'),
      ],
      { tx },
    );
    return ws;
  }
  await ctx.store.append(
    [
      {
        streamId: streamId.card(card.id),
        event: {
          type: 'FinalizeFailed',
          payload: {
            cardId: card.id,
            action,
            error: `Merge not approved${note ? `: ${note}` : ''}`,
            conflictedFiles: [],
          },
        },
        actor: userActor(user.id),
        scope,
      },
    ],
    { tx },
  );
  return null;
}

/**
 * `command.result` of `finalize.execute`: CardFinalized (+ worktree removal and the full-suite card), a rebase
 * conflict back to Rework, or a failure with a desk escalation. Idempotent: only a card still finalizing is touched.
 */
export async function applyFinalizeResult(
  ctx: Ctx,
  workstationId: string,
  cardId: string,
  ok: boolean,
  raw: unknown,
  error?: string,
): Promise<void> {
  const parsed = FinalizeResultSchema.safeParse(raw);
  const result: FinalizeResult | null = parsed.success ? parsed.data : null;
  await withAppendTx(ctx.pool, async (tx) => {
    const card = await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [cardId]);
    if (!card || card.status !== 'waiting' || card.finalize_state !== 'running') return;
    const requested = (card.finalize_action ??
      (await effectiveCompletionAction(tx, card))) as CompletionAction;
    // A protected branch turns a merge into a pull request: record what actually happened.
    const action: CompletionAction =
      ok && result?.ok && result.protectedBranch ? (result.action as CompletionAction) : requested;
    const scope = projectScope(card.org_id, card.project_id);
    const events: AppendInput[] = [];

    if (ok && result?.ok) {
      if (result.protectedBranch) {
        const project = await one(tx, 'SELECT default_completion FROM projects WHERE id=$1', [
          card.project_id,
        ]);
        if (project?.default_completion !== 'pr')
          events.push({
            streamId: streamId.project(card.project_id),
            event: {
              type: 'ProjectUpdated',
              payload: { projectId: card.project_id, changes: { defaultCompletion: 'pr' } },
            },
            actor: SYSTEM_ACTOR,
            scope,
          });
        events.push(
          cardMessage(
            card,
            { kind: 'system' },
            'system',
            'The working branch is protected, so this change is waiting as a pull request for you to merge. New work in this project will arrive the same way.',
          ),
        );
      }
      // With manual QA the card goes to the person who started it instead of straight to done (docs/design/manual-qa.md).
      const next = await finalizeNext(tx, card);
      const assignee = next.toStage === 'done' ? null : await qaAssignee(tx, card);
      const toStage = assignee ? next.toStage : 'done';
      events.push(
        {
          streamId: streamId.card(card.id),
          event: {
            type: 'CardFinalized',
            payload: {
              cardId: card.id,
              action,
              resultRef: {
                mergeCommit: result.mergeCommit,
                prUrl: result.prUrl,
                pushedBranch: result.pushedBranch,
              },
              toStage,
              ...(toStage !== 'done' && next.workflowVersionId
                ? { workflowVersionId: next.workflowVersionId }
                : {}),
            },
          },
          actor: SYSTEM_ACTOR,
          scope,
        },
        cardMessage(
          card,
          { kind: 'system' },
          'system',
          `Finalized (${action})${result.mergeCommit ? ` at ${result.mergeCommit.slice(0, 10)}` : ''}${result.prUrl ? `: ${result.prUrl}` : ''}${result.pushedBranch ? ` (branch ${result.pushedBranch} pushed)` : ''}.`,
          { resultRef: result },
        ),
      );
      if (assignee && toStage !== 'done')
        events.push(
          ...qaOpenEvents(
            card,
            assignee,
            toStage,
            (await one(tx, 'SELECT display_name FROM users WHERE id=$1', [assignee.userId]))?.display_name ??
              'the person who started it',
          ),
        );
      if (result.notice) {
        const deskItemId = randomUUID();
        events.push({
          streamId: streamId.desk(deskItemId),
          event: {
            type: 'DeskItemCreated',
            payload: {
              deskItemId,
              kind: 'alert',
              subkind: DESK_SUBKIND.prNotice,
              title: `${card.ref}: ${result.notice}`,
              body: `The branch ${result.pushedBranch ?? card.branch_name} was pushed. Open the pull request by hand.`,
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
          scope,
        });
      }
      // Full E2E suite on the resulting branch, for a tester (never blocks anything). The project can switch it off.
      const suiteOn = (
        await one(tx, 'SELECT full_suite_after_finalize AS on FROM projects WHERE id=$1', [card.project_id])
      )?.on;
      // Lean team: the full suite is a manual trigger only; the flag is ignored for a card on that workflow.
      const cardWorkflow = await loadWorkflowById(tx, card.workflow_version_id);
      if (suiteOn !== false && !(cardWorkflow && isLeanTeamWorkflow(cardWorkflow.definition))) {
        const branch =
          action === 'merge' ? (card.base_branch ?? 'main') : (result.pushedBranch ?? card.branch_name);
        const suite = await spawnCardEvent(tx, {
          from: card,
          title: `Full E2E suite after ${card.ref}: ${card.title}`,
          cardType: 'regression',
          origin: 'full_suite',
          stage: 'test',
          status: 'queued',
          scheduled: true,
          parentCardId: card.id,
          fields: {
            context: `Run the full E2E suite on ${branch} after ${card.ref} was finalized (${action}).`,
            platform: 'web',
            suiteBranch: branch,
            // Mock runtime only: the parent's `mock.suite` script drives the suite card's tester shift.
            ...(card.fields?.mock?.suite ? { mock: { test: card.fields.mock.suite } } : {}),
          },
        });
        events.push(suite.event, {
          streamId: streamId.card(card.id),
          event: {
            type: 'FullSuiteStarted',
            payload: { cardId: card.id, branch, suiteCardId: suite.cardId },
          },
          actor: SYSTEM_ACTOR,
          scope,
        });
      }
      if (card.worktree_path)
        await enqueueRunnerCommand(tx, workstationId, 'worktree.remove', {
          repoId: card.repo_id ?? undefined,
          path: card.worktree_path,
          branchName: card.branch_name ?? undefined,
          deleteBranch: action === 'merge' && !!result.mergeCommit,
        });
    } else if (ok && result?.headMoved) {
      // lean team: the branch is not at the commit that was reviewed: nothing was landed.
      const actualSha = result.headSha ?? (card.head_sha as string);
      if (card.owner_approval_required === true)
        events.push(
          ...ownerApprovalLapsedEvents(card, {
            approvedSha: (card.owner_approved_sha ?? card.head_sha) as string,
            actualSha,
          }),
        );
      else
        events.push(
          {
            streamId: streamId.card(card.id),
            event: {
              type: 'EvidenceLapsed',
              payload: {
                cardId: card.id,
                stage: card.stage,
                expectedSha: card.head_sha as string,
                actualSha,
              },
            },
            actor: SYSTEM_ACTOR,
            scope,
          },
          cardMessage(
            card,
            { kind: 'system' },
            'system',
            `The card branch is at ${actualSha.slice(0, 10)} but ${String(card.head_sha).slice(0, 10)} was reviewed: nothing was merged and the card goes back to Build.`,
          ),
        );
    } else if (ok && result?.conflict) {
      const attempt = await cardConflictAttemptEvents(
        ctx,
        tx,
        card,
        workstationId,
        'finalize',
        card.base_branch ?? '',
        result.conflictedFiles ?? [],
      );
      // lean team: a card that was reviewed and approved is not sent back to Build for a merge conflict. DevOps resolves it in
      // a scratch worktree while the card waits in Finalize; the resolution then gets a merge review, which keeps the earlier
      // approvals when it only merged (dispatcher/bottleneck.ts `unparkPass`).
      const held =
        attempt.some((a) => a.event.type === 'ConflictAttemptStarted') &&
        !!getStage(
          (await loadWorkflowById(tx, card.workflow_version_id))?.definition ?? { stages: [] },
          'merge_review',
        );
      if (held)
        events.push(
          {
            streamId: streamId.card(card.id),
            event: { type: 'FinalizeConflictHeld', payload: { cardId: card.id } },
            actor: SYSTEM_ACTOR,
            scope,
          },
          ...attempt,
        );
      else
        events.push(
          ...rebaseConflictEvents(
            card,
            workstationId,
            'finalize',
            card.base_branch ?? '',
            result.conflictedFiles ?? [],
          ),
          ...attempt,
        );
    } else {
      const message = result?.error ?? error ?? 'the completion action failed';
      ctx.log.warn({ cardId: card.id, ref: card.ref, action, error: message }, 'finalize failed');
      const deskItemId = randomUUID();
      events.push(
        {
          streamId: streamId.card(card.id),
          event: {
            type: 'FinalizeFailed',
            payload: { cardId: card.id, action, error: message, conflictedFiles: [] },
          },
          actor: SYSTEM_ACTOR,
          scope,
        },
        {
          streamId: streamId.desk(deskItemId),
          event: {
            type: 'DeskItemCreated',
            payload: {
              deskItemId,
              kind: 'escalation',
              subkind: DESK_SUBKIND.finalizeFailed,
              title: `Finalize of ${card.ref} failed (${action})`,
              body: message,
              options: [],
              blocking: false,
              pinned: true,
              cardId: card.id,
              projectId: card.project_id,
              affectedCardIds: [],
              askedBy: { kind: 'system' },
            },
          },
          actor: SYSTEM_ACTOR,
          scope,
        },
        cardMessage(card, { kind: 'system' }, 'system', `Finalize (${action}) failed: ${message}`),
      );
    }
    await ctx.store.append(events, { tx });
  });
  ctx.services.dispatcher.trigger();
  await ctx.services.gateway.deliverPending(workstationId);
}
