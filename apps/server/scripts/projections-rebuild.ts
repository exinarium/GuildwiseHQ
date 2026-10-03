import { createClock } from '../src/clock.ts';
import { loadConfig } from '../src/config.ts';
import { createPool } from '../src/db/pool.ts';
import { PgEventStore } from '../src/eventstore/pg-event-store.ts';
import { buildProjectors } from '../src/projections/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';

/** `pnpm --filter @aom/server projections:rebuild` (stop the server first). */
const config = loadConfig();
const pool = createPool(config.databaseUrl, 2);
try {
  const store = new PgEventStore(pool, buildProjectors(), createClock());
  const { events } = await rebuildProjections(pool, store);
  console.log(`replayed ${events} events`);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
