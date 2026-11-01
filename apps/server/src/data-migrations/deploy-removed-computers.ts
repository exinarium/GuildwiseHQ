import { exec, one } from '../db/sql.ts';
import { computerRemovedEvents } from '../delivery/computer-removed.ts';
import type { DataMigrationEnv } from './orgs.ts';

/**
 * `deploy-removed-computers-2026-11`: places (deploy targets) whose deploying computer was unpaired before places carried the
 * "computer removed" mark. Each live place whose `workstation_id` is not an active workstation gets
 * `DeployTargetComputerRemoved`, and an open move that computer was running is cancelled, exactly as an unpair does now.
 * Events only; advisory lock; idempotent (a place already marked is skipped, and the run is recorded once in
 * `data_migrations`). `AOM_DATA_MIGRATIONS=false` skips it with the others.
 */
export const DEPLOY_REMOVED_COMPUTERS_MIGRATION = 'deploy-removed-computers-2026-11';

const LOCK_ID = 7352;

export interface DeployRemovedComputersReport {
  flagged: number;
  movesCancelled: number;
}

export async function migrateDeployRemovedComputers(
  env: DataMigrationEnv,
): Promise<DeployRemovedComputersReport | null> {
  const { pool, store, clock, log } = env;
  if (await one(pool, 'SELECT 1 FROM data_migrations WHERE name=$1', [DEPLOY_REMOVED_COMPUTERS_MIGRATION]))
    return null;
  const lock = await pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    if (await one(pool, 'SELECT 1 FROM data_migrations WHERE name=$1', [DEPLOY_REMOVED_COMPUTERS_MIGRATION]))
      return null;
    const events = await computerRemovedEvents(pool, { now: clock.now() });
    const report: DeployRemovedComputersReport = {
      flagged: events.filter((e) => e.event.type === 'DeployTargetComputerRemoved').length,
      movesCancelled: events.filter((e) => e.event.type === 'DeployTargetMoveCancelled').length,
    };
    if (events.length) await store.append(events);
    log(
      `${DEPLOY_REMOVED_COMPUTERS_MIGRATION}: ${report.flagged} place(s) marked, ${report.movesCancelled} open move(s) cancelled`,
    );
    await exec(
      pool,
      `INSERT INTO data_migrations (name, completed_at, summary) VALUES ($1,$2,$3) ON CONFLICT (name) DO NOTHING`,
      [DEPLOY_REMOVED_COMPUTERS_MIGRATION, clock.now(), JSON.stringify(report)],
    );
    return report;
  } finally {
    try {
      await lock.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    } finally {
      lock.release();
    }
  }
}
