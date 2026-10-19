import { streamId } from '@aom/shared';
import { projectScope, SYSTEM_ACTOR } from '../commands/common.ts';
import { exec, one, rows as selectRows } from '../db/sql.ts';
import type { DataMigrationEnv } from './orgs.ts';

/**
 * `design-held-status-2026-10`: a design accepted before its dependencies landed now gives the card the status `held`
 * (it used to stay `queued`, so the CEO and the stuck detectors treated it as work nobody took). Production has cards
 * that were held before that: `design_review.state = 'waiting'`, status `queued`, claim free, a dependency not landed.
 * Each gets one `DesignHoldConfirmed` event by the system actor; the card projector turns it into `held` (and only if
 * the card is still queued and unclaimed with a waiting design, so a replay or a second run changes nothing), and the
 * release step that follows every card event returns it to `queued` when its dependencies have landed meanwhile.
 * A new event rather than a second `DesignHeld` keeps the timeline free of a duplicate "design made before ..." entry.
 * A projection rebuild reproduces the result (the original `DesignHeld` already projects `held`). Recorded once in
 * `data_migrations`, under an advisory lock; a second boot does nothing.
 */
export const DESIGN_HELD_STATUS_MIGRATION = 'design-held-status-2026-10';
const LOCK_ID = 7345;

export interface DesignHeldStatusReport {
  confirmed: Array<{ ref: string }>;
}

export async function migrateDesignHeldStatus(env: DataMigrationEnv): Promise<DesignHeldStatusReport | null> {
  const { pool, store, clock, log } = env;
  const done = () => one(pool, 'SELECT 1 FROM data_migrations WHERE name=$1', [DESIGN_HELD_STATUS_MIGRATION]);
  if (await done()) return null;
  const lock = await pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    if (await done()) return null;
    const legacy = await selectRows<{ id: string; ref: string; org_id: string; project_id: string }>(
      pool,
      `SELECT c.id, c.ref, p.org_id, c.project_id
         FROM cards c JOIN projects p ON p.id = c.project_id
        WHERE c.status = 'queued' AND c.claim_id IS NULL AND c.design_review->>'state' = 'waiting'
          AND EXISTS (SELECT 1 FROM card_dependencies d JOIN cards dc ON dc.id = d.depends_on_card_id
                       WHERE d.card_id = c.id
                         AND NOT (dc.status IN ('done','cancelled') OR dc.merged_into_working_at IS NOT NULL))
        ORDER BY c.number`,
    );
    const report: DesignHeldStatusReport = { confirmed: [] };
    for (const c of legacy) {
      await store.append([
        {
          streamId: streamId.card(c.id),
          event: { type: 'DesignHoldConfirmed', payload: { cardId: c.id } },
          actor: SYSTEM_ACTOR,
          scope: projectScope(c.org_id, c.project_id),
        },
      ]);
      report.confirmed.push({ ref: c.ref });
      log(`${DESIGN_HELD_STATUS_MIGRATION}: ${c.ref} is held until its dependencies landed`);
    }
    await exec(
      pool,
      `INSERT INTO data_migrations (name, completed_at, summary) VALUES ($1,$2,$3)
       ON CONFLICT (name) DO NOTHING`,
      [DESIGN_HELD_STATUS_MIGRATION, clock.now(), JSON.stringify(report)],
    );
    log(`${DESIGN_HELD_STATUS_MIGRATION}: ${report.confirmed.length} held design(s) confirmed`);
    return report;
  } finally {
    try {
      await lock.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    } finally {
      lock.release();
    }
  }
}
