import { exec, one } from '../db/sql.ts';
import type { DataMigrationEnv } from './orgs.ts';

/**
 * `delegation-explicit-2026-10` (revision R3b): delegation used to be on for the facilitator, the Chair and card, question and
 * BA-task agents, and is now off unless somebody grants a target. Nothing is granted by this migration: every existing agent and
 * session simply has no row in `delegate_grants`, so they stop delegating until a grant is made. What it does is fill the
 * sub-step columns of the delegate cost rows booked before (target, outcome, duration, session), from their events, so the
 * older delegations also show on the card and the session. Idempotent; a rebuild of the projections gives the same result.
 */
export const DELEGATION_EXPLICIT_MIGRATION = 'delegation-explicit-2026-10';

export async function migrateDelegationExplicit(
  env: DataMigrationEnv,
): Promise<{ backfilled: number } | null> {
  const { pool, clock, log } = env;
  if (await one(pool, 'SELECT 1 FROM data_migrations WHERE name=$1', [DELEGATION_EXPLICIT_MIGRATION]))
    return null;
  const r = await pool.query(
    `UPDATE shift_costs sc SET
        delegate_target = e.payload->>'personaKey',
        delegate_target_name = e.payload->>'personaKey',
        delegate_outcome = e.payload->>'outcome',
        delegate_duration_ms = NULLIF(e.payload->>'durationMs','')::int,
        delegate_thread_id = NULLIF(e.payload->>'threadId','')::uuid
       FROM events e
      WHERE sc.kind = 'delegate' AND sc.delegate_target IS NULL
        AND e.type = 'DelegateCompleted' AND e.payload->>'delegateId' = sc.shift_id::text`,
  );
  const report = { backfilled: r.rowCount ?? 0 };
  log(
    `${DELEGATION_EXPLICIT_MIGRATION}: ${report.backfilled} earlier delegations now show as sub-steps; no grants were made`,
  );
  await exec(
    pool,
    `INSERT INTO data_migrations (name, completed_at, summary) VALUES ($1,$2,$3) ON CONFLICT (name) DO NOTHING`,
    [DELEGATION_EXPLICIT_MIGRATION, clock.now(), JSON.stringify(report)],
  );
  return report;
}
