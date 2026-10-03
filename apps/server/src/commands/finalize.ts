import { randomUUID } from 'node:crypto';
import {
  type CompletionAction,
  DESK_SUBKIND,
  type FinalizeCardRequest,
  type FinalizeExecutePayload,
  type FinalizeResult,
  FinalizeResultSchema,
  streamId,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { one, type Row } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { conflict } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { loadManageable } from './cards.ts';
import { cardMessage, projectScope, SYSTEM_ACTOR, userActor } from './common.ts';
import { rebaseConflictEvents } from './rebase.ts';
import { spawnCardEvent } from './spawn.ts';

export const needsMergeApproval = (card: Row, action: CompletionAction): boolean =>
  action === 'merge' && card.risk_tier === 'large';

/** `finalize.execute` for the card's home workstation (the runner executes the completion action; no agent). */
async function queueExecute(tx: Tx, card: Row, action: CompletionAction): Promise<string> {
  if (!card.home_workstation_id || !card.repo_id || !card.branch_name)
    throw conflict('no_worktree', 'the card has no worktree on a workstation to finalize from');
  const repo = (await one(tx, 'SELECT * FROM project_repos WHERE id=$1', [card.repo_id])) as Row;
  const project = (await one(tx, 'SELECT * FROM projects WHERE id=$1', [card.project_id])) as Row;
  const payload: FinalizeExecutePayload = {
    cardId: card.id,
    ref: card.ref,
    title: card.title,
    projectKey: project.key,
    action,
    repoId: repo.id,
    remoteUrlNormalized: repo.remote_url_normalized,
    baseBranch: card.base_branch ?? repo.working_branch ?? project.working_branch,
    branchName: card.branch_name,
    worktreePath: card.worktree_path ?? null,
    prTitle: `${card.ref}: ${card.title}`,
    prBody: `${card.title}\n\nCard ${card.ref}, finalized by Agent Org Manager.`,
  };
  await enqueueRunnerCommand(tx, card.home_workstation_id, 'finalize.execute', payload as never);
  return card.home_workstation_id;
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
    const action: CompletionAction | null = req.action ?? card.completion_action;
    if (!action) throw conflict('no_completion_action', 'the card has no completion action');
    const scope = projectScope(card.org_id, card.project_id);
    const events: AppendInput[] = [];
    if (action !== card.completion_action)
      events.push({
        streamId: streamId.card(card.id),
        event: { type: 'CardUpdated', payload: { cardId: card.id, changes: { completionAction: action } } },
        actor: userActor(user.id),
        scope,
      });
    if (needsMergeApproval(card, action)) {
      const deskItemId = randomUUID();
      events.push(
        {
          streamId: streamId.desk(deskItemId),
          event: {
            type: 'DeskItemCreated',
            payload: {
              deskItemId,
              kind: 'approval',
              subkind: DESK_SUBKIND.largeMerge,
              title: `Approve merge of ${card.ref}: ${card.title}`,
              body: `${card.ref} is a large change (two reviewers approved). Approving merges ${card.branch_name} into the working branch (${card.base_branch ?? 'main'}); the runner does it, then a full E2E suite runs on the result.`,
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
            payload: { cardId: card.id, action, deskItemId, requestedBy: user.id },
          },
          actor: userActor(user.id),
          scope,
        },
        cardMessage(
          card,
          { kind: 'system' },
          'system',
          `Finalize (merge) requested by ${user.displayName}; waiting for the manager's approval on the desk.`,
        ),
      );
      await ctx.store.append(events, { tx });
      return { cardId: card.id, ref: card.ref, state: 'awaiting_approval', action, deskItemId };
    }
    events.push(
      {
        streamId: streamId.card(card.id),
        event: { type: 'FinalizeRequested', payload: { cardId: card.id, action, requestedBy: user.id } },
        actor: userActor(user.id),
        scope,
      },
      cardMessage(
        card,
        { kind: 'system' },
        'system',
        `Finalize (${action}) requested by ${user.displayName}.`,
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
  const action = (card.finalize_action ?? card.completion_action) as CompletionAction;
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
    const action = (card.finalize_action ?? card.completion_action) as CompletionAction;
    const scope = projectScope(card.org_id, card.project_id);
    const events: AppendInput[] = [];

    if (ok && result?.ok) {
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
              toStage: 'done',
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
      // Full E2E suite on the resulting branch, for a tester (never blocks anything).
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
        },
      });
      events.push(suite.event, {
        streamId: streamId.card(card.id),
        event: { type: 'FullSuiteStarted', payload: { cardId: card.id, branch, suiteCardId: suite.cardId } },
        actor: SYSTEM_ACTOR,
        scope,
      });
      if (card.worktree_path)
        await enqueueRunnerCommand(tx, workstationId, 'worktree.remove', {
          repoId: card.repo_id ?? undefined,
          path: card.worktree_path,
          branchName: card.branch_name ?? undefined,
          deleteBranch: action === 'merge' && !!result.mergeCommit,
        });
    } else if (ok && result?.conflict) {
      events.push(
        ...rebaseConflictEvents(
          card,
          workstationId,
          'finalize',
          card.base_branch ?? '',
          result.conflictedFiles ?? [],
        ),
      );
    } else {
      const message = result?.error ?? error ?? 'the completion action failed';
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
