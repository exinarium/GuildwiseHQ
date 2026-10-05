import { randomUUID } from 'node:crypto';
import { DESK_SUBKIND, LOOP_BREAKER, loopBackoffMinutes, streamId } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one, type Row } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { projectScope, SYSTEM_ACTOR } from './common.ts';

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
 */
export async function loopBreakerPlan(
  ctx: Ctx,
  tx: Tx,
  card: Row,
  defaultMessage: string,
  finalText: string | undefined,
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

/** The open loop-breaker desk alerts of a card (resolved when the manager releases the back-off). */
export async function openLoopAlerts(tx: Tx, cardId: string): Promise<string[]> {
  const r = await tx.query(`SELECT id FROM desk_items WHERE card_id=$1 AND subkind=$2 AND status='open'`, [
    cardId,
    DESK_SUBKIND.loopBackoff,
  ]);
  return r.rows.map((x) => x.id as string);
}
