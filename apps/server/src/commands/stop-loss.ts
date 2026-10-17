import { randomUUID } from 'node:crypto';
import {
  type CardSize,
  DEFAULT_STOP_LOSS,
  DESK_SUBKIND,
  STOP_LOSS_EXTENSION,
  type StopLossBudget,
  StopLossSettingsSchema,
  streamId,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { cardMessage, projectScope, SYSTEM_ACTOR } from './common.ts';
import { architectRoute } from './escalation.ts';

/**
 * Stop-loss per card (design section 11, owner decision 17 Oct): a card that used its budget of build passes, review
 * rounds or shifts is parked and goes to the card's architect for arbitration; when the architect cannot resolve it,
 * one desk item with options goes to the owner. The budget depends on the card's size and is a project setting.
 */

/**
 * Card size for the budget. The code knows `small | large` (the risk tier, set from the diff when review is
 * requested): small maps to small, large to large. A card that is designed (designNeeded) and not large counts as medium.
 */
export function cardSize(card: Row): CardSize {
  if (card.risk_tier === 'large') return 'large';
  if (card.design_needed === true) return 'medium';
  return 'small';
}

export interface CardUsage {
  buildPasses: number;
  reviewRounds: number;
  shifts: number;
}

/** What the card has used so far: build handoffs, review rounds that asked for changes, shifts that ran. */
export async function cardUsage(db: Queryable, cardId: string): Promise<CardUsage> {
  const h = await one<{ builds: number; changes: number }>(
    db,
    `SELECT count(*) FILTER (WHERE stage = 'build')::int AS builds,
            count(*) FILTER (WHERE stage = 'review' AND outcome = 'changes')::int AS changes
       FROM card_handoffs WHERE card_id=$1`,
    [cardId],
  );
  const s = await one<{ n: number }>(
    db,
    // Shifts that ran (not rejections) in the stages a card goes round in; design and the closing stages do not count.
    `SELECT count(*)::int AS n FROM shifts WHERE card_id=$1 AND kind='card' AND outcome IS DISTINCT FROM 'rejected'
        AND COALESCE(stage, '') NOT LIKE 'investigate%' AND COALESCE(stage, '') NOT IN ('finalize', 'qa_steps')`,
    [cardId],
  );
  return {
    buildPasses: Number(h?.builds ?? 0),
    reviewRounds: Number(h?.changes ?? 0),
    shifts: Number(s?.n ?? 0),
  };
}

/** The budget of this card: the project's setting (else the defaults) plus what answered arbitrations added. */
export async function stopLossBudget(db: Queryable, card: Row): Promise<StopLossBudget> {
  const p = await one(db, 'SELECT stop_loss FROM projects WHERE id=$1', [card.project_id]);
  const parsed = StopLossSettingsSchema.safeParse(p?.stop_loss);
  const base = (parsed.success ? parsed.data : DEFAULT_STOP_LOSS)[cardSize(card)];
  const ext = await one<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM desk_items WHERE card_id=$1 AND subkind=$2 AND status='answered'
        AND keep_blocked_until IS NULL`,
    [card.id, DESK_SUBKIND.stopLoss],
  );
  const n = Number(ext?.n ?? 0);
  return {
    buildPasses: base.buildPasses + n * STOP_LOSS_EXTENSION.buildPasses,
    reviewRounds: base.reviewRounds + n * STOP_LOSS_EXTENSION.reviewRounds,
    shifts: base.shifts + n * STOP_LOSS_EXTENSION.shifts,
  };
}

/** Which limit the usage has reached, if any. `next` counts the review round or build pass that is about to start. */
export function limitReached(
  usage: CardUsage,
  budget: StopLossBudget,
  next: { reviewRound?: boolean } = {},
): 'review rounds' | 'build passes' | 'shifts' | null {
  const rounds = usage.reviewRounds + (next.reviewRound ? 1 : 0);
  if (next.reviewRound && rounds >= budget.reviewRounds) return 'review rounds';
  if (next.reviewRound && usage.buildPasses >= budget.buildPasses) return 'build passes';
  if (!next.reviewRound && usage.shifts >= budget.shifts) return 'shifts';
  return null;
}

/**
 * The events that park `card` and ask its architect to arbitrate (the manager's desk when no architect is online):
 * one blocking question per episode. Empty while an arbitration of the card is open.
 */
export async function stopLossEvents(
  ctx: Ctx,
  tx: Tx,
  card: Row,
  limit: string,
  usage: CardUsage,
  budget: StopLossBudget,
): Promise<AppendInput[]> {
  const open = await one(tx, `SELECT 1 FROM desk_items WHERE card_id=$1 AND subkind=$2 AND status='open'`, [
    card.id,
    DESK_SUBKIND.stopLoss,
  ]);
  if (open) return [];
  const route = await architectRoute(ctx, tx, card);
  const deskItemId = randomUUID();
  const size = cardSize(card);
  const text = `${card.ref} used its ${limit} budget (${size} card: ${usage.buildPasses}/${budget.buildPasses} build passes, ${usage.reviewRounds}/${budget.reviewRounds} review rounds, ${usage.shifts}/${budget.shifts} shifts). Decide how it goes on: what is the builder missing, what does the reviewer disagree on, should the card be split or the design changed?`;
  return [
    {
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'QuestionRaised',
        payload: {
          deskItemId,
          cardId: card.id,
          projectId: card.project_id,
          askedBy: { kind: 'system' },
          doing: `${card.ref} (${card.title}) reached its stop-loss`,
          question: text,
          options: [{ id: 'o1', label: 'Go on: one more build pass and review round' }],
          recommendation: 'o1',
          blocking: true,
          routedTo: route.routedTo,
          ...(route.routedAgentId ? { routedAgentId: route.routedAgentId } : {}),
          chainLevel: route.level,
          topic: 'design',
          subkind: DESK_SUBKIND.stopLoss,
          dedupLedgerIds: [],
          affectedCardIds: [card.id],
          pinned: true,
        },
      },
      actor: SYSTEM_ACTOR,
      scope: projectScope(card.org_id, card.project_id),
    },
    cardMessage(
      card,
      { kind: 'system' },
      'system',
      `${card.ref} reached its stop-loss (${limit}): it is parked. Asked: ${route.routedTo === 'manager' ? "the manager's desk" : `${route.agentName} (${route.agentRole})`}. The architect decides how it goes on; if it cannot, the owner gets one item with options.`,
      { deskItemId },
    ),
  ];
}
