import { parseArgs } from 'node:util';
import { createClock } from '../src/clock.ts';
import { loadConfig } from '../src/config.ts';
import { formatRestructurePlan, migrateRestructure } from '../src/data-migrations/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { createPool } from '../src/db/pool.ts';
import { PgEventStore } from '../src/eventstore/pg-event-store.ts';
import { buildProjectors } from '../src/projections/index.ts';

/**
 * `pnpm --filter @aom/server restructure:migrate [--dry-run]`: runs (or previews) the data migration
 * `restructure-2026-10` outside boot: every feed project becomes the backing project of an interest, feed schedules
 * become interests, their vault folders move to `interests/<slug>/`. `--dry-run` only reads and prints the plan. The boot
 * hook runs the same migration (idempotent), so this is optional; take a database backup first (docs/DEPLOY.md).
 */
const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false } } });
const config = loadConfig();
const pool = createPool(config.databaseUrl, 2);
try {
  const clock = createClock();
  const store = new PgEventStore(pool, buildProjectors(), clock);
  if (!values['dry-run']) {
    const applied = await migrate(config.databaseUrl, { log: (m) => console.log(m) });
    if (applied.length) console.log(`applied ${applied.length} SQL migration(s)`);
  }
  const report = await migrateRestructure(
    { pool, store, clock, log: (m) => console.log(m) },
    { dryRun: values['dry-run'] },
  );
  console.log(formatRestructurePlan(report.plan));
  if (values['dry-run']) console.log('\nDry run: nothing was written.');
  else
    for (const o of report.orgs) {
      console.log(
        `\nOrganization ${o.orgId}: ${o.feedProjects} feed project(s), ${o.interests} interest(s), ${o.newProjects} new backing project(s), ${o.schedulesRemoved} feed schedule(s) removed, ${o.transcriptsCopied} transcript(s) copied, ${o.vaultMoves} vault folder move(s) queued.`,
      );
      for (const w of o.warnings) console.log(`  warning: ${w}`);
    }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
