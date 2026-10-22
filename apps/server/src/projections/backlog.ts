import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';

const ev = <
  T extends
    | 'BacklogItemAdded'
    | 'BacklogItemEdited'
    | 'BacklogItemFlagged'
    | 'BacklogItemDropped'
    | 'BacklogItemSent'
    | 'BacklogSuggestionsReported',
>(
  e: StoredEvent,
) => e.event as EventOf<T>;

/** Project backlog. Every write uses the event's time, never now(), so a rebuild gives the same rows. */
export const backlogProjectors: Record<string, Projector> = {
  BacklogItemAdded: async (tx, e) => {
    const p = ev<'BacklogItemAdded'>(e).payload;
    const agent = p.source.kind === 'agent' ? p.source : null;
    await exec(
      tx,
      `INSERT INTO backlog_items (id, org_id, project_id, title, description, priority, tags, flagged, status,
         source_kind, source_user_id, source_agent_id, source_agent_name, source_shift_id, source_card_id,
         source_card_ref, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$10,$11,$12,$13,$14,$15,$16,$16)
       ON CONFLICT (id) DO NOTHING`,
      [
        p.itemId,
        e.scope.orgId,
        p.projectId,
        p.title,
        p.description,
        p.priority,
        p.tags,
        p.flagged,
        p.source.kind,
        p.source.kind === 'owner' ? p.source.userId : null,
        agent?.agentId ?? null,
        agent?.agentName ?? null,
        agent?.shiftId ?? null,
        agent?.cardId ?? null,
        agent?.cardRef ?? null,
        e.createdAt,
      ],
    );
  },

  BacklogItemEdited: async (tx, e) => {
    const p = ev<'BacklogItemEdited'>(e).payload;
    await exec(
      tx,
      `UPDATE backlog_items SET title = COALESCE($2, title), description = COALESCE($3, description),
         priority = COALESCE($4, priority), tags = COALESCE($5, tags), updated_at = $6
       WHERE id = $1`,
      [p.itemId, p.title ?? null, p.description ?? null, p.priority ?? null, p.tags ?? null, e.createdAt],
    );
  },

  BacklogItemFlagged: async (tx, e) => {
    const p = ev<'BacklogItemFlagged'>(e).payload;
    await exec(tx, `UPDATE backlog_items SET flagged=$2, updated_at=$3 WHERE id=$1`, [
      p.itemId,
      p.flagged,
      e.createdAt,
    ]);
  },

  BacklogItemDropped: async (tx, e) => {
    const p = ev<'BacklogItemDropped'>(e).payload;
    await exec(tx, `UPDATE backlog_items SET status='dropped', updated_at=$2 WHERE id=$1`, [
      p.itemId,
      e.createdAt,
    ]);
  },

  BacklogItemSent: async (tx, e) => {
    const p = ev<'BacklogItemSent'>(e).payload;
    await exec(
      tx,
      `UPDATE backlog_items SET status='done', card_id=$2, card_ref=$3, updated_at=$4 WHERE id=$1`,
      [p.itemId, p.cardId, p.cardRef, e.createdAt],
    );
  },

  BacklogSuggestionsReported: async (tx, e) => {
    const p = ev<'BacklogSuggestionsReported'>(e).payload;
    await exec(
      tx,
      `UPDATE backlog_items SET reported_desk_item_id=$2, reported_at=$3 WHERE id = ANY($1::uuid[]) AND reported_at IS NULL`,
      [p.itemIds, p.deskItemId, e.createdAt],
    );
  },
};
