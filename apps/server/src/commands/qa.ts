import { randomUUID } from 'node:crypto';
import {
  type CardQa,
  DESK_SUBKIND,
  getStage,
  isOrgManager,
  isProjectMember,
  type QaAssignRequest,
  type QaPassRequest,
  type QaSendBackRequest,
  type QaSkipRequest,
  resolveOutcome,
  streamId,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleCard } from '../authz/scope.ts';
import { loadWorkflowById } from '../catalogue/loader.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { workflowView } from './cards.ts';
import { cardMessage, projectScope, SYSTEM_ACTOR, userActor } from './common.ts';
import { approveHeldDraftEvents } from './drafts.ts';
import { queueOutboundPost } from './outbox.ts';
import { inQaStage, QA_STAGE, QA_STEPS_STAGE, type QaAssigneeSource } from './qa-flow.ts';

/**
 * Manual QA (docs/design/manual-qa.md): the events that open it when a card leaves Finalize, and the person's actions on it:
 * pass, skip, send back and hand over. Every action runs in one transaction with the card locked.
 */

const QA_OPTIONS = [
  { id: 'pass', label: 'Pass', description: 'It works: accept the card.' },
  { id: 'skip', label: 'Skip the test', description: 'Not tested: let the card go on.' },
  {
    id: 'send_back',
    label: 'Send back',
    description: 'It does not work: send it back to rework with a comment.',
  },
];

interface QaDoc {
  state: string;
  assigneeUserId: string;
  source: QaAssigneeSource;
  openedAt: string;
  steps: string | null;
  stepsBy: string | null;
  decision: { kind: string; by: string; note: string | null; at: string } | null;
  deskItemId: string | null;
  sentBackCount?: number;
  lastSendBack?: { by: string; comment: string; at: string };
}

/** The desk question addressed to the assignee, and the QaOpened event; appended with `CardFinalized`. */
export function qaOpenEvents(
  card: Row,
  assignee: { userId: string; source: QaAssigneeSource },
  toStage: 'qa_steps' | 'manual_qa',
  assigneeName: string,
): AppendInput[] {
  const scope = projectScope(card.org_id, card.project_id);
  const deskItemId = randomUUID();
  return [
    deskQuestion(card, assignee.userId, deskItemId),
    {
      streamId: streamId.card(card.id),
      event: {
        type: 'QaOpened',
        payload: {
          cardId: card.id,
          assigneeUserId: assignee.userId,
          source: assignee.source,
          toStage,
          deskItemId,
        },
      },
      actor: SYSTEM_ACTOR,
      scope,
    },
    cardMessage(
      card,
      { kind: 'system' },
      'system',
      toStage === 'qa_steps'
        ? `${card.ref} is merged and goes to manual QA: ${assigneeName} tests it. The test steps are being written.`
        : `${card.ref} is merged and goes to manual QA: ${assigneeName} tests it. No agent is hired to write test steps, so they come from the card itself.`,
      { qa: 'opened', assigneeUserId: assignee.userId },
    ),
  ];
}

function deskQuestion(card: Row, assigneeUserId: string, deskItemId: string): AppendInput {
  return {
    streamId: streamId.desk(deskItemId),
    event: {
      type: 'QuestionRaised',
      payload: {
        deskItemId,
        cardId: card.id,
        projectId: card.project_id,
        askedBy: { kind: 'system' },
        doing: 'The work is merged. Waiting for you to test it.',
        question: `Test ${card.ref}: ${card.title}`,
        options: QA_OPTIONS,
        recommendation: 'pass',
        blocking: false,
        routedTo: 'manager',
        dedupLedgerIds: [],
        affectedCardIds: [card.id],
        pinned: false,
        subkind: DESK_SUBKIND.manualQa,
        addresseeUserId: assigneeUserId,
        data: { cardId: card.id, cardRef: card.ref },
      },
    },
    actor: SYSTEM_ACTOR,
    scope: projectScope(card.org_id, card.project_id),
  };
}

const nameOf = async (db: Queryable, userId: string): Promise<string> =>
  (await one(db, 'SELECT display_name FROM users WHERE id=$1', [userId]))?.display_name ?? 'someone';

/**
 * The desk item of the card's QA, when it is still open: deciding on the card closes it too. A question normally needs
 * a ledger entry to be answered; a test result is not a decision to remember, so the item is resolved instead (pass =
 * approved, skip = acknowledged, send back = rejected) with the person's note as the answer.
 */
function answerDeskEvent(
  card: Row,
  qa: QaDoc,
  openItem: boolean,
  by: string,
  option: 'pass' | 'skip' | 'send_back',
  text: string,
): AppendInput[] {
  if (!qa.deskItemId || !openItem) return [];
  return [
    {
      streamId: streamId.desk(qa.deskItemId),
      event: {
        type: 'DeskItemResolved',
        payload: {
          deskItemId: qa.deskItemId,
          resolution: option === 'pass' ? 'approved' : option === 'skip' ? 'acknowledged' : 'rejected',
          note: text,
          by: { kind: 'user', userId: by },
        },
      },
      actor: userActor(by),
      scope: projectScope(card.org_id, card.project_id),
    },
  ];
}

async function deskItemOpen(db: Queryable, qa: QaDoc): Promise<boolean> {
  if (!qa.deskItemId) return false;
  const r = await one(db, 'SELECT status FROM desk_items WHERE id=$1', [qa.deskItemId]);
  return r?.status === 'open';
}

/** May this user act on the card's QA? The assignee, project owners and managers, organization Owners and Admins. */
export async function mayActOnQa(
  db: Queryable,
  user: { id: string },
  card: Row,
  projectRole: 'owner' | 'manager' | null | undefined,
): Promise<boolean> {
  const qa = card.qa as QaDoc | null;
  if (!qa) return false;
  if (qa.assigneeUserId === user.id) return true;
  if (isProjectMember(projectRole)) return true;
  return isOrgManager({ orgRole: await orgRoleOf(db, user.id, card.org_id) });
}

async function lockQaCard(
  tx: Tx,
  user: AuthSession['user'],
  idOrRef: string,
): Promise<{ card: Row; qa: QaDoc }> {
  const visible = await loadVisibleCard(tx, user.id, idOrRef);
  const card = (await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [visible.card.id])) as Row;
  const qa = card.qa as QaDoc | null;
  if (!qa || !inQaStage(card) || !['queued', 'claimed', 'waiting'].includes(card.status))
    throw conflict('not_in_qa', `${card.ref} is not waiting for manual QA`);
  if (!(await mayActOnQa(tx, user, card, visible.role)))
    throw forbidden('only the person assigned to test this card, the project owner or managers can do this');
  return { card, qa };
}

/** The outcome of `manual_qa` to the stage it names in the card's workflow (build for a send back). */
async function outcomeTarget(tx: Tx, card: Row, outcomeId: 'pass' | 'skip' | 'send_back'): Promise<string> {
  const wf = await loadWorkflowById(tx, card.workflow_version_id);
  const fallback = outcomeId === 'send_back' ? 'build' : 'done';
  if (!wf || !getStage(wf.definition, QA_STAGE)) return fallback;
  try {
    return resolveOutcome(wf.definition, workflowView(card), QA_STAGE, outcomeId).toStage;
  } catch {
    return fallback;
  }
}

/** Pass or skip: the card is done and the held outgoing comment goes to the desk for approval. */
async function finish(
  ctx: Ctx,
  user: AuthSession['user'],
  idOrRef: string,
  kind: 'passed' | 'skipped',
  text: string | undefined,
): Promise<void> {
  let deliverTo: string | null = null;
  await withAppendTx(ctx.pool, async (tx) => {
    const { card, qa } = await lockQaCard(tx, user, idOrRef);
    const scope = projectScope(card.org_id, card.project_id);
    const who = await nameOf(tx, user.id);
    const open = await deskItemOpen(tx, qa);
    const event: AppendInput['event'] =
      kind === 'passed'
        ? {
            type: 'QaPassed',
            payload: {
              cardId: card.id,
              by: user.id,
              ...(text ? { note: text } : {}),
              ...(qa.deskItemId ? { deskItemId: qa.deskItemId } : {}),
            },
          }
        : {
            type: 'QaSkipped',
            payload: {
              cardId: card.id,
              by: user.id,
              ...(text ? { reason: text } : {}),
              ...(qa.deskItemId ? { deskItemId: qa.deskItemId } : {}),
            },
          };
    const released = await approveHeldDraftEvents(tx, card, user, kind);
    await ctx.store.append(
      [
        { streamId: streamId.card(card.id), event, actor: userActor(user.id), scope },
        ...answerDeskEvent(
          card,
          qa,
          open,
          user.id,
          kind === 'passed' ? 'pass' : 'skip',
          text || (kind === 'passed' ? 'Passed' : 'Skipped (not tested)'),
        ),
        cardMessage(
          card,
          { kind: 'system' },
          'system',
          kind === 'passed'
            ? `Manual QA passed by ${who}${text ? `: ${text}` : '.'} ${card.ref} is done.`
            : `Manual QA skipped by ${who} (not tested)${text ? `: ${text}` : '.'} ${card.ref} is done.`,
          { qa: kind },
        ),
        ...released.events,
      ],
      { tx },
    );
    for (const d of released.drafts) deliverTo = (await queueOutboundPost(tx, d)) ?? deliverTo;
  });
  if (deliverTo) await ctx.services.gateway.deliverPending(deliverTo);
}

export const passQa = (ctx: Ctx, user: AuthSession['user'], idOrRef: string, req: QaPassRequest) =>
  finish(ctx, user, idOrRef, 'passed', req.note?.trim() || undefined);

export const skipQa = (ctx: Ctx, user: AuthSession['user'], idOrRef: string, req: QaSkipRequest) =>
  finish(ctx, user, idOrRef, 'skipped', req.reason?.trim() || undefined);

/**
 * Send the card back to rework: the comment is required and reaches the builder as a review comment. The card goes
 * through build, review, test and finalize again; the outgoing ticket comment stays held.
 */
export async function sendBackQa(
  ctx: Ctx,
  user: AuthSession['user'],
  idOrRef: string,
  req: QaSendBackRequest,
): Promise<void> {
  const comment = req.comment.trim();
  if (!comment) throw badRequest('comment_required', 'say what failed: the builder reads this comment');
  await withAppendTx(ctx.pool, async (tx) => {
    const { card, qa } = await lockQaCard(tx, user, idOrRef);
    const scope = projectScope(card.org_id, card.project_id);
    const toStage = await outcomeTarget(tx, card, 'send_back');
    const who = await nameOf(tx, user.id);
    const open = await deskItemOpen(tx, qa);
    await ctx.store.append(
      [
        {
          streamId: streamId.card(card.id),
          event: {
            type: 'QaSentBack',
            payload: {
              cardId: card.id,
              by: user.id,
              comment,
              toStage,
              ...(qa.deskItemId ? { deskItemId: qa.deskItemId } : {}),
            },
          },
          actor: userActor(user.id),
          scope,
        },
        ...answerDeskEvent(card, qa, open, user.id, 'send_back', comment),
        cardMessage(card, { kind: 'user', userId: user.id }, 'comment', `Manual QA: ${comment}`, {
          qa: 'sent_back',
        }),
        cardMessage(
          card,
          { kind: 'system' },
          'system',
          `${who} sent ${card.ref} back from manual QA. It is in rework again; the outgoing ticket comment stays held until QA passes.`,
          { qa: 'sent_back' },
        ),
      ],
      { tx },
    );
  });
  ctx.services.dispatcher.trigger();
}

/** Hand the QA to another active member of the project: a new desk item replaces the old one. */
export async function assignQa(
  ctx: Ctx,
  user: AuthSession['user'],
  idOrRef: string,
  req: QaAssignRequest,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const { card, qa } = await lockQaCard(tx, user, idOrRef);
    if (req.userId === qa.assigneeUserId)
      throw badRequest('same_assignee', 'the card is already assigned to this person');
    const member = await one(
      tx,
      `SELECT 1 FROM project_members WHERE project_id=$1 AND user_id=$2 AND status='active'`,
      [card.project_id, req.userId],
    );
    if (!member) throw badRequest('not_a_member', 'pick an active member of this project');
    const scope = projectScope(card.org_id, card.project_id);
    const deskItemId = randomUUID();
    const toName = await nameOf(tx, req.userId);
    const byName = await nameOf(tx, user.id);
    const open = await deskItemOpen(tx, qa);
    await ctx.store.append(
      [
        ...(qa.deskItemId && open
          ? [
              {
                streamId: streamId.desk(qa.deskItemId),
                event: {
                  type: 'DeskItemResolved' as const,
                  payload: {
                    deskItemId: qa.deskItemId,
                    resolution: 'dismissed' as const,
                    note: `Handed to ${toName}`,
                    by: { kind: 'user' as const, userId: user.id },
                  },
                },
                actor: userActor(user.id),
                scope,
              },
            ]
          : []),
        deskQuestion(card, req.userId, deskItemId),
        {
          streamId: streamId.card(card.id),
          event: {
            type: 'QaAssigned',
            payload: {
              cardId: card.id,
              assigneeUserId: req.userId,
              previousUserId: qa.assigneeUserId,
              by: user.id,
              deskItemId,
              ...(qa.deskItemId ? { previousDeskItemId: qa.deskItemId } : {}),
            },
          },
          actor: userActor(user.id),
          scope,
        },
        cardMessage(
          card,
          { kind: 'system' },
          'system',
          `${byName} handed the manual QA of ${card.ref} to ${toName}.`,
          { qa: 'assigned', assigneeUserId: req.userId },
        ),
      ],
      { tx },
    );
  });
}

/** The agent's test steps (the outcome note of `qa_steps`): events to append with the stage change. */
export function qaStepsEvents(card: Row, agentId: string, steps: string): AppendInput[] {
  return [
    {
      streamId: streamId.card(card.id),
      event: { type: 'QaStepsPosted', payload: { cardId: card.id, steps: steps.slice(0, 40000), agentId } },
      actor: { kind: 'agent', id: agentId },
      scope: projectScope(card.org_id, card.project_id),
    },
    cardMessage(card, { kind: 'agent', agentId }, 'comment', `## Manual QA steps\n\n${steps}`, {
      qa: 'steps',
    }),
  ];
}

export { QA_STAGE, QA_STEPS_STAGE };

// ------------------------------------------------------------------------------------------- reads

/** The card detail's QA block (null when the card never went to QA). */
export async function cardQaDto(
  db: Queryable,
  card: Row,
  viewer: { id: string },
  projectRole: 'owner' | 'manager' | null | undefined,
): Promise<CardQa | null> {
  const qa = card.qa as QaDoc | null;
  if (!qa) return null;
  // A manager moved the card out of QA before it was decided: there is nothing to show until it is finalized again.
  if (!inQaStage(card) && (qa.state === 'open' || qa.state === 'steps')) return null;
  const ids = [qa.assigneeUserId, qa.decision?.by].filter((x): x is string => !!x);
  const users = new Map(
    (await rows(db, 'SELECT id, display_name, avatar_seed FROM users WHERE id = ANY($1::uuid[])', [ids])).map(
      (u) => [u.id, u],
    ),
  );
  const held = await one(
    db,
    `SELECT kind, external_key, body FROM outbound_drafts WHERE card_id=$1 AND status='held' ORDER BY created_at LIMIT 1`,
    [card.id],
  );
  const open = inQaStage(card) && ['queued', 'claimed', 'waiting'].includes(card.status);
  const members = open
    ? (
        await rows(
          db,
          `SELECT u.id, u.display_name FROM project_members pm JOIN users u ON u.id = pm.user_id
            WHERE pm.project_id=$1 AND pm.status='active' AND u.status='active' ORDER BY u.display_name`,
          [card.project_id],
        )
      ).map((m) => ({ userId: m.id, name: m.display_name }))
    : [];
  const assignee = users.get(qa.assigneeUserId);
  const stepsBy = qa.stepsBy
    ? ((await one(db, 'SELECT name FROM agents WHERE id=$1', [qa.stepsBy]))?.name ?? null)
    : null;
  return {
    state: qa.state as CardQa['state'],
    assignee: {
      userId: qa.assigneeUserId,
      name: assignee?.display_name ?? 'someone',
      avatarSeed: assignee?.avatar_seed ?? null,
    },
    source: qa.source,
    openedAt: iso(qa.openedAt) as string,
    steps: qa.steps,
    stepsBy,
    decision: qa.decision
      ? {
          kind: qa.decision.kind as 'passed' | 'skipped' | 'sent_back',
          byName: users.get(qa.decision.by)?.display_name ?? 'someone',
          note: qa.decision.note,
          at: iso(qa.decision.at) as string,
        }
      : null,
    sentBackCount: qa.sentBackCount ?? 0,
    heldComment: held ? { kind: held.kind, externalKey: held.external_key, body: held.body } : null,
    canAct: open && (await mayActOnQa(db, viewer, card, projectRole)),
    members,
    deskItemId: qa.deskItemId,
  };
}
