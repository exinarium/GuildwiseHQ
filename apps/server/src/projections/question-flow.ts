import type { EventOf, EventType } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';
import { mutateCard } from './util.ts';

const ev = <T extends EventType>(e: StoredEvent): EventOf<T> => e.event as EventOf<T>;

/** Lean Team v3 (S1a): waiting questions, card affinity and the project's stop-loss budget. */
export const questionFlowProjectors: Record<string, Projector> = {
  // A waiting question ran out of time: it blocks its card now (the claim release follows in the same append).
  QuestionMadeBlocking: async (tx, e) => {
    const p = ev<'QuestionMadeBlocking'>(e).payload;
    await exec(tx, `UPDATE desk_items SET blocking=true, pinned=true, updated_at=$2 WHERE id=$1`, [
      p.deskItemId,
      e.createdAt,
    ]);
    await mutateCard(
      tx,
      e,
      p.cardId,
      () =>
        exec(
          tx,
          `UPDATE cards SET status='blocked', blocked_since=COALESCE(blocked_since, $2), updated_at=$2
            WHERE id=$1 AND status NOT IN ('done','cancelled')`,
          [p.cardId, e.createdAt],
        ),
      { agentId: e.actor.kind === 'agent' ? e.actor.id : null },
    );
    await exec(
      tx,
      'INSERT INTO card_blockers (card_id, desk_item_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [p.cardId, p.deskItemId],
    );
  },

  CardAffinitySet: async (tx, e) => {
    const p = ev<'CardAffinitySet'>(e).payload;
    await exec(
      tx,
      `UPDATE cards SET affinity_agent_id=$2, affinity_session_id=$3, affinity_until=$4, affinity_reason=$5,
              affinity_desk_item_id=$6 WHERE id=$1`,
      [p.cardId, p.agentId, p.sessionId ?? null, p.until, p.reason, p.deskItemId ?? null],
    );
  },

  CardAffinityCleared: async (tx, e) => {
    const p = ev<'CardAffinityCleared'>(e).payload;
    await exec(
      tx,
      `UPDATE cards SET affinity_agent_id=NULL, affinity_session_id=NULL, affinity_until=NULL, affinity_reason=NULL,
              affinity_desk_item_id=NULL WHERE id=$1`,
      [p.cardId],
    );
  },

  ProjectStopLossSet: async (tx, e) => {
    const p = ev<'ProjectStopLossSet'>(e).payload;
    await exec(tx, 'UPDATE projects SET stop_loss=$2::jsonb WHERE id=$1', [
      p.projectId,
      p.settings ? JSON.stringify(p.settings) : null,
    ]);
  },
};
