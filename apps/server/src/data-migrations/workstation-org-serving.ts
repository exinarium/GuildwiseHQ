import { servingEvent } from '../commands/workstation-serving.ts';
import { exec, one, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import type { DataMigrationEnv } from './orgs.ts';

/**
 * `workstation-org-serving-2026-11` (R9, audit F4): before 1.10.0 every real workstation worked for every organization
 * its user belonged to. From 1.10.0 a workstation works only for organizations with a serving row, so existing pairs
 * get one (`WorkstationOrgServingSet` reason `existing`) only where consent is evident:
 * - the workstation's user owns the organization, or
 * - an active agent of that organization other than a DevOps engineer already sits on the workstation (someone placed
 *   it there; the DevOps engineer was the automatic hire that F4 is about, so it does not count).
 * Every other pair stays off; its user switches it on under "Works for". Runs before the dispatcher (boot order of
 * `DATA_MIGRATIONS`). Idempotent: a pair that already has a row is never touched; a second run finds nothing.
 */
export const WORKSTATION_ORG_SERVING_MIGRATION = 'workstation-org-serving-2026-11';

const LOCK_ID = 7355;

export interface WorkstationOrgServingReport {
  workstations: number;
  owned: number;
  agents: number;
}

export async function migrateWorkstationOrgServing(
  env: DataMigrationEnv,
): Promise<WorkstationOrgServingReport | null> {
  const { pool, store, clock, log } = env;
  if (await one(pool, 'SELECT 1 FROM data_migrations WHERE name=$1', [WORKSTATION_ORG_SERVING_MIGRATION]))
    return null;
  const lock = await pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    if (await one(pool, 'SELECT 1 FROM data_migrations WHERE name=$1', [WORKSTATION_ORG_SERVING_MIGRATION]))
      return null;
    const pairs = await rows<{ ws_id: string; user_id: string; org_id: string; owned: boolean }>(
      pool,
      `SELECT w.id AS ws_id, w.user_id, o.id AS org_id, (o.owner_user_id = w.user_id) AS owned
         FROM workstations w
         JOIN organizations o ON NOT o.simulation
          AND (o.owner_user_id = w.user_id
               OR EXISTS (SELECT 1 FROM agents a WHERE a.workstation_id = w.id AND a.org_id = o.id
                                                   AND a.status = 'active' AND NOT a.is_devops))
        WHERE w.status = 'active' AND w.simulation_org_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM workstation_org_serving s WHERE s.workstation_id = w.id AND s.org_id = o.id)
        ORDER BY w.paired_at, w.id, o.created_at, o.id`,
    );
    const byStation = new Map<string, typeof pairs>();
    for (const p of pairs) byStation.set(p.ws_id, [...(byStation.get(p.ws_id) ?? []), p]);
    for (const list of byStation.values())
      await withAppendTx(pool, (tx) =>
        store.append(
          list.map((p) =>
            servingEvent(
              { workstationId: p.ws_id, orgId: p.org_id, serving: true, by: null, reason: 'existing' },
              p.user_id,
            ),
          ),
          { tx },
        ),
      );
    const report: WorkstationOrgServingReport = {
      workstations: byStation.size,
      owned: pairs.filter((p) => p.owned).length,
      agents: pairs.filter((p) => !p.owned).length,
    };
    log(
      `${WORKSTATION_ORG_SERVING_MIGRATION}: ${pairs.length} pair(s) switched on on ${report.workstations} workstation(s): ${report.owned} owned, ${report.agents} with agents placed there; every other pair stays off`,
    );
    await exec(
      pool,
      `INSERT INTO data_migrations (name, completed_at, summary) VALUES ($1,$2,$3) ON CONFLICT (name) DO NOTHING`,
      [WORKSTATION_ORG_SERVING_MIGRATION, clock.now(), JSON.stringify(report)],
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
