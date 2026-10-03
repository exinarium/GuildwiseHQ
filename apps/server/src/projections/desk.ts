import type { EventOf, EventType } from '@aom/shared';
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
}

async function insertItem(tx: Tx, e: StoredEvent, i: NewItem): Promise<void> {
  const by = i.askedBy ?? { kind: 'system' as const };
  await exec(
    tx,
    `INSERT INTO desk_items (id, org_id, project_id, card_id, kind, subkind, status, routed_to, routed_agent_id, title, body,
       doing, options, recommendation, blocking, affected_card_ids, asked_by_kind, asked_by_agent_id, asked_by_user_id,
       asked_by_role, shift_id, pinned, dedup_ledger_ids, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'open',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$23)`,
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
      e.createdAt,
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

/** Returns blocked cards of `itemId` to the queue unless another open item still blocks them. */
async function unblock(tx: Tx, e: StoredEvent, itemId: string, only?: string[]): Promise<void> {
  const blocked = await rows<{ card_id: string }>(
    tx,
    'SELECT card_id FROM card_blockers WHERE desk_item_id=$1',
    [itemId],
  );
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
  }
}

export const deskProjectors: Record<string, Projector> = {
  QuestionRaised: async (tx, e) => {
    const p = ev<'QuestionRaised'>(e).payload;
    await insertItem(tx, e, {
      id: p.deskItemId,
      kind: 'question',
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
    });
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
    await unblock(tx, e, p.deskItemId, p.unblockedCardIds);
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
