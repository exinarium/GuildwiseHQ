import { type ComponentRule, streamId } from '@aom/shared';
import { projectScope, SYSTEM_ACTOR } from '../commands/common.ts';
import { exec, one, rows as selectRows } from '../db/sql.ts';
import type { DataMigrationEnv } from './orgs.ts';

/**
 * `guildwisehq-runner-rule-2026-10`: the GuildwiseHQ repository ships with the runner component rule, so its releases
 * bump the runner without manual setup. Only repositories on that remote whose rules are still empty get it (rules the
 * owner already set are kept). The one place the rule is written down. Idempotent; recorded once in `data_migrations`.
 */
export const GUILDWISEHQ_RUNNER_RULE_MIGRATION = 'guildwisehq-runner-rule-2026-10';

const GUILDWISEHQ_REMOTE = 'github.com/exinarium/guildwisehq';
const RUNNER_RULE: ComponentRule = {
  name: 'runner',
  paths: ['apps/runner/**'],
  versionFile: 'apps/runner/src/version.ts',
  pattern: "RUNNER_VERSION = '(.*)'",
};

export async function migrateGuildwiseRunnerRule(
  env: DataMigrationEnv,
): Promise<{ changed: string[] } | null> {
  const { pool, store, clock, log } = env;
  if (await one(pool, 'SELECT 1 FROM data_migrations WHERE name=$1', [GUILDWISEHQ_RUNNER_RULE_MIGRATION]))
    return null;
  const report = { changed: [] as string[] };
  const repos = await selectRows<{ id: string; project_id: string; org_id: string }>(
    pool,
    `SELECT pr.id, pr.project_id, p.org_id
       FROM project_repos pr JOIN projects p ON p.id = pr.project_id
      WHERE pr.remote_url_normalized = $1 AND pr.removed_at IS NULL AND pr.component_rules = '[]'::jsonb
      ORDER BY pr.id`,
    [GUILDWISEHQ_REMOTE],
  );
  for (const r of repos) {
    await store.append([
      {
        streamId: streamId.project(r.project_id),
        event: {
          type: 'ProjectRepoComponentRulesSet',
          payload: { projectId: r.project_id, repoId: r.id, rules: [RUNNER_RULE] },
        },
        actor: SYSTEM_ACTOR,
        scope: projectScope(r.org_id, r.project_id),
      },
    ]);
    report.changed.push(r.id);
    log(`${GUILDWISEHQ_RUNNER_RULE_MIGRATION}: ${r.id} got the runner rule`);
  }
  await exec(
    pool,
    `INSERT INTO data_migrations (name, completed_at, summary) VALUES ($1,$2,$3) ON CONFLICT (name) DO NOTHING`,
    [GUILDWISEHQ_RUNNER_RULE_MIGRATION, clock.now(), JSON.stringify(report)],
  );
  return report;
}
