import { parseArgs } from 'node:util';
import { createClock } from '../../src/clock.ts';
import { loadConfig } from '../../src/config.ts';
import { createPool } from '../../src/db/pool.ts';
import { PgEventStore } from '../../src/eventstore/pg-event-store.ts';
import { buildProjectors } from '../../src/projections/index.ts';
import { buildLegacyFeeds } from './legacy-feeds.ts';

/**
 * Seeds the database with the realistic feed-project fixture of the migration tests (`legacy-feeds.ts`) and prints its ids
 * as JSON. The e2e migration spec calls it before running `restructure:migrate`; it is not part of the product.
 */
const { values } = parseArgs({
  options: { org: { type: 'string' }, owner: { type: 'string' }, guest: { type: 'string' } },
});
if (!values.org || !values.owner) throw new Error('--org and --owner are required');
const config = loadConfig();
const pool = createPool(config.databaseUrl, 2);
try {
  const store = new PgEventStore(pool, buildProjectors(), createClock());
  const f = await buildLegacyFeeds({
    pool,
    store,
    orgId: values.org,
    ownerId: values.owner,
    ...(values.guest ? { guestId: values.guest } : {}),
  });
  console.log(JSON.stringify(f));
} finally {
  await pool.end();
}
