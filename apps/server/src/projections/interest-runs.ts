import type { EventOf, EventType } from '@aom/shared';
import { exec, one } from '../db/sql.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';

/**
 * The run log of an interest (docs/design/restructure.md section 3.4): `interest_runs` is written by the run's own
 * events and follows the card's events through its `cards.interest_run_id`. Deterministic: every value comes from the
 * event or from rows an earlier event wrote.
 */

const ev = <T extends EventType>(e: StoredEvent): EventOf<T> => e.event as EventOf<T>;

const STAGE_STATUS: Record<string, string> = {
  scan: 'scanning',
  curate: 'curating',
  research: 'researching',
  factcheck: 'checking',
};
const OPEN = ['queued', 'scanning', 'curating', 'researching', 'checking', 'failed'];

async function runOfCard(tx: Parameters<Projector>[0], cardId: string): Promise<string | null> {
  const r = await one<{ interest_run_id: string | null }>(
    tx,
    'SELECT interest_run_id FROM cards WHERE id=$1',
    [cardId],
  );
  return r?.interest_run_id ?? null;
}

/** Moves an unfinished run to `status`. */
async function setOpenStatus(tx: Parameters<Projector>[0], cardId: string, status: string): Promise<void> {
  const run = await runOfCard(tx, cardId);
  if (!run) return;
  await exec(tx, `UPDATE interest_runs SET status=$2 WHERE id=$1 AND status = ANY($3::text[])`, [
    run,
    status,
    OPEN,
  ]);
}

export const interestRunProjectors: Record<string, Projector> = {
  InterestRunStarted: async (tx, e) => {
    const p = ev<'InterestRunStarted'>(e).payload;
    const i = await one<{ org_id: string }>(tx, 'SELECT org_id FROM interests WHERE id=$1', [p.interestId]);
    await exec(
      tx,
      `INSERT INTO interest_runs (id, interest_id, org_id, kind, trigger, card_id, parent_run_id, status, started_by, started_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9) ON CONFLICT (id) DO NOTHING`,
      [
        p.runId,
        p.interestId,
        i?.org_id ?? e.scope.orgId,
        p.kind,
        p.trigger,
        p.cardId,
        p.parentRunId ?? null,
        p.startedBy ?? null,
        e.createdAt,
      ],
    );
    await exec(
      tx,
      `UPDATE interests SET fail_count = 0, last_error = NULL,
              next_scan_at = CASE WHEN $2::boolean THEN $3::timestamptz ELSE next_scan_at END
        WHERE id=$1`,
      [p.interestId, p.nextScanAt !== undefined, p.nextScanAt ?? null],
    );
  },
  InterestRunFailed: async (tx, e) => {
    const p = ev<'InterestRunFailed'>(e).payload;
    await exec(
      tx,
      `UPDATE interests SET fail_count = CASE WHEN $2::boolean THEN $3 ELSE fail_count END,
              last_error = $4, next_scan_at = $5, failure_desk_item_id = COALESCE($6, failure_desk_item_id)
        WHERE id=$1`,
      [p.interestId, p.counted, p.attempts, p.error, p.nextScanAt, p.deskItemId ?? null],
    );
  },
  InterestRunDone: async (tx, e) => {
    const p = ev<'InterestRunDone'>(e).payload;
    await exec(
      tx,
      `UPDATE interest_runs SET status=$2, found=COALESCE($3, found), published=$4, duplicates_dropped=$5,
              over_max_dropped=$6, finished_at=$7 WHERE id=$1`,
      [
        p.runId,
        p.status,
        p.found ?? null,
        p.published,
        p.duplicatesDropped,
        p.overMaximumDropped,
        e.createdAt,
      ],
    );
  },
  CardClaimed: async (tx, e) => {
    const p = ev<'CardClaimed'>(e).payload;
    const status = STAGE_STATUS[p.stage];
    if (status) await setOpenStatus(tx, p.cardId, status);
  },
  StageCompleted: async (tx, e) => {
    const p = ev<'StageCompleted'>(e).payload;
    const status = STAGE_STATUS[p.toStage];
    if (status) await setOpenStatus(tx, p.cardId, status);
  },
  HandoffWritten: async (tx, e) => {
    const p = ev<'HandoffWritten'>(e).payload;
    if (p.stage !== 'scan') return;
    const items = (p.data as { items?: unknown }).items;
    const run = await runOfCard(tx, p.cardId);
    if (run && Array.isArray(items))
      await exec(tx, 'UPDATE interest_runs SET found=$2 WHERE id=$1', [run, items.length]);
  },
  CardRetryDeferred: async (tx, e) => {
    const p = ev<'CardRetryDeferred'>(e).payload;
    if (!p.newEpisode) return;
    const run = await runOfCard(tx, p.cardId);
    if (run)
      await exec(tx, `UPDATE interest_runs SET status='failed' WHERE id=$1 AND status = ANY($2::text[])`, [
        run,
        OPEN,
      ]);
  },
  CardCancelled: async (tx, e) => {
    const p = ev<'CardCancelled'>(e).payload;
    const run = await runOfCard(tx, p.cardId);
    if (run)
      await exec(
        tx,
        `UPDATE interest_runs SET status='cancelled', finished_at=$3 WHERE id=$1 AND status = ANY($2::text[])`,
        [run, OPEN, e.createdAt],
      );
  },
  CardMovedByManager: async (tx, e) => {
    const p = ev<'CardMovedByManager'>(e).payload;
    const run = await runOfCard(tx, p.cardId);
    if (!run) return;
    if (p.status === 'done')
      await exec(
        tx,
        `UPDATE interest_runs SET status='nothing', finished_at=$3 WHERE id=$1 AND status = ANY($2::text[])`,
        [run, OPEN, e.createdAt],
      );
    else {
      const status = STAGE_STATUS[p.toStage];
      if (status) await setOpenStatus(tx, p.cardId, status);
    }
  },
  /** A research run is published with its note (`InterestRunDone` is appended with it for the schedule trigger). */
  ResearchPublished: async (tx, e) => {
    const p = ev<'ResearchPublished'>(e).payload;
    const run = await runOfCard(tx, p.cardId);
    if (run)
      await exec(
        tx,
        `UPDATE interest_runs SET status='published', published=COALESCE(published,0)+1, finished_at=$2 WHERE id=$1`,
        [run, e.createdAt],
      );
  },
  InterestDigestDelivered: async (tx, e) => {
    const p = ev<'InterestDigestDelivered'>(e).payload;
    const i = await one<{ org_id: string }>(tx, 'SELECT org_id FROM interests WHERE id=$1', [p.interestId]);
    if (p.itemIds.length > 0) {
      await exec(
        tx,
        `UPDATE digest_items SET delivered_at=$2, desk_item_id=COALESCE($3, desk_item_id) WHERE id = ANY($1::uuid[])`,
        [p.itemIds, e.createdAt, p.deskItemId ?? null],
      );
      await exec(
        tx,
        `INSERT INTO interest_deliveries (id, interest_id, org_id, at, item_count, held_back, trigger, desk_item_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
        [
          p.deliveryId,
          p.interestId,
          i?.org_id ?? e.scope.orgId,
          e.createdAt,
          p.itemIds.length,
          p.heldBack,
          p.trigger,
          p.deskItemId ?? null,
        ],
      );
    }
    await exec(
      tx,
      `UPDATE interests SET next_delivery_at=$2, last_delivered_at = CASE WHEN $3::boolean THEN $4::timestamptz ELSE last_delivered_at END
        WHERE id=$1`,
      [p.interestId, p.nextDeliveryAt, p.itemIds.length > 0, e.createdAt],
    );
  },
};
