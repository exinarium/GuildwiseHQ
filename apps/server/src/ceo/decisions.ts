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
import { DESK_VISIBLE } from '../queries/desk.ts';
import { carrierProject } from '../reporter/tasks.ts';
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

/** Action classes whose decisions the owner reviews (the ones that would otherwise be a question or an approval). */
export const REVIEWED_CLASSES = new Set([
  'desk.answer_question',
  'devops.approve',
  'card.cancel',
  'agent.retire',
  'standing_order.activate',
  'standing_order.retire',
]);

const clip = (s: string, n: number): string => {
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

/** `DeskItemCreated` for one CEO decision (informational: alert, not blocking, not pinned). */
export function ceoDecisionItemEvents(d: DecisionInput): AppendInput[] {
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

const decisionOf = (item: Row): DecisionData | undefined =>
  (item.data as { ceoDecision?: DecisionData } | null)?.ceoDecision;

const itemScope = (item: Row) =>
  item.project_id ? projectScope(item.org_id, item.project_id) : orgScope(item.org_id);

/** Locks a visible, open CEO decision of the user's reach; only an Owner or Admin of its organization may review it. */
async function lockDecision(tx: Tx, user: AuthSession['user'], id: string): Promise<Row> {
  const item = await one(
    tx,
    `SELECT d.* FROM desk_items d WHERE d.id=$2 AND ${DESK_VISIBLE} AND d.subkind=$3 FOR UPDATE OF d`,
    [user.id, id, CEO_DECISION_SUBKIND],
  );
  if (!item) throw notFound('desk item not found');
  if (!isOrgManager({ orgRole: await orgRoleOf(tx, user.id, item.org_id) }))
    throw forbidden('only an Owner or Admin can review the CEO decisions');
  if (item.status !== 'open') throw conflict('already_resolved', `this item is already ${item.status}`);
  return item;
}

const citedMemoryIds = (evidence: unknown): string[] =>
  (Array.isArray(evidence) ? evidence : [])
    .map(String)
    .filter((e) => e.startsWith('memory:'))
    .map((e) => e.slice(7));

/** The memory ids the decision's action cited as evidence. */
async function citedBy(db: Queryable, orgId: string, actionId: string | null): Promise<string[]> {
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
        resolvedEvent(item, user, 'acknowledged'),
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
      `SELECT d.* FROM desk_items d WHERE d.org_id=$2 AND ${DESK_VISIBLE} AND d.subkind=$3 AND d.status='open'
        ORDER BY d.created_at, d.id FOR UPDATE OF d`,
      [user.id, orgId, CEO_DECISION_SUBKIND],
    );
    if (items.length === 0) return 0;
    const events: AppendInput[] = items.flatMap((it) => [
      resolvedEvent(it, user, 'acknowledged'),
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
      `Situation: ${clip(i.question, 350)}`,
      `The CEO decided: ${clip(i.decision, 350)}`,
      `The CEO's reason: ${clip(i.reason, 300)}`,
      `The owner's correction: ${clip(i.correction, 450)}`,
      'Read-only, using the ledger and the card: write a short analysis (under 150 words): why the CEO instinct was wrong, which signal it missed, and a proposed rule. End with one line that starts with "Rule: " and states the rule in one sentence.',
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
      resolvedEvent(item, user, 'rejected', correction),
      reviewedEvent(item, user, {
        outcome: 'corrected',
        correction,
        applyNow: req.applyNow === true,
        ...(applied ? { applied } : {}),
        reviewId,
        memoryId,
      }),
      ...adjust,
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
  if (!base.queued) await recordLesson(ctx, id, reviewId, undefined, true);
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
  if (task.schedule_name !== CEO_REVIEW_TASK_NAME) return undefined;
  const id = (task.desk_item_ids as string[] | null)?.[0];
  if (!id) return undefined;
  return one(db, `SELECT * FROM desk_items WHERE id=$1 AND subkind=$2`, [id, CEO_DECISION_SUBKIND]);
}

/**
 * The BA's analysis arrived (or the BA never came, `fallback`): it goes on the item and the card thread, and the CEO records
 * the lesson. Returns the events; the caller appends them in its transaction, then calls `recordLesson`.
 */
export async function reviewAnalysisEvents(
  tx: Tx,
  item: Row,
  input: { analysis: string; baAgentId?: string | undefined; fallback?: boolean },
): Promise<AppendInput[]> {
  const reviewId = (item.data as { correction?: { reviewId?: string } } | null)?.correction?.reviewId;
  if (!reviewId) return [];
  const card = item.card_id ? await one(tx, 'SELECT * FROM cards WHERE id=$1', [item.card_id]) : undefined;
  const rule = proposedRuleOf(input.analysis);
  const events: AppendInput[] = [
    {
      streamId: streamId.ceo(item.org_id),
      event: {
        type: 'CeoCorrectionAnalysed',
        payload: {
          orgId: item.org_id,
          deskItemId: item.id,
          reviewId,
          analysis: input.analysis.slice(0, 8000),
          ...(rule ? { proposedRule: rule } : {}),
          ...(input.baAgentId ? { baAgentId: input.baAgentId } : {}),
          ...(input.fallback ? { fallback: true } : {}),
        },
      },
      actor: input.baAgentId ? agentActor(input.baAgentId) : SYSTEM_ACTOR,
      scope: orgScope(item.org_id),
    },
  ];
  if (card)
    events.push(
      cardMessage(
        card,
        input.baAgentId ? { kind: 'agent', agentId: input.baAgentId } : { kind: 'system' },
        'comment',
        `BA review of the CEO decision after the owner's correction:\n\n${clip(input.analysis, 1500)}`,
        { deskItemId: item.id, ceoReview: true },
      ),
    );
  return events;
}

/**
 * The CEO records the lesson: an owner-confirmed rule linked to the correction (`desk:<item>`), replacing the memories the
 * decision cited that the CEO had learned itself (owner statements are never retired, only lowered). When the CEO is not
 * active the server records it on its behalf. Idempotent per review.
 */
export async function recordLesson(
  ctx: Ctx,
  deskItemId: string,
  reviewId: string,
  analysis: string | undefined,
  noBa = false,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const item = await one(tx, 'SELECT * FROM desk_items WHERE id=$1 FOR UPDATE', [deskItemId]);
    const d = item && decisionOf(item);
    if (!item || !d) return;
    const corr = (item.data as { correction?: { reviewId?: string; review?: string; text?: string } })
      .correction;
    if (!corr || corr.reviewId !== reviewId || corr.review === 'done') return;
    const ceo = await loadCeo(tx, item.org_id);
    const ceoId = ceo?.enabled && ceo.agentId ? ceo.agentId : null;
    const rule =
      (analysis ? proposedRuleOf(analysis) : undefined) ??
      `When deciding "${clip(d.question, 160)}", the right decision is: ${clip(corr.text ?? '', 300)}`;
    const lesson = `Lesson (owner correction${noBa ? '' : ' reviewed with the BA'}): ${rule}`;
    const memoryId = await addMemoryIn(ctx, tx, {
      orgId: item.org_id,
      kind: 'rule',
      scope: d.class ? `desk:${d.class}` : 'org',
      source: 'owner_override',
      sourceRef: `desk:${item.id}`,
      confidence: 0.9,
      status: 'active',
      text: lesson,
      quote: (corr.text ?? '').slice(0, 1000),
      ...(ceoId ? { byAgentId: ceoId } : {}),
    });
    const retired: string[] = [];
    const events: AppendInput[] = [];
    for (const mid of await citedBy(tx, item.org_id, d.actionId)) {
      const m = await one(tx, `SELECT status, source FROM ceo_memories WHERE id=$1 AND org_id=$2`, [
        mid,
        item.org_id,
      ]);
      if (!m || m.status === 'retired' || m.source === 'owner_statement') continue;
      retired.push(mid);
      events.push({
        streamId: streamId.ceo(item.org_id),
        event: {
          type: 'CeoMemoryRetired',
          payload: {
            memoryId: mid,
            orgId: item.org_id,
            reason: 'replaced by a lesson from an owner correction',
          },
        },
        actor: ceoId ? agentActor(ceoId) : SYSTEM_ACTOR,
        scope: orgScope(item.org_id),
      });
    }
    events.push({
      streamId: streamId.ceo(item.org_id),
      event: {
        type: 'CeoLessonRecorded',
        payload: {
          orgId: item.org_id,
          deskItemId: item.id,
          reviewId,
          memoryId,
          lesson: lesson.slice(0, 1000),
          retiredMemoryIds: retired,
          recordedBy: ceoId ? 'ceo' : 'server',
        },
      },
      actor: ceoId ? agentActor(ceoId) : SYSTEM_ACTOR,
      scope: orgScope(item.org_id),
    });
    const card = item.card_id ? await one(tx, 'SELECT * FROM cards WHERE id=$1', [item.card_id]) : undefined;
    if (card)
      events.push(
        cardMessage(
          card,
          ceoId ? { kind: 'agent', agentId: ceoId } : { kind: 'system' },
          'comment',
          `CEO lesson recorded after the owner's correction: ${rule}`,
          { deskItemId: item.id, ceoReview: true },
        ),
      );
    await ctx.store.append(events, { tx });
  });
}

/** Store hook: once the BA's analysis is committed, the CEO records the lesson. */
export function registerCeoReviewHook(ctx: Ctx): () => void {
  return ctx.store.subscribe(async (e) => {
    if (e.event.type !== 'CeoCorrectionAnalysed') return;
    const p = e.event.payload;
    try {
      await recordLesson(ctx, p.deskItemId, p.reviewId, p.fallback ? undefined : p.analysis);
    } catch (err) {
      ctx.log.error({ err }, 'recording the CEO lesson failed');
    }
  });
}
