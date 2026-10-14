import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';

const ev = <
  T extends
    | 'IntakeBatchCreated'
    | 'IntakeBatchItemLinked'
    | 'IntakeBatchItemWaiting'
    | 'IntakeBatchItemRequeued'
    | 'IntakeBatchItemResolved'
    | 'IntakeBatchCancelled',
>(
  e: StoredEvent,
) => e.event as EventOf<T>;

/** Batch intake (#63). The task lifecycle events (`BaTask*`) also move items: see the phase projectors. */
export const intakeBatchProjectors: Record<string, Projector> = {
  IntakeBatchCreated: async (tx, e) => {
    const p = ev<'IntakeBatchCreated'>(e).payload;
    await exec(
      tx,
      `INSERT INTO intake_batches (id, org_id, created_by, project_id, note, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [p.batchId, e.scope.orgId, p.createdBy, p.projectId ?? null, p.note ?? null, e.createdAt],
    );
    for (const i of p.items)
      await exec(
        tx,
        `INSERT INTO intake_batch_items (id, batch_id, position, external_system, external_key, url, status, task_id,
           card_refs, reason, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
        [
          i.itemId,
          p.batchId,
          i.position,
          i.system,
          i.key,
          i.url ?? null,
          i.skipReason ? 'skipped' : 'queued',
          i.taskId ?? null,
          i.existingCardRefs ?? [],
          i.skipReason ?? null,
          e.createdAt,
        ],
      );
  },

  IntakeBatchItemLinked: async (tx, e) => {
    const p = ev<'IntakeBatchItemLinked'>(e).payload;
    await exec(tx, `UPDATE intake_batch_items SET intake_id=$2, updated_at=$3 WHERE id=$1`, [
      p.itemId,
      p.intakeId,
      e.createdAt,
    ]);
  },

  IntakeBatchItemWaiting: async (tx, e) => {
    const p = ev<'IntakeBatchItemWaiting'>(e).payload;
    await exec(
      tx,
      `UPDATE intake_batch_items SET status='waiting', desk_item_id=$2, question=$3,
         qa = qa || jsonb_build_array(jsonb_build_object('question', $3::text, 'answer', NULL)), updated_at=$4
       WHERE id=$1`,
      [p.itemId, p.deskItemId, p.question, e.createdAt],
    );
  },

  IntakeBatchItemRequeued: async (tx, e) => {
    const p = ev<'IntakeBatchItemRequeued'>(e).payload;
    // The answer goes onto the last open question of the item.
    await exec(
      tx,
      `UPDATE intake_batch_items SET status='queued', task_id=$2, desk_item_id=NULL, question=NULL, reason=NULL,
         attempts = attempts + CASE WHEN $3::text = 'retry' THEN 1 ELSE 0 END,
         qa = CASE WHEN $4::text IS NULL OR jsonb_array_length(qa) = 0 THEN qa
                   ELSE jsonb_set(qa, ARRAY[(jsonb_array_length(qa) - 1)::text, 'answer'], to_jsonb($4::text)) END,
         updated_at=$5
       WHERE id=$1`,
      [p.itemId, p.taskId, p.reason, p.answer ?? null, e.createdAt],
    );
  },

  IntakeBatchItemResolved: async (tx, e) => {
    const p = ev<'IntakeBatchItemResolved'>(e).payload;
    await exec(
      tx,
      `UPDATE intake_batch_items SET status=$2,
         card_refs = CASE WHEN cardinality($3::text[]) > 0 THEN $3::text[] ELSE card_refs END,
         summary=COALESCE($4, summary), reason=$5, desk_item_id=NULL, question=NULL, updated_at=$6
       WHERE id=$1`,
      [p.itemId, p.outcome, p.cardRefs, p.summary ?? null, p.reason ?? null, e.createdAt],
    );
  },

  IntakeBatchCancelled: async (tx, e) => {
    const p = ev<'IntakeBatchCancelled'>(e).payload;
    await exec(tx, `UPDATE intake_batches SET cancelled_at=$2 WHERE id=$1`, [p.batchId, e.createdAt]);
    await exec(
      tx,
      `UPDATE intake_batch_items SET status='cancelled', reason='the batch was cancelled', updated_at=$2
        WHERE batch_id=$1 AND status IN ('queued','waiting')`,
      [p.batchId, e.createdAt],
    );
  },
};
