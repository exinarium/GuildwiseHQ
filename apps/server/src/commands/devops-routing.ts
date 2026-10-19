import { randomUUID } from 'node:crypto';
import { DEVOPS_QUESTION_PREFIX, type DevopsApprovalData, streamId } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one, type Row } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { agentActor, orgScope, projectScope, SYSTEM_ACTOR, userActor } from './common.ts';
import { nextRoute } from './escalation.ts';
import type { WsRef } from './shifts.ts';

/**
 * What a DevOps report that is not "done" can turn into besides an owner approval on the desk:
 * - a question for the escalation chain (`aom devops-question`, or an approval whose action starts with "Question:"),
 * - an automatic approval of a merge-conflict resolution in the card's own worktree when the project does not require
 *   the owner's approval for merges.
 */

/** True when the project waives the owner's approval for merges (the setting is on and the policy is not "always"). */
export const projectWaivesMergeApproval = (project: Row | undefined | null): boolean =>
  project?.merge_large_without_approval === true && (project.owner_approval_policy ?? '') !== 'always';

const MERGE_WORDS = /\b(merge|merging|merged|conflicts?|conflicted)\b/;
const CARD_BRANCH_WORDS =
  /\b(card'?s?|its own|own)\s+(work ?tree|branch)\b|\bcard[- ](work ?tree|branch)\b|\bwork ?tree of (the )?card\b/;
// Anything that touches shared state or destroys something is never auto-approved.
const RISKY_WORDS =
  /\b(force|force-push|--force|--force-with-lease|push|delete|deleting|remove|removing|rm|reset|--hard|drop|wipe|destroy|discard|prune|sudo|install|uninstall|shared|production|overwrite|truncate|clean -f)\b|-f\b|-d\b/;

/** A conservative test: a merge/conflict resolution inside the card's own worktree, with nothing destructive. */
export function isCardMergeConflictApproval(data: DevopsApprovalData): boolean {
  const text = `${data.action}\n${data.reason}\n${data.commands.join('\n')}`;
  const lower = text.toLowerCase();
  if (!MERGE_WORDS.test(lower) || !CARD_BRANCH_WORDS.test(lower)) return false;
  return !RISKY_WORDS.test(lower.replace(/\bno (force[- ])?push\b|\bwithout push(ing)?\b/g, ''));
}

/** The reason recorded on an automatic approval. */
export const AUTO_APPROVAL_REASON = 'Auto-approved: the project does not require approval for merges';

type Req = Row & { id: string; thread_id: string; org_id: string; card_id: string | null };

/** The project row of the request's card, when it has one. */
export async function requestProject(tx: Tx, req: Req): Promise<Row | undefined> {
  if (!req.card_id) return undefined;
  return one(tx, `SELECT p.* FROM cards c JOIN projects p ON p.id = c.project_id WHERE c.id = $1`, [
    req.card_id,
  ]);
}

/**
 * Approval requested; returns the events when it is a merge-conflict resolution the project does not need approved:
 * the request goes needs_approval and straight to queued again, with no desk item.
 */
export function autoApprovalEvents(req: Req, shiftAgentId: string, data: DevopsApprovalData): AppendInput[] {
  const deskItemId = randomUUID();
  const scope = orgScope(req.org_id);
  return [
    {
      streamId: streamId.thread(req.id),
      event: {
        type: 'DevOpsApprovalNeeded',
        payload: {
          requestId: req.id,
          deskItemId,
          action: data.action,
          reason: data.reason,
          commands: data.commands,
        },
      },
      actor: agentActor(shiftAgentId),
      scope,
    },
    {
      streamId: streamId.thread(req.id),
      event: {
        type: 'DevOpsApprovalResolved',
        payload: {
          requestId: req.id,
          deskItemId,
          resolution: 'approved',
          auto: true,
          note: AUTO_APPROVAL_REASON,
        },
      },
      actor: SYSTEM_ACTOR,
      scope,
    },
  ];
}

/**
 * The question raised for a DevOps "Question:" report: routed through the escalation chain when the request has a card
 * (question shifts need one), else straight to the manager's desk. Returns the events and the new item's id.
 */
export async function devopsQuestionEvents(
  ctx: Ctx,
  tx: Tx,
  req: Req,
  ws: WsRef,
  agent: Row,
  data: DevopsApprovalData,
  project: Row | undefined,
): Promise<{ deskItemId: string; events: AppendInput[] }> {
  const deskItemId = randomUUID();
  const text = data.action.replace(/^\s*question:\s*/i, '').trim() || data.action;
  const route = req.card_id
    ? await nextRoute(ctx, tx, {
        orgId: req.org_id,
        projectId: (project?.id as string | undefined) ?? null,
        cardId: req.card_id,
        askerAgentId: agent.id,
        askerRole: agent.role_key,
        from: 'raise',
        tried: [],
      })
    : ({ routedTo: 'manager', level: 'desk' } as const);
  const scope = project ? projectScope(req.org_id, project.id as string) : orgScope(req.org_id);
  return {
    deskItemId,
    events: [
      {
        streamId: streamId.desk(deskItemId),
        event: {
          type: 'QuestionRaised',
          payload: {
            deskItemId,
            ...(req.card_id ? { cardId: req.card_id } : {}),
            ...(project ? { projectId: project.id as string } : {}),
            askedBy: { kind: 'agent', agentId: agent.id, role: agent.role_key },
            doing: data.reason,
            question: text,
            options: [],
            blocking: false,
            routedTo: route.routedTo,
            ...('routedAgentId' in route && route.routedAgentId
              ? { routedAgentId: route.routedAgentId }
              : {}),
            chainLevel: route.level,
            dedupLedgerIds: [],
            affectedCardIds: [],
            pinned: false,
            data: { devopsRequestId: req.id },
            addresseeUserId: ws.userId,
          },
        },
        actor: agentActor(agent.id),
        scope,
      },
      {
        streamId: streamId.thread(req.id),
        event: {
          type: 'DevOpsApprovalNeeded',
          payload: {
            requestId: req.id,
            deskItemId,
            action: `${DEVOPS_QUESTION_PREFIX} ${text}`,
            reason: data.reason,
            commands: [],
            question: true,
          },
        },
        actor: agentActor(agent.id),
        scope: orgScope(req.org_id),
      },
    ],
  };
}

/**
 * A question of a DevOps request was answered (by anyone in the chain) or dismissed: the request resumes with the
 * answer exactly as it does after an approval (`DevOpsApprovalResolved` -> queued, the brief carries the note).
 */
export async function resumeDevopsAfterQuestion(
  ctx: Ctx,
  deskItemId: string,
  outcome: { answer: string } | { dismissed: true },
  by: { userId?: string; agentId?: string },
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const item = await one(tx, `SELECT data FROM desk_items WHERE id=$1`, [deskItemId]);
    const requestId = item?.data?.devopsRequestId as string | undefined;
    if (!requestId) return;
    const req = await one(tx, `SELECT * FROM devops_requests WHERE id=$1 FOR UPDATE`, [requestId]);
    const ap = req?.approval as { deskItemId?: string; resolution?: string | null } | null;
    if (!req || req.status !== 'needs_approval' || ap?.deskItemId !== deskItemId || ap.resolution) return;
    const answered = 'answer' in outcome;
    const actor = by.userId ? userActor(by.userId) : by.agentId ? agentActor(by.agentId) : SYSTEM_ACTOR;
    await ctx.store.append(
      [
        {
          streamId: streamId.thread(requestId),
          event: {
            type: 'DevOpsApprovalResolved',
            payload: {
              requestId,
              deskItemId,
              resolution: answered ? 'approved' : 'rejected',
              ...(by.userId || by.agentId ? { resolvedBy: (by.userId ?? by.agentId) as string } : {}),
              note: answered ? outcome.answer : 'The question was dismissed without an answer',
            },
          },
          actor,
          scope: orgScope(req.org_id),
        },
        {
          streamId: streamId.thread(req.thread_id),
          event: {
            type: 'ThreadMessagePosted',
            payload: {
              threadId: req.thread_id,
              messageId: randomUUID(),
              authorKind: by.userId ? 'user' : by.agentId ? 'agent' : 'system',
              ...(by.userId ? { authorUserId: by.userId } : {}),
              ...(by.agentId ? { authorAgentId: by.agentId } : {}),
              kind: 'answer',
              body: answered ? `Answer: ${outcome.answer}` : 'The question was dismissed without an answer.',
              data: { deskItemId },
            },
          },
          actor,
          scope: orgScope(req.org_id),
        },
      ],
      { tx },
    );
  });
  ctx.services.dispatcher.trigger();
}

/** Store hook: the answer of a DevOps question resumes its request. */
export function registerDevopsQuestionHook(ctx: Ctx): () => void {
  return ctx.store.subscribe(async (e) => {
    try {
      if (e.event.type === 'QuestionAnswered') {
        const p = e.event.payload;
        await resumeDevopsAfterQuestion(
          ctx,
          p.deskItemId,
          { answer: p.answer },
          { userId: p.answeredBy.userId, agentId: p.answeredBy.agentId },
        );
      } else if (e.event.type === 'DeskItemResolved' && e.event.payload.resolution === 'dismissed') {
        await resumeDevopsAfterQuestion(
          ctx,
          e.event.payload.deskItemId,
          { dismissed: true },
          {
            userId: e.event.payload.by.userId,
          },
        );
      }
    } catch (err) {
      ctx.log.warn({ err }, 'devops question hook failed');
    }
  });
}
