import { parseArgs } from 'node:util';
import { createClock } from '../src/clock.ts';
import { loadConfig } from '../src/config.ts';
import { formatPlan, migrateOrgs, planOrgMigration } from '../src/data-migrations/index.ts';
import { migrate, withPendingMigrations } from '../src/db/migrate.ts';
import { createPool } from '../src/db/pool.ts';
import { PgEventStore } from '../src/eventstore/pg-event-store.ts';
import { buildProjectors } from '../src/projections/index.ts';

/**
 * `pnpm --filter @aom/server orgs:migrate [--dry-run]`: runs (or previews) the data migration `orgs-2026-10` outside
 * boot: every user becomes the Owner of an organization with their own id. `--dry-run` only reads and prints the plan
 * (pending SQL migrations are applied in a rolled-back transaction first). The boot hook runs the same migration, so this is optional.
 */
const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false } } });
const config = loadConfig();
const pool = createPool(config.databaseUrl, 2);
try {
  const clock = createClock();
  const store = new PgEventStore(pool, buildProjectors(), clock);
  if (values['dry-run']) {
    const { result, pending } = await withPendingMigrations(config.databaseUrl, (db) => planOrgMigration(db));
    if (pending.length)
      console.log(
        `${pending.length} SQL migration(s) pending (${pending.join(', ')}): applied in a rolled-back transaction for this plan.`,
      );
    console.log(formatPlan(result));
    console.log('\nDry run: nothing was written.');
  } else {
    const applied = await migrate(config.databaseUrl, { log: (m) => console.log(m) });
    if (applied.length) console.log(`applied ${applied.length} SQL migration(s)`);
    const report = await migrateOrgs({ pool, store, clock, log: (m) => console.log(m) });
    console.log(`${report.created} organization(s) created, ${report.validated} constraint(s) validated.`);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
