import { parseArgs } from 'node:util';
import { applyImport, BundleRefused, formatPlan, loadBundle, planImport } from '../src/blog/bundle/import.ts';
import { createClock } from '../src/clock.ts';
import { loadConfig } from '../src/config.ts';
import { migrate } from '../src/db/migrate.ts';
import { createPool } from '../src/db/pool.ts';
import { PgEventStore } from '../src/eventstore/pg-event-store.ts';
import { buildProjectors } from '../src/projections/index.ts';

/**
 * `node dist/blog-bundle-import.mjs --bundle <dir> --author <super admin email> [--apply]`: loads a reviewed article
 * carry-over bundle (docs/SELF-HOSTING.md). Without `--apply` it is a dry run that writes nothing. Any conflict writes
 * nothing and exits 1; a second run finds everything present and writes nothing. No route serves this.
 */
const { values } = parseArgs({
  options: {
    bundle: { type: 'string' },
    author: { type: 'string' },
    apply: { type: 'boolean', default: false },
  },
});
if (!values.bundle || !values.author) {
  console.error('usage: blog-bundle-import --bundle <dir> --author <super admin email> [--apply]');
  process.exit(2);
}
const config = loadConfig();
let bundle: ReturnType<typeof loadBundle>;
try {
  bundle = loadBundle(values.bundle);
} catch (e) {
  console.error(e instanceof BundleRefused ? `refused: ${e.message}` : (e as Error).message);
  process.exit(1);
}
if (values.apply) await migrate(config.databaseUrl);
const pool = createPool(config.databaseUrl, 2);
try {
  if (!values.apply) {
    const plan = await planImport(pool, bundle, values.author);
    console.log(formatPlan(plan));
    if (plan.conflicts) {
      console.log('\nConflicts: nothing would be written. Resolve them first.');
      process.exitCode = 1;
    } else console.log('\nDry run: nothing was written. Run again with --apply to import.');
  } else {
    const clock = createClock();
    const store = new PgEventStore(pool, buildProjectors(), clock);
    const r = await applyImport({ pool, store, clock }, bundle, values.author);
    console.log(formatPlan(r.plan));
    if (r.plan.conflicts) {
      console.log('\nConflicts: nothing was written.');
      process.exitCode = 1;
    } else console.log(`\nImported: ${r.events} event(s), ${r.shares} share row(s).`);
  }
} catch (e) {
  console.error(e instanceof BundleRefused ? `refused: ${e.message}` : (e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
