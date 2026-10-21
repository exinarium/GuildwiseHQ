import { randomUUID } from 'node:crypto';
import {
  DESK_SUBKIND,
  LOOP_BREAKER,
  LOOP_PARK_FAILURES,
  loopBackoffMinutes,
  QUESTION_LOOP,
  streamId,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { projectScope, SYSTEM_ACTOR } from './common.ts';
import { openItemForSubject } from './desk-coalesce.ts';

/** Shift end outcomes that count as a failed shift when no report was written. */
const FAILED_OUTCOMES = ['no_report', 'crashed', 'timeout', 'lost'];

const hhmm = (d: Date) => `${d.toISOString().slice(11, 16)} UTC`;

export interface LoopBreakerPlan {
  /** The thread message for the release: `null` suppresses it (the loop breaker already said what is needed). */
  message: string | null;
  /** Events appended after the claim release. */
  events: AppendInput[];
}

/**
 * Called when a card shift ended without a report (docs/design/phases.md B0). Decides the thread message and, once
 * 3 shifts failed within 10 minutes (counting only shifts after the card's last report), the back-off: 1 min,
 * doubling per further failure of the episode, capped at 1 h. One desk alert per episode, raised with its first back-off.
 * At `LOOP_PARK_FAILURES` failures the episode ends in a park instead of another back-off (`parkEvents`).
 */
export async function loopBreakerPlan(
  ctx: Ctx,
  tx: Tx,
  card: Row,
  defaultMessage: string,
  finalText: string | undefined,
  outcome?: string,
): Promise<LoopBreakerPlan> {
  const now = ctx.clock.now();
  const inEpisode = Number(card.retry_failures) >= LOOP_BREAKER.failures;
  let failures: number;
  if (inEpisode) {
    failures = Number(card.retry_failures) + 1;
  } else {
    const since = new Date(now.getTime() - LOOP_BREAKER.windowMinutes * 60_000);
    const prior = await one<{ n: number }>(
      tx,
      `SELECT count(*)::int AS n FROM shifts s
        WHERE s.card_id=$1 AND s.status='ended' AND s.outcome = ANY($2) AND s.report_outcome IS NULL AND s.ended_at > $3
          AND s.ended_at > COALESCE((SELECT max(r.ended_at) FROM shifts r WHERE r.card_id=$1 AND r.report_outcome IS NOT NULL),
                                    '-infinity'::timestamptz)`,
      [card.id, FAILED_OUTCOMES, since],
    );
    failures = Number(prior?.n ?? 0) + 1;
    // The second failure is not worth a message of its own: a third one is explained below, a fixed one needs none.
    if (failures < LOOP_BREAKER.failures)
      return { message: failures === 1 ? defaultMessage : null, events: [] };
  }

  const until = new Date(now.getTime() + loopBackoffMinutes(failures) * 60_000);
  const episodeId: string = inEpisode && card.retry_episode_id ? card.retry_episode_id : randomUUID();
  const newEpisode = !inEpisode;
  if (failures >= LOOP_PARK_FAILURES)
    return parkPlan(tx, card, { failures, until, episodeId, newEpisode, finalText, outcome });
  const scope = projectScope(card.org_id, card.project_id);
  const events: AppendInput[] = [
    {
      streamId: streamId.card(card.id),
      event: {
        type: 'CardRetryDeferred',
        payload: { cardId: card.id, until: until.toISOString(), failures, episodeId, newEpisode },
      },
      actor: SYSTEM_ACTOR,
      scope,
    },
  ];
  if (newEpisode) {
    const deskItemId = randomUUID();
    events.push({
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId,
          kind: 'alert',
          subkind: DESK_SUBKIND.loopBackoff,
          title: `${card.ref} keeps failing: ${failures} shifts in ${LOOP_BREAKER.windowMinutes} minutes`,
          body: `The shifts on ${card.ref} (${card.title}) ended without a report ${failures} times, so the dispatcher holds the card back until ${hhmm(until)} and then waits longer after each further failure. Fix the cause (for example a denied tool), or release the back-off on the card page to retry now.${finalText ? `\n\nLast output:\n${finalText}` : ''}`,
          options: [],
          blocking: false,
          pinned: false,
          cardId: card.id,
          projectId: card.project_id,
          affectedCardIds: [card.id],
          askedBy: { kind: 'system' },
        },
      },
      actor: SYSTEM_ACTOR,
      scope,
    });
  }
  // One message when the loop breaker engages; further failures of the episode stay silent.
  const message = newEpisode
    ? `${defaultMessage.split('; the card is back')[0]}. This is failure ${failures} within ${LOOP_BREAKER.windowMinutes} minutes: the card is held back until ${hhmm(until)} and then retried with a longer wait after each failure. A manager can release the back-off from the card page.${finalText ? `\n\n${finalText}` : ''}`
    : null;
  return { message, events };
}

/** Subject key of the one blocking item that parks a crash-looping card. */
export const loopParkSubject = (cardId: string) => `loop-parked:${cardId}`;

/**
 * The episode reached `LOOP_PARK_FAILURES` failed shifts: the card is parked. `CardRetryDeferred` (with `parked: true`,
 * the signal bug intake can hook into) records the count, and one blocking desk item (subkind `loop_parked`, keyed by card)
 * blocks the card so the dispatcher stops claiming it. Answering the item or moving the card back to the queue ends
 * the episode (projections/desk.ts, CardMovedByManager). A stale open item of the card is superseded, never doubled.
 */
async function parkPlan(
  tx: Tx,
  card: Row,
  p: {
    failures: number;
    until: Date;
    episodeId: string;
    newEpisode: boolean;
    finalText: string | undefined;
    outcome: string | undefined;
  },
): Promise<LoopBreakerPlan> {
  const scope = projectScope(card.org_id, card.project_id);
  const subjectKey = loopParkSubject(card.id);
  const events: AppendInput[] = [];
  const stale = await openItemForSubject(tx, card.org_id, subjectKey);
  if (stale)
    events.push({
      streamId: streamId.desk(stale.id),
      event: {
        type: 'DeskItemResolved',
        payload: {
          deskItemId: stale.id,
          resolution: 'acknowledged',
          note: 'The card failed again and is parked on a new item.',
          by: { kind: 'system' },
        },
      },
      actor: SYSTEM_ACTOR,
      scope,
    });
  events.push({
    streamId: streamId.card(card.id),
    event: {
      type: 'CardRetryDeferred',
      payload: {
        cardId: card.id,
        until: p.until.toISOString(),
        failures: p.failures,
        episodeId: p.episodeId,
        newEpisode: p.newEpisode,
        parked: true,
      },
    },
    actor: SYSTEM_ACTOR,
    scope,
  });
  const lastError = (p.finalText ?? '').trim().slice(0, 1500) || (p.outcome ?? 'no output');
  const deskItemId = randomUUID();
  events.push({
    streamId: streamId.desk(deskItemId),
    event: {
      type: 'DeskItemCreated',
      payload: {
        deskItemId,
        kind: 'escalation',
        subkind: DESK_SUBKIND.loopParked,
        title: `${card.ref} is parked: ${p.failures} failed shifts in a row`,
        body: `The shifts on ${card.ref} (${card.title}) ended without a report ${p.failures} times, so the card is parked and the dispatcher no longer claims it.\n\nLast error${p.outcome ? ` (${p.outcome})` : ''}:\n${lastError}\n\nFix the cause (a denied tool, a missing repository or environment, a crashing runtime), then answer this item or move the card back to the queue: the failure count starts again from zero.`,
        options: [],
        blocking: true,
        pinned: true,
        cardId: card.id,
        projectId: card.project_id,
        affectedCardIds: [card.id],
        data: { failures: p.failures, episodeId: p.episodeId, lastOutcome: p.outcome ?? null, lastError },
        askedBy: { kind: 'system' },
        subjectKey,
      },
    },
    actor: SYSTEM_ACTOR,
    scope,
  });
  const message = `${p.failures} shifts in a row ended without a report: the card is parked and the manager was told. It returns to the queue when they answer the desk item or move it back.`;
  return { message, events };
}

/** The open loop-breaker desk alerts of a card (resolved when the manager releases the back-off). */
export async function openLoopAlerts(tx: Tx, cardId: string): Promise<string[]> {
  const r = await tx.query(`SELECT id FROM desk_items WHERE card_id=$1 AND subkind=$2 AND status='open'`, [
    cardId,
    DESK_SUBKIND.loopBackoff,
  ]);
  return r.rows.map((x) => x.id as string);
}

/**
 * A runner turned the shift away for a reason that will not fix itself (the working branch does not exist): the card
 * is held back from the first rejection, 1 min and doubling per further rejection of the episode, capped at 1 h, so
 * the dispatcher does not claim it again every tick. No desk alert of its own: the cause has its own question.
 * A manager releasing the back-off, or fixing the cause, ends the episode.
 */
export function rejectionBackoffEvents(ctx: Ctx, card: Row): AppendInput[] {
  const failures = Number(card.retry_failures ?? 0) + 1;
  const minutes = Math.min(LOOP_BREAKER.capMinutes, LOOP_BREAKER.baseMinutes * 2 ** (failures - 1));
  const until = new Date(ctx.clock.now().getTime() + minutes * 60_000);
  const inEpisode = Number(card.retry_failures ?? 0) > 0 && !!card.retry_episode_id;
  return [
    {
      streamId: streamId.card(card.id),
      event: {
        type: 'CardRetryDeferred',
        payload: {
          cardId: card.id,
          until: until.toISOString(),
          failures,
          episodeId: inEpisode ? card.retry_episode_id : randomUUID(),
          newEpisode: !inEpisode,
        },
      },
      actor: SYSTEM_ACTOR,
      scope: projectScope(card.org_id, card.project_id),
    },
  ];
}

/**
 * The question shifts that count toward the question loop (aliases: shift `s`, its desk item `d`). A shift counts when it
 * ran an agent that answered the item (outcome open or 'reported'), the item was not superseded, and the item was not
 * passed on after the shift started: each routing step (peer, BA, CEO, desk) of one question is its own shift, and the
 * hop is not a second question. Refused shifts (outcome 'rejected', no agent ran) do not count. Only questions an agent
 * asked count: the system's own questions about the card (the stop-loss arbitration, routed to the architect) are not the
 * card asking, and the stop-loss already holds the card. Stop-loss arbitrations (`stop_loss`, raised by the system when the
 * card used its budget) do not count either: the stop-loss is its own guard for that loop.
 */
export const COUNTED_QUESTION_SHIFT_SQL = `s.kind='question' AND (s.outcome IS NULL OR s.outcome='reported')
  AND d.asked_by_kind = 'agent'
  AND d.status <> 'superseded'
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(d.escalation_trail,'[]'::jsonb)) t
                   WHERE t->>'step' IN ('peer','ba','ceo','desk') AND (t->>'at')::timestamptz >= s.started_at)
  AND d.subkind IS DISTINCT FROM '${DESK_SUBKIND.stopLoss}'`;

/** Question shifts (answers given to the agents asked) about one card since `since`, whatever the wording of the questions; see `COUNTED_QUESTION_SHIFT_SQL` for what counts. */
export async function questionShiftCount(db: Queryable, cardId: string, since: Date): Promise<number> {
  const r = await one<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM shifts s JOIN desk_items d ON d.id = s.desk_item_id
      WHERE ${COUNTED_QUESTION_SHIFT_SQL} AND d.card_id=$1 AND s.started_at > $2`,
    [cardId, since],
  );
  return Number(r?.n ?? 0);
}

/**
 * The loop breaker also counts question shifts (a question counts as a report, so the failure count never saw them):
 * `QUESTION_LOOP.shifts` question shifts about one card within `QUESTION_LOOP.windowHours` put the card in back-off
 * with one desk alert per episode, whatever the questions said. Returns the events (none while an alert is open).
 */
export async function questionLoopEvents(ctx: Ctx, tx: Tx, card: Row): Promise<AppendInput[]> {
  const since = new Date(ctx.clock.now().getTime() - QUESTION_LOOP.windowHours * 3600_000);
  const n = await questionShiftCount(tx, card.id, since);
  if (n < QUESTION_LOOP.shifts) return [];
  if ((await openLoopAlerts(tx, card.id)).length > 0) return [];
  const events = rejectionBackoffEvents(ctx, card);
  const deskItemId = randomUUID();
  events.push({
    streamId: streamId.desk(deskItemId),
    event: {
      type: 'DeskItemCreated',
      payload: {
        deskItemId,
        kind: 'alert',
        subkind: DESK_SUBKIND.loopBackoff,
        title: `${card.ref} keeps asking: ${n} question shifts in ${QUESTION_LOOP.windowHours} hours`,
        body: `${card.ref} (${card.title}) caused ${n} question shifts in ${QUESTION_LOOP.windowHours} hours. The questions may differ in wording, but the card is going round: ask, answer, ask again. The dispatcher holds the card back with a growing back-off. Find what the agents are missing (a decision, a dependency, an environment) and say it on the card, or release the back-off on the card page to retry now.`,
        options: [],
        blocking: false,
        pinned: false,
        cardId: card.id,
        projectId: card.project_id,
        affectedCardIds: [card.id],
        askedBy: { kind: 'system' },
      },
    },
    actor: SYSTEM_ACTOR,
    scope: projectScope(card.org_id, card.project_id),
  });
  return events;
}
