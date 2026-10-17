import { parseArgs } from 'node:util';
import { createClock } from '../src/clock.ts';
import { loadConfig } from '../src/config.ts';
import {
  applyLedgerCleanup,
  formatCleanupPlan,
  planLedgerCleanup,
} from '../src/data-migrations/ledger-cleanup.ts';
import { createPool } from '../src/db/pool.ts';
import { PgEventStore } from '../src/eventstore/pg-event-store.ts';
import { buildProjectors } from '../src/projections/index.ts';

/**
 * `pnpm --filter @aom/server exec tsx scripts/ledger-cleanup-2026-10.ts [--org <org id>] [--apply]`
 *
 * The owner-approved ledger clean-up (Lean Team v3, design section 10): merges the duplicate standing orders, retires the
 * one-off orders HR promoted, the "Test Environment" / "Test mode" pair (replaced by the project setting "test without an
 * environment") and the "ledger search" order. DRY RUN BY DEFAULT: it only prints exactly what it would change.
 * `--apply` writes it (one `LedgerEntryRetired` event per order; the history stays).
 */
const { values } = parseArgs({
  options: { apply: { type: 'boolean', default: false }, org: { type: 'string' } },
});
const config = loadConfig();
const pool = createPool(config.databaseUrl, 2);
try {
  const plan = await planLedgerCleanup(pool, values.org ? { orgId: values.org } : {});
  console.log(formatCleanupPlan(plan));
  if (!values.apply) {
    console.log('\nDry run: nothing was written. Run again with --apply to write it.');
  } else {
    const clock = createClock();
    const store = new PgEventStore(pool, buildProjectors(), clock);
    const n = await applyLedgerCleanup({ pool, store, clock, log: (m) => console.log(m) }, plan);
    console.log(`\n${n} order(s) retired.`);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
