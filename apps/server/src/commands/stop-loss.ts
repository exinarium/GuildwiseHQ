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
import { ceoActive, ceoReachable } from '../ceo/state.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { cardMessage, projectScope, SYSTEM_ACTOR } from './common.ts';
import { architectRoute, type Route } from './escalation.ts';

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

/**
 * Where counting starts: the card's baseline (`card_stop_loss_baseline`, set by migration 2190 for the cards that existed
 * then, so old history does not park them) or the beginning of time for a new card. The table has no foreign key, so
 * a projection rebuild (which truncates `cards`) leaves it alone.
 */
const SINCE = `COALESCE((SELECT b.since FROM card_stop_loss_baseline b WHERE b.card_id = $1), '-infinity'::timestamptz)`;

export interface CardUsage {
  buildPasses: number;
  reviewRounds: number;
  shifts: number;
  /** Counted shifts that ended without a report (crashed, no_report, timeout, lost). */
  failedShifts?: number;
  /** The outcome most of those failed shifts share. */
  failureKind?: string;
}

/** What the card has used so far: build handoffs, review rounds that asked for changes, shifts that ran. */
export async function cardUsage(db: Queryable, cardId: string): Promise<CardUsage> {
  const h = await one<{ builds: number; changes: number }>(
    db,
    `SELECT count(*) FILTER (WHERE stage = 'build')::int AS builds,
            count(*) FILTER (WHERE stage = 'review' AND outcome = 'changes')::int AS changes
       FROM card_handoffs WHERE card_id=$1 AND created_at >= ${SINCE}`,
    [cardId],
  );
  const s = await one<{ n: number }>(
    db,
    // Shifts that ran (not rejections) in the stages a card goes round in; design and the closing stages do not count.
    `SELECT count(*)::int AS n FROM shifts WHERE card_id=$1 AND started_at >= ${SINCE} AND kind='card' AND outcome IS DISTINCT FROM 'rejected'
        AND COALESCE(stage, '') NOT LIKE 'investigate%' AND COALESCE(stage, '') NOT IN ('finalize', 'qa_steps')`,
    [cardId],
  );
  const f = await rows<{ outcome: string; n: number }>(
    db,
    `SELECT outcome, count(*)::int AS n FROM shifts WHERE card_id=$1 AND started_at >= ${SINCE} AND kind='card'
        AND status='ended' AND report_outcome IS NULL AND outcome IN ('crashed', 'no_report', 'timeout', 'lost')
        AND COALESCE(stage, '') NOT LIKE 'investigate%' AND COALESCE(stage, '') NOT IN ('finalize', 'qa_steps')
      GROUP BY outcome ORDER BY count(*) DESC`,
    [cardId],
  );
  const failedShifts = f.reduce((a, x) => a + Number(x.n), 0);
  return {
    buildPasses: Number(h?.builds ?? 0),
    reviewRounds: Number(h?.changes ?? 0),
    shifts: Number(s?.n ?? 0),
    failedShifts,
    ...(f[0] ? { failureKind: f[0].outcome } : {}),
  };
}

/** The budget of this card: the project's setting (else the defaults) plus what answered arbitrations added. */
export async function stopLossBudget(db: Queryable, card: Row): Promise<StopLossBudget> {
  const p = await one(db, 'SELECT stop_loss FROM projects WHERE id=$1', [card.project_id]);
  const parsed = StopLossSettingsSchema.safeParse(p?.stop_loss);
  // A platform bug card is sized by the architect's triage (platform team), not by the diff.
  const bug = await one(db, 'SELECT fix_size FROM platform_bugs WHERE card_id=$1', [card.id]);
  const size: CardSize = (bug?.fix_size as CardSize | undefined) ?? cardSize(card);
  const base = (parsed.success ? parsed.data : DEFAULT_STOP_LOSS)[size];
  const ext = await one<{ n: number }>(
    db,
    // An answer and a dismissal both resolve the arbitration and grant the extension: a dismissed item must not be
    // raised again a minute later by the same usage (production: GWP-19, GWP-3).
    `SELECT count(*)::int AS n FROM desk_items WHERE card_id=$1 AND subkind=$2 AND status IN ('answered','dismissed')
        AND keep_blocked_until IS NULL AND created_at >= ${SINCE}`,
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
  next: { reviewRound?: boolean; preReview?: boolean } = {},
): 'review rounds' | 'build passes' | 'shifts' | null {
  // lean team pre-review: a Sonnet pass, not an Opus round; only the build passes it causes are capped.
  if (next.preReview) return usage.buildPasses >= budget.buildPasses ? 'build passes' : null;
  const rounds = usage.reviewRounds + (next.reviewRound ? 1 : 0);
  if (next.reviewRound && rounds >= budget.reviewRounds) return 'review rounds';
  if (next.reviewRound && usage.buildPasses >= budget.buildPasses) return 'build passes';
  if (!next.reviewRound && usage.shifts >= budget.shifts) return 'shifts';
  return null;
}

/** The CEO arbitrates one card's stop-loss this many times; the next one goes to the owner's desk. */
export const CEO_STOP_LOSS_ARBITRATIONS = 3;
/** How long a stop-loss is held for the CEO (hidden from the desk) before the owner sees it. */
export const CEO_STOP_LOSS_HOLD_MINUTES = 20;

/**
 * How often the CEO resolved a stop-loss of this card (it answered the item, or dismissed it by moving the card), since
 * the card's baseline.
 */
export async function ceoStopLossArbitrations(
  db: Queryable,
  cardId: string,
  subkind: string = DESK_SUBKIND.stopLoss,
): Promise<number> {
  const r = await one<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM desk_items d
      WHERE d.card_id=$1 AND d.subkind=$2 AND d.status IN ('answered','dismissed') AND d.created_at >= ${SINCE}
        AND (d.data->'ceoDecision' IS NOT NULL
             OR EXISTS (SELECT 1 FROM agents a WHERE a.id = d.answered_by_agent_id AND a.role_key = 'ceo')
             OR EXISTS (SELECT 1 FROM events ev JOIN agents a ON a.id = ev.actor_id AND a.role_key = 'ceo'
                         WHERE ev.stream_id = 'desk-' || d.id::text AND ev.type = 'DeskItemResolved'
                           AND ev.actor_kind = 'agent'))`,
    [cardId, subkind],
  );
  return Number(r?.n ?? 0);
}

/**
 * Who arbitrates a stop-loss. With an active CEO it is the CEO alone (not the architect, not the owner): the item is held,
 * hidden from the desk, for it and released to the owner after `CEO_STOP_LOSS_HOLD_MINUTES` if the CEO did not decide.
 * After `CEO_STOP_LOSS_ARBITRATIONS` arbitrations of the same card the owner decides. Without a CEO: the card's architect,
 * else the desk, as before.
 */
export async function stopLossRoute(
  ctx: Ctx,
  tx: Tx,
  card: Row,
  /** `tester_loop`: the same arbitration (CEO three times, then the owner), counted on its own, and no architect without a CEO. */
  subkind: string = DESK_SUBKIND.stopLoss,
): Promise<{ route: Route; ceoHold?: { deadline: string }; note: string }> {
  const ceo = await ceoActive(tx, card.org_id);
  const reachable = ceo ? (await ceoReachable(tx, card.org_id, ctx.clock.now())).ok : false;
  const paused = ceo
    ? !!(await one(tx, 'SELECT 1 FROM projects WHERE id=$1 AND paused_at IS NOT NULL', [card.project_id]))
    : false;
  // A CEO that cannot run a shift now, or a paused project (nothing of it is dispatched, so nobody would look at the
  // item): the owner's desk at once. Never the architect or the BA in the CEO's place.
  if (ceo && (!reachable || paused))
    return {
      route: { routedTo: 'manager', level: 'desk' },
      note: `The CEO ${paused ? 'cannot look at this now (the project is paused)' : 'is not reachable'}: the owner decides.`,
    };
  if (!ceo && subkind !== DESK_SUBKIND.stopLoss)
    return {
      route: { routedTo: 'manager', level: 'desk' },
      note: "Asked: the manager's desk (no CEO is active).",
    };
  if (!ceo) {
    const route = await architectRoute(ctx, tx, card);
    return {
      route,
      note: `Asked: ${route.routedTo === 'manager' ? "the manager's desk" : `${route.agentName} (${route.agentRole})`}. The architect decides how it goes on; if it cannot, the owner gets one item with options.`,
    };
  }
  const done = await ceoStopLossArbitrations(tx, card.id, subkind);
  if (done >= CEO_STOP_LOSS_ARBITRATIONS)
    return {
      route: { routedTo: 'manager', level: 'desk' },
      note: `The CEO arbitrated this card's ${subkind === DESK_SUBKIND.stopLoss ? 'stop-loss' : 'tester loop'} ${done} times already: the owner decides now.`,
    };
  return {
    route: { routedTo: 'manager', level: 'desk' },
    ceoHold: {
      deadline: new Date(ctx.clock.now().getTime() + CEO_STOP_LOSS_HOLD_MINUTES * 60_000).toISOString(),
    },
    note: `Asked: the CEO (arbitration ${done + 1} of ${CEO_STOP_LOSS_ARBITRATIONS}). It raises the model or effort when there are real issues, moves the card when there are none, or cancels or reassigns it; the owner sees the item only if the CEO cannot decide.`,
  };
}

/** The last error text the loop breaker recorded for the card (its parked or back-off item), short. */
async function lastShiftError(db: Queryable, cardId: string): Promise<string | null> {
  const it = await one<{ body: string }>(
    db,
    `SELECT body FROM desk_items WHERE card_id=$1 AND subkind = ANY($2) ORDER BY created_at DESC LIMIT 1`,
    [cardId, [DESK_SUBKIND.loopParked, DESK_SUBKIND.loopBackoff]],
  );
  const m = it?.body.match(/Last (?:error[^\n]*|output):\n([\s\S]*?)(?:\n\nFix the cause|$)/);
  const t = m?.[1]?.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 300) : null;
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
  // A card the loop breaker already parked has one blocking item: a crash loop does not get a second one.
  const looped = await one(tx, `SELECT 1 FROM desk_items WHERE card_id=$1 AND subkind=$2 AND status='open'`, [
    card.id,
    DESK_SUBKIND.loopParked,
  ]);
  if (looped) return [];
  const { route, ceoHold, note } = await stopLossRoute(ctx, tx, card);
  const deskItemId = randomUUID();
  const size = cardSize(card);
  const counts = `${size} card: ${usage.buildPasses}/${budget.buildPasses} build passes, ${usage.reviewRounds}/${budget.reviewRounds} review rounds, ${usage.shifts}/${budget.shifts} shifts`;
  const failed = usage.failedShifts ?? 0;
  let text: string;
  if (usage.shifts > 0 && failed * 2 > usage.shifts) {
    const lastError = await lastShiftError(tx, card.id);
    text = `${card.ref} used its ${limit} budget (${counts}). ${failed} of ${usage.shifts} shifts ended without a report (mostly ${usage.failureKind})${lastError ? `; last error: ${lastError}` : ''}. Look at the cause first (a denied tool, a missing repository or environment, a crashing runtime), then decide how it goes on: fix the setup, split the card or change the design.`;
  } else {
    text = `${card.ref} used its ${limit} budget (${counts}). Decide how it goes on: what is the builder missing${usage.reviewRounds > 0 ? ', what does the reviewer disagree on' : ''}, should the card be split or the design changed?`;
  }
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
          ...(ceoHold ? { triage: ceoHold } : {}),
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
      `${card.ref} reached its stop-loss (${limit}): it is parked. ${note}`,
      { deskItemId },
    ),
  ];
}
