import { type DataMigrationEnv, migrateOrgs } from './orgs.ts';

export { type DataMigrationEnv, formatPlan, migrateOrgs, ORGS_MIGRATION, planOrgMigration } from './orgs.ts';

/**
 * Boot data migrations, run after the SQL migrations and before the dispatcher, scheduler and HTTP listener
 * (docs/design/organizations.md section 2.3). Each is idempotent. The restructure adds its own after `orgs-2026-10`.
 */
export const DATA_MIGRATIONS: Array<{ name: string; run: (env: DataMigrationEnv) => Promise<unknown> }> = [
  { name: 'orgs-2026-10', run: (env) => migrateOrgs(env) },
];

export async function runDataMigrations(env: DataMigrationEnv): Promise<void> {
  for (const m of DATA_MIGRATIONS) {
    env.log(`data migration ${m.name}`);
    await m.run(env);
  }
}
