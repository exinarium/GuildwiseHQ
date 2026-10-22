import { DESK_SUBKIND, type EventOf, type EventType } from '@aom/shared';
import { exec, one, rows } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';
import { mutateCard } from './util.ts';

const ev = <T extends EventType>(e: StoredEvent): EventOf<T> => e.event as EventOf<T>;

interface Asker {
  kind: 'agent' | 'user' | 'system';
  agentId?: string | undefined;
  userId?: string | undefined;
  role?: string | undefined;
}

interface NewItem {
  id: string;
  kind: string;
  subkind?: string | undefined;
  projectId?: string | undefined;
  cardId?: string | undefined;
  shiftId?: string | undefined;
  routedTo?: string | undefined;
  routedAgentId?: string | undefined;
  title: string;
  body?: string | undefined;
  doing?: string | undefined;
  options: unknown[];
  recommendation?: string | undefined;
  blocking: boolean;
  affectedCardIds: string[];
  askedBy?: Asker | undefined;
  pinned: boolean;
  dedupLedgerIds?: string[] | undefined;
  triageDeadline?: string | undefined;
  data?: Record<string, unknown> | undefined;
  chatThreadId?: string | undefined;
  addresseeUserId?: string | undefined;
  topic?: string | undefined;
  subjectKey?: string | undefined;
}

async function insertItem(tx: Tx, e: StoredEvent, i: NewItem): Promise<void> {
  const by = i.askedBy ?? { kind: 'system' as const };
  await exec(
    tx,
    `INSERT INTO desk_items (id, org_id, project_id, card_id, kind, subkind, status, routed_to, routed_agent_id, title, body,
       doing, options, recommendation, blocking, affected_card_ids, asked_by_kind, asked_by_agent_id, asked_by_user_id,
       asked_by_role, shift_id, pinned, dedup_ledger_ids, triage, triage_deadline, data, chat_thread_id, created_at, updated_at, addressee_user_id, subject_key,
       topic, stage)
     VALUES ($1,$2,$3,$4,$5,$6,'open',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$27,$28,$29,
             $30, (SELECT stage FROM cards WHERE id = $4))`,
    [
      i.id,
      e.scope.orgId,
      i.projectId ?? null,
      i.cardId ?? null,
      i.kind,
      i.subkind ?? null,
      i.routedTo ?? 'manager',
      i.routedAgentId ?? null,
      i.title,
      i.body ?? '',
      i.doing ?? '',
      JSON.stringify(i.options),
      i.recommendation ?? null,
      i.blocking,
      i.affectedCardIds,
      by.kind,
      by.agentId ?? null,
      by.userId ?? null,
      by.role ?? null,
      i.shiftId ?? null,
      i.pinned,
      i.dedupLedgerIds ?? [],
      i.triageDeadline ? 'pending' : 'none',
      i.triageDeadline ?? null,
      i.data ? JSON.stringify(i.data) : null,
      i.chatThreadId ?? null,
      e.createdAt,
      i.addresseeUserId ?? null,
      i.subjectKey ?? null,
      i.topic ?? null,
    ],
  );
  if (i.blocking && i.cardId) {
    await mutateCard(
      tx,
      e,
      i.cardId,
      () =>
        exec(
          tx,
          `UPDATE cards SET status='blocked', blocked_since=COALESCE(blocked_since, $2), updated_at=$2
            WHERE id=$1 AND status NOT IN ('done','cancelled')`,
          [i.cardId, e.createdAt],
        ),
      { agentId: by.agentId ?? null },
    );
    await exec(
      tx,
      'INSERT INTO card_blockers (card_id, desk_item_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [i.cardId, i.id],
    );
  }
}

/**
 * Returns blocked cards of `itemId` to the queue unless another open item still blocks them. With `keep` (an answer
 * that says "keep it parked until <condition>") the cards stay blocked and the blocker stays: the item is answered, but
 * the card is released only by a person or by the condition (the owner resolves it on the card).
 */
async function unblock(
  tx: Tx,
  e: StoredEvent,
  itemId: string,
  only?: string[],
  keep?: string,
): Promise<void> {
  if (keep) {
    await exec(tx, 'UPDATE desk_items SET keep_blocked_until=$2 WHERE id=$1', [itemId, keep]);
    return;
  }
  const blocked = await rows<{ card_id: string }>(
    tx,
    'SELECT card_id FROM card_blockers WHERE desk_item_id=$1',
    [itemId],
  );
  // Releasing a card the loop breaker, the repeat guard or the stop-loss parked ends its episode: the failure count
  // starts again from zero and the back-off is gone, so the card is not held (or re-parked) straight away.
  const parkedItem = await one(tx, 'SELECT 1 FROM desk_items WHERE id=$1 AND subkind = ANY($2::text[])', [
    itemId,
    [
      DESK_SUBKIND.loopParked,
      DESK_SUBKIND.repeatQuestion,
      DESK_SUBKIND.repeatLoop,
      DESK_SUBKIND.stopLoss,
      DESK_SUBKIND.testerLoop,
    ],
  ]);
  await exec(tx, 'DELETE FROM card_blockers WHERE desk_item_id=$1', [itemId]);
  for (const { card_id } of blocked) {
    if (only && !only.includes(card_id)) continue;
    const other = await one(tx, 'SELECT 1 FROM card_blockers WHERE card_id=$1 LIMIT 1', [card_id]);
    if (other) continue;
    await mutateCard(tx, e, card_id, () =>
      exec(
        tx,
        `UPDATE cards SET status='queued', queued_at=$2, blocked_since=NULL, updated_at=$2
          WHERE id=$1 AND status='blocked'`,
        [card_id, e.createdAt],
      ),
    );
    if (parkedItem)
      await exec(
        tx,
        'UPDATE cards SET retry_after=NULL, retry_failures=0, retry_episode_id=NULL WHERE id=$1',
        [card_id],
      );
  }
}

export const deskProjectors: Record<string, Projector> = {
  QuestionRaised: async (tx, e) => {
    const p = ev<'QuestionRaised'>(e).payload;
    await insertItem(tx, e, {
      id: p.deskItemId,
      kind: 'question',
      subkind: p.subkind,
      projectId: p.projectId,
      cardId: p.cardId,
      shiftId: p.shiftId,
      routedTo: p.routedTo,
      routedAgentId: p.routedAgentId,
      title: p.question,
      doing: p.doing,
      options: p.options,
      recommendation: p.recommendation,
      blocking: p.blocking,
      affectedCardIds: p.affectedCardIds,
      askedBy: p.askedBy,
      pinned: p.pinned,
      dedupLedgerIds: p.dedupLedgerIds,
      triageDeadline: p.triage?.deadline,
      data: p.data,
      addresseeUserId: p.addresseeUserId,
      topic: p.topic,
    });
  },

  DeskItemCreated: async (tx, e) => {
    const p = ev<'DeskItemCreated'>(e).payload;
    await insertItem(tx, e, {
      id: p.deskItemId,
      kind: p.kind,
      subkind: p.subkind,
      projectId: p.projectId,
      cardId: p.cardId,
      title: p.title,
      body: p.body,
      options: p.options,
      recommendation: p.recommendation,
      blocking: p.blocking,
      affectedCardIds: p.affectedCardIds,
      askedBy: p.askedBy,
      pinned: p.pinned,
      triageDeadline: p.triage?.deadline,
      data: p.data,
      chatThreadId: p.chatThreadId,
      addresseeUserId: p.addresseeUserId,
      subjectKey: p.subjectKey,
    });
  },

  DeskItemRepeated: async (tx, e) => {
    const p = ev<'DeskItemRepeated'>(e).payload;
    await exec(
      tx,
      `UPDATE desk_items SET repeat_count=GREATEST(repeat_count, $2), last_repeated_at=$3, updated_at=$3 WHERE id=$1`,
      [p.deskItemId, p.count, e.createdAt],
    );
  },

  QuestionEscalated: async (tx, e) => {
    const p = ev<'QuestionEscalated'>(e).payload;
    await exec(tx, 'UPDATE desk_items SET routed_to=$2, routed_agent_id=$3, updated_at=$4 WHERE id=$1', [
      p.deskItemId,
      p.routedTo,
      p.routedAgentId ?? null,
      e.createdAt,
    ]);
  },

  QuestionAnswered: async (tx, e) => {
    const p = ev<'QuestionAnswered'>(e).payload;
    await exec(
      tx,
      `UPDATE desk_items SET status='answered', answer=$2, answer_option=$3, answered_by=$4, answered_at=$5, updated_at=$5
        WHERE id=$1`,
      [p.deskItemId, p.answer, p.answerOption ?? null, p.answeredBy.userId ?? null, e.createdAt],
    );
    await unblock(tx, e, p.deskItemId, p.unblockedCardIds, p.keepBlockedUntil);
  },

  DeskItemResolved: async (tx, e) => {
    const p = ev<'DeskItemResolved'>(e).payload;
    await exec(
      tx,
      `UPDATE desk_items SET status=$2, answer=$3, answer_option=$4, answered_by=$5, answered_at=$6, updated_at=$6,
              body = COALESCE($7, body)
        WHERE id=$1`,
      [
        p.deskItemId,
        p.resolution === 'dismissed' ? 'dismissed' : 'answered',
        p.note ?? null,
        p.resolution,
        p.by.userId ?? null,
        e.createdAt,
        p.editedBody ?? null,
      ],
    );
    await unblock(tx, e, p.deskItemId);
  },

  // M7: a duplicate question is attached to the open one it matches. The cards it blocks wait on the survivor, so
  // answering that one returns them all to the queue.
  QuestionMerged: async (tx, e) => {
    const p = ev<'QuestionMerged'>(e).payload;
    const dup = await one<{ affected_card_ids: string[]; blocking: boolean; pinned: boolean }>(
      tx,
      'SELECT affected_card_ids, blocking, pinned FROM desk_items WHERE id=$1',
      [p.deskItemId],
    );
    if (!dup) return;
    await exec(tx, `UPDATE desk_items SET status='superseded', merged_into=$3, updated_at=$2 WHERE id=$1`, [
      p.deskItemId,
      e.createdAt,
      p.intoDeskItemId,
    ]);
    await exec(
      tx,
      `UPDATE desk_items SET blocking = blocking OR $3, pinned = pinned OR $4, updated_at=$5,
              affected_card_ids = ARRAY(SELECT DISTINCT x FROM unnest(affected_card_ids || $2::uuid[]) AS x)
        WHERE id=$1`,
      [p.intoDeskItemId, dup.affected_card_ids, dup.blocking, dup.pinned, e.createdAt],
    );
    await exec(
      tx,
      `INSERT INTO card_blockers (card_id, desk_item_id)
         SELECT card_id, $2 FROM card_blockers WHERE desk_item_id=$1 ON CONFLICT DO NOTHING`,
      [p.deskItemId, p.intoDeskItemId],
    );
    await exec(tx, 'DELETE FROM card_blockers WHERE desk_item_id=$1', [p.deskItemId]);
  },

  // A cancelled card no longer needs its questions answered.
  CardCancelled: async (tx, e) => {
    const p = ev<'CardCancelled'>(e).payload;
    await exec(
      tx,
      `UPDATE desk_items SET status='superseded', updated_at=$2 WHERE card_id=$1 AND status='open' AND kind='question'`,
      [p.cardId, e.createdAt],
    );
    await exec(tx, 'DELETE FROM card_blockers WHERE card_id=$1', [p.cardId]);
  },
};
