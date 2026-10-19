import { graphRepoKey, streamId } from '@aom/shared';
import { projectScope, SYSTEM_ACTOR } from '../commands/common.ts';
import { exec, one, rows as selectRows } from '../db/sql.ts';
import type { DataMigrationEnv } from './orgs.ts';

/**
 * `graph-backfill-2026-10` (docs/design/project-graphs.md section 13, Phase 2): every project that has a repository gets a
 * `ProjectGraphRequested` (the intent, no content). A workstation that holds the clone answers it when it connects
 * (`seedProjectGraphs` queues `graph.index`). Skipped while `projectGraphs.enabled` is off (and not recorded as done, so
 * switching the setting on later runs it). Idempotent; recorded once in `data_migrations`.
 */
export const GRAPH_BACKFILL_MIGRATION = 'graph-backfill-2026-10';
const LOCK_ID = 7347;

export interface GraphBackfillReport {
  requested: number;
}

export async function migrateGraphBackfill(env: DataMigrationEnv): Promise<GraphBackfillReport | null> {
  const { pool, store, clock, log } = env;
  if (env.projectGraphs === false) return null;
  const done = () => one(pool, 'SELECT 1 FROM data_migrations WHERE name=$1', [GRAPH_BACKFILL_MIGRATION]);
  if (await done()) return null;
  const lock = await pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    if (await done()) return null;
    const missing = await selectRows<{ project_id: string; org_id: string; repo_id: string; remote: string }>(
      pool,
      `SELECT pr.project_id, p.org_id, pr.id AS repo_id, pr.remote_url_normalized AS remote
         FROM project_repos pr JOIN projects p ON p.id = pr.project_id AND p.kind = 'project' AND p.status = 'active'
        WHERE pr.removed_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM project_graphs g WHERE g.project_id = pr.project_id AND g.repo_id = pr.id)
        ORDER BY pr.project_id, pr.id`,
    );
    for (const r of missing) {
      await store.append([
        {
          streamId: streamId.project(r.project_id),
          event: {
            type: 'ProjectGraphRequested',
            payload: {
              projectId: r.project_id,
              orgId: r.org_id,
              repoId: r.repo_id,
              repoKey: graphRepoKey(r.remote),
              reason: 'backfill',
            },
          },
          actor: SYSTEM_ACTOR,
          scope: projectScope(r.org_id, r.project_id),
        },
      ]);
    }
    log(`${GRAPH_BACKFILL_MIGRATION}: ${missing.length} repository index request(s) recorded`);
    const report: GraphBackfillReport = { requested: missing.length };
    await exec(
      pool,
      `INSERT INTO data_migrations (name, completed_at, summary) VALUES ($1,$2,$3) ON CONFLICT (name) DO NOTHING`,
      [GRAPH_BACKFILL_MIGRATION, clock.now(), JSON.stringify(report)],
    );
    return report;
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    lock.release();
  }
}
