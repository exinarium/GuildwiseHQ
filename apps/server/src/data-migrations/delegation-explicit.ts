import { one } from '../db/sql.ts';
import { withTx } from '../db/tx.ts';
import type { DataMigrationEnv } from './orgs.ts';

/**
 * `delegation-explicit-2026-10` (revision R3b): delegation used to be on for the facilitator, the Chair and card, question and
 * BA-task agents, and is now off unless somebody grants a target. Nothing is granted by this migration: every existing agent and
 * session simply has no row in `delegate_grants`, so they stop delegating until a grant is made. What it does is fill the
 * sub-step columns of the delegate cost rows booked before (target, outcome, duration, session), from their events, so the
 * older delegations also show on the card and the session. Idempotent; a rebuild of the projections gives the same result.
 */
export const DELEGATION_EXPLICIT_MIGRATION = 'delegation-explicit-2026-10';

/** Found by stream (`delegate-<id>`), so the unique (stream_id, stream_version) index serves every row. */
export const BACKFILL_SQL = `UPDATE shift_costs sc SET
          delegate_target = e.payload->>'personaKey',
          delegate_target_name = e.payload->>'personaKey',
          delegate_outcome = e.payload->>'outcome',
          delegate_duration_ms = NULLIF(e.payload->>'durationMs','')::int,
          delegate_thread_id = NULLIF(e.payload->>'threadId','')::uuid
         FROM events e
        WHERE sc.kind = 'delegate' AND sc.delegate_target IS NULL
          AND e.stream_id = 'delegate-' || sc.shift_id::text
          AND e.type = 'DelegateCompleted'`;

export async function migrateDelegationExplicit(
  env: DataMigrationEnv,
): Promise<{ backfilled: number } | null> {
  const { pool, clock, log } = env;
  if (await one(pool, 'SELECT 1 FROM data_migrations WHERE name=$1', [DELEGATION_EXPLICIT_MIGRATION]))
    return null;
  // One transaction: the backfill and the marker stand or fall together (a crash between them would redo the work, harmlessly, but
  // never leave a marker without the backfill). The events are found by their stream (`delegate-<id>`, the unique
  // (stream_id, stream_version) index), not by an expression over every event's payload, which would scan the whole log once per row.
  const report = await withTx(pool, async (tx) => {
    const r = await tx.query(BACKFILL_SQL);
    await tx.query(
      `INSERT INTO data_migrations (name, completed_at, summary) VALUES ($1,$2,$3) ON CONFLICT (name) DO NOTHING`,
      [DELEGATION_EXPLICIT_MIGRATION, clock.now(), JSON.stringify({ backfilled: r.rowCount ?? 0 })],
    );
    return { backfilled: r.rowCount ?? 0 };
  });
  log(
    `${DELEGATION_EXPLICIT_MIGRATION}: ${report.backfilled} earlier delegations now show as sub-steps; no grants were made`,
  );
  return report;
}
