import { migrateBlogLaunch } from './blog-launch.ts';
import { migrateNoPersonal } from './no-personal.ts';
import { type DataMigrationEnv, migrateOrgs } from './orgs.ts';
import { migrateRestructure } from './restructure.ts';

export { BLOG_LAUNCH_MIGRATION, loadLaunchArticles, migrateBlogLaunch } from './blog-launch.ts';
export {
  formatNoPersonalPlan,
  migrateNoPersonal,
  NO_PERSONAL_MIGRATION,
  planNoPersonal,
} from './no-personal.ts';
export { type DataMigrationEnv, formatPlan, migrateOrgs, ORGS_MIGRATION, planOrgMigration } from './orgs.ts';
export {
  formatRestructurePlan,
  migrateRestructure,
  planRestructure,
  RESTRUCTURE_MIGRATION,
} from './restructure.ts';

/**
 * Boot data migrations, run after the SQL migrations and before the dispatcher, scheduler and HTTP listener
 * (docs/design/organizations.md section 2.3). Each is idempotent. `restructure-2026-10` follows `orgs-2026-10`, `no-personal-2026-10` follows `restructure-2026-10`.
 */
export const DATA_MIGRATIONS: Array<{ name: string; run: (env: DataMigrationEnv) => Promise<unknown> }> = [
  { name: 'orgs-2026-10', run: (env) => migrateOrgs(env) },
  { name: 'restructure-2026-10', run: (env) => migrateRestructure(env) },
  { name: 'no-personal-2026-10', run: (env) => migrateNoPersonal(env) },
  { name: 'blog-launch-2026-10', run: (env) => migrateBlogLaunch(env) },
];

export async function runDataMigrations(env: DataMigrationEnv): Promise<void> {
  for (const m of DATA_MIGRATIONS) {
    env.log(`data migration ${m.name}`);
    await m.run(env);
  }
}
