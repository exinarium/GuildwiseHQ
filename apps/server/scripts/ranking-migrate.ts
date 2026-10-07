import { parseArgs } from 'node:util';
import { createClock } from '../src/clock.ts';
import { loadConfig } from '../src/config.ts';
import { formatNoPersonalPlan, migrateNoPersonal, planNoPersonal } from '../src/data-migrations/index.ts';
import { migrate, withPendingMigrations } from '../src/db/migrate.ts';
import { createPool } from '../src/db/pool.ts';
import { PgEventStore } from '../src/eventstore/pg-event-store.ts';
import { buildProjectors } from '../src/projections/index.ts';

/**
 * `pnpm --filter @aom/server ranking:migrate [--dry-run]`: runs (or previews) the data migration `no-personal-2026-10`
 * outside boot: the work/personal domain is gone, so the projects of every organization are ranked (personal projects
 * below the work projects, in their old tier order), the personal vault is merged into the organization vault under
 * `personal/` and the Owner gets a desk note. `--dry-run` applies the pending SQL migrations in a transaction that is
 * rolled back, reads the plan from that migrated schema and writes nothing. The boot hook runs the same migration
 * (idempotent), so this is optional; take a database backup and a copy of the vault repositories first (docs/DEPLOY.md).
 */
const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false } } });
const config = loadConfig();
const pool = createPool(config.databaseUrl, 2);
try {
  const clock = createClock();
  const store = new PgEventStore(pool, buildProjectors(), clock);
  if (values['dry-run']) {
    const { result, pending } = await withPendingMigrations(config.databaseUrl, (db) => planNoPersonal(db));
    if (pending.length)
      console.log(
        `${pending.length} SQL migration(s) pending (${pending.join(', ')}): applied in a rolled-back transaction for this plan.`,
      );
    const done = await pool
      .query(`SELECT name FROM data_migrations WHERE name IN ('orgs-2026-10','restructure-2026-10')`)
      .catch(() => null);
    if ((done?.rowCount ?? 0) < 2)
      console.log(
        'Note: orgs-2026-10 and restructure-2026-10 have not both run yet; run orgs:migrate and restructure:migrate first for a complete plan.',
      );
    console.log(formatNoPersonalPlan(result));
    console.log('\nDry run: nothing was written.');
  } else {
    const applied = await migrate(config.databaseUrl, { log: (m) => console.log(m) });
    if (applied.length) console.log(`applied ${applied.length} SQL migration(s)`);
    const report = await migrateNoPersonal({ pool, store, clock, log: (m) => console.log(m) });
    console.log(formatNoPersonalPlan(report.plan));
    for (const o of report.orgs) {
      console.log(
        `\nOrganization ${o.orgId}: ${o.ranked} project(s) ranked (${o.personalProjects} personal), vault: ${o.vault}, ${o.liftedInterests} interest folder(s) kept.`,
      );
      for (const w of o.warnings) console.log(`  warning: ${w}`);
    }
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
