import { streamId } from '@aom/shared';
import { projectScope, SYSTEM_ACTOR } from '../commands/common.ts';
import { exec, one, rows as selectRows } from '../db/sql.ts';
import type { DataMigrationEnv } from './orgs.ts';

/**
 * `project-vaults-2026-10` (docs/design/project-graphs.md section 3): every project always has a vault. Projects that
 * have none get a `ProjectVaultEnsureRequested` (the intent, no content). The Org Owner's primary workstation answers it
 * when it connects: the server registers a `local` vault bound to that workstation and the runner creates the folder
 * (`ensureProjectVaultsForWorkstation`). Until then the project's shifts and its graph use the organization vault, as
 * before. Does nothing while `projectGraphs.enabled` is off, and then it is not recorded as done, so switching the
 * setting on later runs it. Idempotent; recorded once in `data_migrations`.
 */
export const PROJECT_VAULTS_MIGRATION = 'project-vaults-2026-10';
const LOCK_ID = 7346;

export interface ProjectVaultsReport {
  requested: string[];
}

export async function migrateProjectVaults(env: DataMigrationEnv): Promise<ProjectVaultsReport | null> {
  const { pool, store, clock, log } = env;
  if (env.projectGraphs === false) return null;
  const done = () => one(pool, 'SELECT 1 FROM data_migrations WHERE name=$1', [PROJECT_VAULTS_MIGRATION]);
  if (await done()) return null;
  const lock = await pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    if (await done()) return null;
    const missing = await selectRows<{ id: string; org_id: string; key: string }>(
      pool,
      `SELECT p.id, p.org_id, p.key FROM projects p
        WHERE p.kind = 'project' AND NOT EXISTS (SELECT 1 FROM vaults v WHERE v.project_id = p.id)
        ORDER BY p.created_at, p.id`,
    );
    const report: ProjectVaultsReport = { requested: [] };
    for (const p of missing) {
      await store.append([
        {
          streamId: streamId.project(p.id),
          event: {
            type: 'ProjectVaultEnsureRequested',
            payload: { projectId: p.id, orgId: p.org_id, reason: 'migration' },
          },
          actor: SYSTEM_ACTOR,
          scope: projectScope(p.org_id, p.id),
        },
      ]);
      report.requested.push(p.key);
      log(`${PROJECT_VAULTS_MIGRATION}: ${p.key} will get a vault when the owner's workstation connects`);
    }
    await exec(
      pool,
      `INSERT INTO data_migrations (name, completed_at, summary) VALUES ($1,$2,$3) ON CONFLICT (name) DO NOTHING`,
      [PROJECT_VAULTS_MIGRATION, clock.now(), JSON.stringify(report)],
    );
    return report;
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    lock.release();
  }
}
