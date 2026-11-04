import { SYSTEM_ACTOR } from '../commands/common.ts';
import { devopsRetireEvents } from '../commands/devops-retire.ts';
import { exec, one, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import type { DataMigrationEnv } from './orgs.ts';

/**
 * `orphaned-devops-2026-11`: DevOps engineers that are still active on a workstation that is unpaired or gone (before
 * unpairing retired them). Retired with the same builder the unpair uses (history kept, `AgentRetired` with reason
 * `orphaned_migration`). Selects on the workstation's status, never on `connected`: a paired but offline workstation is
 * not touched. Advisory lock; idempotent (a second run finds no active orphan).
 */
export const ORPHANED_DEVOPS_MIGRATION = 'orphaned-devops-2026-11';

const LOCK_ID = 7353;

export interface OrphanedDevopsReport {
  retired: number;
}

export async function migrateOrphanedDevops(env: DataMigrationEnv): Promise<OrphanedDevopsReport | null> {
  const { pool, store, clock, log } = env;
  if (await one(pool, 'SELECT 1 FROM data_migrations WHERE name=$1', [ORPHANED_DEVOPS_MIGRATION]))
    return null;
  const lock = await pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    if (await one(pool, 'SELECT 1 FROM data_migrations WHERE name=$1', [ORPHANED_DEVOPS_MIGRATION]))
      return null;
    const orphans = await rows(
      pool,
      `SELECT a.id, a.org_id, a.name, a.workstation_id, a.hired_by_user_id, w.user_id AS ws_user_id
         FROM agents a LEFT JOIN workstations w ON w.id = a.workstation_id
        WHERE a.is_devops AND a.status = 'active' AND a.workstation_id IS NOT NULL
          AND (w.id IS NULL OR w.status <> 'active')
        ORDER BY a.workstation_id, a.hired_at, a.id`,
    );
    const byStation = new Map<string, typeof orphans>();
    for (const a of orphans) byStation.set(a.workstation_id, [...(byStation.get(a.workstation_id) ?? []), a]);
    let retired = 0;
    let skipped = 0;
    for (const agents of byStation.values()) {
      const by =
        (agents[0]?.ws_user_id as string | null) ??
        (agents.find((a) => a.hired_by_user_id)?.hired_by_user_id as string | undefined) ??
        (
          await one(
            pool,
            `SELECT user_id FROM org_members WHERE org_id=$1 AND status='active' ORDER BY (role='owner') DESC, user_id LIMIT 1`,
            [agents[0]?.org_id],
          )
        )?.user_id;
      if (!by) {
        // Nobody to record as the actor: leave these active and do not mark the migration done, so a later boot retries.
        skipped += agents.length;
        log(
          `${ORPHANED_DEVOPS_MIGRATION}: no user found for workstation ${agents[0]?.workstation_id}, skipped agents ${agents.map((a) => a.id).join(', ')}`,
        );
        continue;
      }
      await withAppendTx(pool, async (tx) => {
        const events = await devopsRetireEvents(tx, {
          agents,
          reason: 'orphaned_migration',
          actor: SYSTEM_ACTOR,
          by,
        });
        if (events.length) await store.append(events, { tx });
      });
      retired += agents.length;
    }
    const report: OrphanedDevopsReport = { retired };
    log(`${ORPHANED_DEVOPS_MIGRATION}: ${retired} orphaned DevOps engineer(s) retired`);
    if (skipped > 0) return report;
    await exec(
      pool,
      `INSERT INTO data_migrations (name, completed_at, summary) VALUES ($1,$2,$3) ON CONFLICT (name) DO NOTHING`,
      [ORPHANED_DEVOPS_MIGRATION, clock.now(), JSON.stringify(report)],
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
