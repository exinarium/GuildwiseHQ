import { randomUUID } from 'node:crypto';
import { CEO_DECISION_SUBKIND, type DeskActor, isOrgManager, streamId } from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import {
  agentActor,
  cardMessage,
  orgScope,
  projectScope,
  SYSTEM_ACTOR,
  userActor,
} from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { DESK_VISIBLE, IS_CEO_DECISION_SQL, UNREVIEWED_CEO_DECISION_SQL } from '../queries/desk.ts';
import { carrierProject } from './carrier.ts';
import { addMemoryIn } from './memory.ts';
import { loadCeo } from './state.ts';

/**
 * CEO decisions on the owner's desk. Every decision the CEO takes on its own that the owner would otherwise have been
 * asked about (a question it answered, an owner-reserved matter the owner delegated) is put on the desk as an
 * informational item: not blocking, no push, not counted as waiting on the owner. The owner acknowledges it (positive
 * feedback for the CEO) or corrects it. A correction teaches the CEO twice: at once, an owner-confirmed memory with the
 * owner's words; then a short CEO-BA review (a BA task) ends in a lesson recorded in the CEO's memory.
 */

/** The BA task name the review runs under (the report is intercepted instead of becoming a desk notice). */
export const CEO_REVIEW_TASK_NAME = 'CEO decision review';
/** The BA task name of its final turn (it creates the fix cards). */
export const CEO_REVIEW_FINAL_TASK_NAME = 'CEO decision review (final)';

/** Action classes whose decisions the owner reviews (the ones that would otherwise be a question or an approval). */
export const REVIEWED_CLASSES = new Set([
  'desk.answer_question',
  'devops.approve',
  'card.cancel',
  'agent.retire',
  'standing_order.activate',
  'standing_order.retire',
]);

export const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export interface DecisionInput {
  orgId: string;
  projectId?: string | null | undefined;
  cardId?: string | null | undefined;
  ceoAgentId: string;
  ceoName: string;
  cls: string;
  source: 'act' | 'chain';
  actionId?: string | undefined;
  /** What was asked. */
  question: string;
  questionItemId?: string | undefined;
  decision: string;
  reason: string;
  confidence?: number | undefined;
}

/**
 * Either the question or the decision on the desk, never both: a decision about a desk item the CEO answered is
 * recorded ON that (now resolved) item, which then shows as decided by the CEO. Only a decision with no item of its own
 * to resolve (a cancellation, a firing, a delegated reserved matter) becomes one informational `ceo_decision` item.
 */
export function ceoDecisionItemEvents(d: DecisionInput): AppendInput[] {
  if (d.questionItemId)
    return [
      {
        streamId: streamId.desk(d.questionItemId),
        event: {
          type: 'CeoDecisionRecorded',
          payload: {
            orgId: d.orgId,
            deskItemId: d.questionItemId,
            ceoAgentId: d.ceoAgentId,
            ceoName: d.ceoName,
            class: d.cls,
            source: d.source,
            actionId: d.actionId ?? null,
            question: clip(d.question, 600),
            decision: clip(d.decision, 2000),
            reason: clip(d.reason, 2000),
            confidence: d.confidence ?? null,
          },
        },
        actor: agentActor(d.ceoAgentId),
        scope: d.projectId ? projectScope(d.orgId, d.projectId) : orgScope(d.orgId),
      },
    ];
  const deskItemId = randomUUID();
  const askedBy: DeskActor = { kind: 'agent', agentId: d.ceoAgentId, role: 'ceo' };
  return [
    {
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId,
          kind: 'alert',
          subkind: CEO_DECISION_SUBKIND,
          title: `CEO decision: ${clip(d.question, 200)}`,
          body: `${clip(d.decision, 400)}\n\nReason: ${clip(d.reason, 600)}`,
          options: [],
          blocking: false,
          pinned: false,
          affectedCardIds: [],
          askedBy,
          ...(d.cardId ? { cardId: d.cardId } : {}),
          ...(d.projectId ? { projectId: d.projectId } : {}),
          data: {
            ceoDecision: {
              question: clip(d.question, 600),
              decision: clip(d.decision, 2000),
              reason: clip(d.reason, 2000),
              confidence: d.confidence ?? null,
              ceoName: d.ceoName,
              ceoAgentId: d.ceoAgentId,
              class: d.cls,
              source: d.source,
              actionId: d.actionId ?? null,
              questionItemId: d.questionItemId ?? null,
            },
          },
        },
      },
      actor: agentActor(d.ceoAgentId),
      scope: d.projectId ? projectScope(d.orgId, d.projectId) : orgScope(d.orgId),
    },
  ];
}

// ----------------------------------------------------------------------------------------------- review

type DecisionData = {
  question: string;
  decision: string;
  reason: string;
  ceoName: string | null;
  ceoAgentId: string | null;
  class: string | null;
  actionId: string | null;
  questionItemId: string | null;
};

export const decisionOf = (item: Row): DecisionData | undefined =>
  (item.data as { ceoDecision?: DecisionData } | null)?.ceoDecision;

const itemScope = (item: Row) =>
  item.project_id ? projectScope(item.org_id, item.project_id) : orgScope(item.org_id);

/** Locks a visible, open CEO decision of the user's reach; only an Owner or Admin of its organization may review it. */
async function lockDecision(tx: Tx, user: AuthSession['user'], id: string): Promise<Row> {
  const item = await one(
    tx,
    `SELECT d.* FROM desk_items d WHERE d.id=$2 AND ${DESK_VISIBLE} AND ${IS_CEO_DECISION_SQL} FOR UPDATE OF d`,
    [user.id, id],
  );
  if (!item) throw notFound('desk item not found');
  if (!isOrgManager({ orgRole: await orgRoleOf(tx, user.id, item.org_id) }))
    throw forbidden('only an Owner or Admin can review the CEO decisions');
  if (item.subkind === CEO_DECISION_SUBKIND) {
    if (item.status !== 'open') throw conflict('already_resolved', `this item is already ${item.status}`);
  } else if (item.data?.acknowledgedAt || item.data?.correction)
    throw conflict('already_resolved', 'this decision was already reviewed');
  return item;
}

const citedMemoryIds = (evidence: unknown): string[] =>
  (Array.isArray(evidence) ? evidence : [])
    .map(String)
    .filter((e) => e.startsWith('memory:'))
    .map((e) => e.slice(7));

/** The memory ids the decision's action cited as evidence. */
export async function citedBy(db: Queryable, orgId: string, actionId: string | null): Promise<string[]> {
  if (!actionId) return [];
  const a = await one(db, 'SELECT evidence FROM ceo_actions WHERE id=$1 AND org_id=$2', [actionId, orgId]);
  return citedMemoryIds(a?.evidence);
}

/**
 * Positive feedback for acknowledged decisions: every memory the decisions cited gains a little confidence (the same
 * +0.05 an accepted recommendation gives), summed per memory so a batch is one adjustment each.
 */
async function acknowledgeLearning(db: Queryable, orgId: string, items: Row[]): Promise<AppendInput[]> {
  const gain = new Map<string, number>();
  for (const it of items)
    for (const id of await citedBy(db, orgId, decisionOf(it)?.actionId ?? null))
      gain.set(id, (gain.get(id) ?? 0) + 0.05);
  const events: AppendInput[] = [];
  for (const [memoryId, delta] of gain) {
    const m = await one(
      db,
      `SELECT confidence FROM ceo_memories WHERE id=$1 AND org_id=$2 AND status IN ('active','candidate')`,
      [memoryId, orgId],
    );
    if (!m) continue;
    events.push({
      streamId: streamId.ceo(orgId),
      event: {
        type: 'CeoMemoryAdjusted',
        payload: {
          memoryId,
          orgId,
          confidence: Math.max(0, Math.min(1, Number(m.confidence) + delta)),
          reason: 'decision acknowledged by the owner',
        },
      },
      actor: SYSTEM_ACTOR,
      scope: orgScope(orgId),
    });
  }
  return events;
}

/**
 * Closes a legacy `ceo_decision` item. A decision recorded on a question the CEO resolved has nothing to close: the
 * item is resolved already, and the review event alone marks it reviewed.
 */
const resolvedEvents = (
  item: Row,
  user: AuthSession['user'],
  resolution: 'acknowledged' | 'rejected',
  note?: string,
): AppendInput[] =>
  item.subkind === CEO_DECISION_SUBKIND ? [resolvedEvent(item, user, resolution, note)] : [];

const resolvedEvent = (
  item: Row,
  user: AuthSession['user'],
  resolution: 'acknowledged' | 'rejected',
  note?: string,
): AppendInput => ({
  streamId: streamId.desk(item.id),
  event: {
    type: 'DeskItemResolved',
    payload: {
      deskItemId: item.id,
      resolution,
      ...(note ? { note } : {}),
      by: { kind: 'user', userId: user.id },
    },
  },
  actor: userActor(user.id),
  scope: itemScope(item),
});

const reviewedEvent = (
  item: Row,
  user: AuthSession['user'],
  extra: Record<string, unknown>,
): AppendInput => ({
  streamId: streamId.ceo(item.org_id),
  event: {
    type: 'CeoDecisionReviewed',
    payload: {
      orgId: item.org_id,
      deskItemId: item.id,
      ...(decisionOf(item)?.actionId ? { actionId: decisionOf(item)?.actionId } : {}),
      by: user.id,
      ...extra,
    },
  } as AppendInput['event'],
  actor: userActor(user.id),
  scope: orgScope(item.org_id),
});

/** Acknowledge one CEO decision: marks it read; the CEO takes it as a thumbs-up. */
export async function acknowledgeCeoDecision(ctx: Ctx, user: AuthSession['user'], id: string): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const item = await lockDecision(tx, user, id);
    await ctx.store.append(
      [
        ...resolvedEvents(item, user, 'acknowledged'),
        reviewedEvent(item, user, { outcome: 'acknowledged' }),
        ...(await acknowledgeLearning(tx, item.org_id, [item])),
      ],
      { tx },
    );
  });
}

/**
 * Acknowledge every open CEO decision of the organization that the user can see, in one append (a resolve and a review
 * event per item, plus the confidence of the memories they cited). Returns how many were closed.
 */
export async function acknowledgeAllCeoDecisions(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
): Promise<number> {
  return withAppendTx(ctx.pool, async (tx) => {
    if (!isOrgManager({ orgRole: await orgRoleOf(tx, user.id, orgId) }))
      throw forbidden('only an Owner or Admin can review the CEO decisions');
    const items = await rows(
      tx,
      `SELECT d.* FROM desk_items d WHERE d.org_id=$2 AND ${DESK_VISIBLE} AND ${UNREVIEWED_CEO_DECISION_SQL}
        ORDER BY d.created_at, d.id FOR UPDATE OF d`,
      [user.id, orgId],
    );
    if (items.length === 0) return 0;
    const events: AppendInput[] = items.flatMap((it) => [
      ...resolvedEvents(it, user, 'acknowledged'),
      reviewedEvent(it, user, { outcome: 'acknowledged', batch: true }),
    ]);
    events.push(...(await acknowledgeLearning(tx, orgId, items)));
    await ctx.store.append(events, { tx });
    return items.length;
  });
}

/** What the BA is asked in the CEO-BA review (the BA task's instructions, at most 2000 characters). */
export function reviewInstructions(i: {
  question: string;
  decision: string;
  reason: string;
  correction: string;
  cardRef?: string | null;
}): string {
  return clip(
    [
      `CEO decision review${i.cardRef ? ` (card ${i.cardRef})` : ''}. The owner corrected a decision of the CEO.`,
      `Situation: ${clip(i.question, 200)}`,
      `The CEO decided: ${clip(i.decision, 200)}`,
      `The CEO's reason: ${clip(i.reason, 200)}`,
      `The owner's correction: ${clip(i.correction, 300)}`,
      'Read-only, using the ledger, the card thread and the facts below. Write a short analysis (under 150 words): why the CEO instinct was wrong and which signal it missed. Then assess the CONSEQUENCES: what already happened because of the decision (cards built or merged on it, branches set, items closed, agents retired, orders changed). Then propose the FIX WORK as concrete cards (title, project key, what to change, acceptance criteria, dependencies), or say no fix work is needed and why. Do NOT create the cards: they are a proposal the CEO comments on first. End the analysis with one line \'Rule: \' (the rule in one sentence), then ONE fenced json block: {"consequences":"..","fixCards":[{"title","project","cardType","change","acceptanceCriteria":[],"dependsOn":[]}],"noFixNeeded":"reason, only when there are no cards"}.',
      'Post it with `aom report brief --summary-file <report.md>`.',
    ].join('\n'),
    1990,
  );
}

/** The result of correcting a decision. */
export interface CorrectionResult {
  reviewId: string;
  memoryId: string;
  applied: string | null;
}

/**
 * The owner says the CEO was wrong. In one transaction: the item closes, the owner's words become an owner-confirmed
 * memory ("Owner corrected: <situation> -> <right decision> (was: <CEO decision>)"), and the CEO-BA review is queued as a
 * BA task. With `applyNow` the decision is also undone where the CEO action has a clean inverse (the Owner only).
 */
export async function correctCeoDecision(
  ctx: Ctx,
  user: AuthSession['user'],
  id: string,
  req: { correction: string; applyNow?: boolean | undefined },
): Promise<CorrectionResult> {
  const correction = req.correction.trim();
  if (!correction) throw badRequest('empty_correction', 'say what the right decision is');
  const reviewId = randomUUID();
  let actionToUndo: { orgId: string; actionId: string } | undefined;
  const base = await withAppendTx(ctx.pool, async (tx) => {
    const item = await lockDecision(tx, user, id);
    const d = decisionOf(item);
    if (!d) throw conflict('not_a_decision', 'this item carries no CEO decision');
    const ceo = await loadCeo(tx, item.org_id);
    const memoryId = await addMemoryIn(ctx, tx, {
      orgId: item.org_id,
      kind: 'correction',
      scope: d.class ? `desk:${d.class}` : 'org',
      source: 'owner_override',
      sourceRef: `desk:${item.id}`,
      confidence: 0.95,
      status: 'active',
      text: `Owner corrected: ${clip(d.question, 300)} → ${clip(correction, 500)} (was: ${clip(d.decision, 300)})`,
      quote: correction.slice(0, 1000),
      ...(d.class ? { cls: d.class } : {}),
      byUserId: user.id,
    });
    // The memories the wrong decision leaned on lose confidence, as after an undo.
    const adjust: AppendInput[] = [];
    for (const mid of await citedBy(tx, item.org_id, d.actionId)) {
      const m = await one(
        tx,
        `SELECT confidence FROM ceo_memories WHERE id=$1 AND org_id=$2 AND status IN ('active','candidate')`,
        [mid, item.org_id],
      );
      if (m)
        adjust.push({
          streamId: streamId.ceo(item.org_id),
          event: {
            type: 'CeoMemoryAdjusted',
            payload: {
              memoryId: mid,
              orgId: item.org_id,
              confidence: Math.max(0, Number(m.confidence) - 0.2),
              reason: 'the decision was corrected by the owner',
            },
          },
          actor: SYSTEM_ACTOR,
          scope: orgScope(item.org_id),
        });
    }
    const ownerRole = await orgRoleOf(tx, user.id, item.org_id);
    let applied: string | null = null;
    if (req.applyNow) {
      if (d.actionId && ownerRole === 'owner') actionToUndo = { orgId: item.org_id, actionId: d.actionId };
      else
        applied = d.actionId
          ? 'Not applied: only the Owner can undo the decision.'
          : 'Not applied: this decision has no automatic undo.';
    }
    const card = item.card_id ? await one(tx, 'SELECT * FROM cards WHERE id=$1', [item.card_id]) : undefined;
    const events: AppendInput[] = [
      ...resolvedEvents(item, user, 'rejected', correction),
      reviewedEvent(item, user, {
        outcome: 'corrected',
        correction,
        applyNow: req.applyNow === true,
        ...(applied ? { applied } : {}),
        reviewId,
        memoryId,
      }),
      ...adjust,
      // The desk path is one entry point of the correction (docs/design/ceo-front-door.md section 7.1): same event as the chat's.
      {
        streamId: streamId.ceo(item.org_id),
        event: {
          type: 'CeoCorrected',
          payload: {
            correctionId: randomUUID(),
            orgId: item.org_id,
            by: user.id,
            ...(d.actionId ? { actionId: d.actionId } : {}),
            deskItemId: item.id,
            text: correction.slice(0, 4000),
            rule: correction.slice(0, 1000),
            memoryId,
            remedy: req.applyNow ? ('undo' as const) : ('none' as const),
            ...(d.class ? { class: d.class } : {}),
          },
        },
        actor: userActor(user.id),
        scope: orgScope(item.org_id),
      },
    ];
    if (card)
      events.push(
        cardMessage(
          card,
          { kind: 'user', userId: user.id },
          'comment',
          `The owner corrected the CEO decision "${clip(d.decision, 200)}": ${correction}`,
          { deskItemId: item.id, ceoCorrection: true },
        ),
      );
    // The BA review: filed under the decision's project (any BA of the organization without one).
    const projectId = await carrierProject(tx, item.org_id, item.project_id);
    if (projectId) {
      const taskId = randomUUID();
      events.push({
        streamId: streamId.baTask(taskId),
        event: {
          type: 'BaTaskQueued',
          payload: {
            taskId,
            projectId,
            kind: 'scheduled_brief',
            instructions: reviewInstructions({
              question: d.question,
              decision: d.decision,
              reason: d.reason,
              correction,
              cardRef: card?.ref ?? null,
            }),
            deliver: 'desk_notice',
            scheduleName: CEO_REVIEW_TASK_NAME,
            deskItemIds: [item.id],
            ...(item.project_id ? {} : { orgLevel: true }),
          },
        },
        actor: SYSTEM_ACTOR,
        scope: projectScope(item.org_id, projectId),
      });
    }
    await ctx.store.append(events, { tx });
    void ceo;
    return { memoryId, applied, queued: !!projectId };
  });
  let applied = base.applied;
  if (actionToUndo) {
    try {
      const { undoCeoAction } = await import('./commands.ts');
      const u = await undoCeoAction(ctx, user, actionToUndo.orgId, actionToUndo.actionId);
      applied = u.message;
    } catch (err) {
      applied = `Not applied: ${(err as Error).message}`;
    }
    const item = await one(ctx.pool, 'SELECT * FROM desk_items WHERE id=$1', [id]);
    if (item)
      await ctx.store.append([
        reviewedEvent(item, user, { outcome: 'corrected', applied, reviewId, applyNow: true }),
      ]);
  }
  // Nobody to file the review under (an organization without a project): the lesson is recorded straight away.
  if (!base.queued) {
    const { recordLesson } = await import('./review.ts');
    await recordLesson(ctx, id, reviewId, { by: 'server' });
  }
  return { reviewId, memoryId: base.memoryId, applied };
}

// ------------------------------------------------------------------------------------------ the BA's report

/** The `Rule:` line of the BA's analysis, if it wrote one. */
export const proposedRuleOf = (analysis: string): string | undefined =>
  analysis
    .split('\n')
    .map((l) => l.trim())
    .reverse()
    .find((l) => /^rule:/i.test(l))
    ?.replace(/^rule:\s*/i, '')
    .slice(0, 500);

/** True when a BA task is the CEO review of a decision (its report is not a desk notice). */
export async function ceoReviewItemOfTask(db: Queryable, task: Row): Promise<Row | undefined> {
  if (task.schedule_name !== CEO_REVIEW_TASK_NAME && task.schedule_name !== CEO_REVIEW_FINAL_TASK_NAME)
    return undefined;
  const id = (task.desk_item_ids as string[] | null)?.[0];
  if (!id) return undefined;
  return one(db, `SELECT d.* FROM desk_items d WHERE d.id=$1 AND ${IS_CEO_DECISION_SQL}`, [id]);
}
