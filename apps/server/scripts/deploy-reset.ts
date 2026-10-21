import { parseArgs } from 'node:util';
import { createClock } from '../src/clock.ts';
import { loadConfig } from '../src/config.ts';
import { applyDeployReset, formatResetPlan, planDeployReset } from '../src/data-migrations/deploy-reset.ts';
import { migrate } from '../src/db/migrate.ts';
import { createPool } from '../src/db/pool.ts';
import { PgEventStore } from '../src/eventstore/pg-event-store.ts';
import { buildProjectors } from '../src/projections/index.ts';

/**
 * `node dist/deploy-reset.mjs --dry-run | --confirm [--org <org id>]`: the one-off reset of every deploy place and delivery setup
 * for the new Environments page (docs/DEPLOY.md, release notes). It appends events only, never contacts a runner or a server,
 * and prints the servers where Guildwise keys may remain. `--dry-run` (the default) writes nothing.
 */
const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    confirm: { type: 'boolean', default: false },
    org: { type: 'string' },
  },
});
if (values.confirm && values['dry-run']) {
  console.error('use either --dry-run or --confirm');
  process.exit(1);
}
const config = loadConfig();
await migrate(config.databaseUrl);
const pool = createPool(config.databaseUrl, 2);
try {
  const plan = await planDeployReset(pool, values.org ? { orgId: values.org } : {});
  console.log(formatResetPlan(plan));
  if (!values.confirm) {
    console.log('\nDry run: nothing was written. Run again with --confirm to do it.');
  } else {
    const clock = createClock();
    const store = new PgEventStore(pool, buildProjectors(), clock);
    const n = await applyDeployReset({ pool, store, clock, log: (m) => console.log(m) }, plan);
    console.log(`\n${n} project(s) reset. No runner and no server was contacted.`);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
