// Run with the server's tsx (`pnpm --filter @aom/server exec tsx <this file>`): gives every e2e organization its built-in
// CEO. The server provisions CEOs in a data migration that runs before the built-in role catalogue is registered, so an
// organization created by `admin:create` on a fresh database has none until the next restart.

import { createApp } from '../../apps/server/src/app.ts';
import { registerBuiltins } from '../../apps/server/src/catalogue/boot.ts';
import { createClock } from '../../apps/server/src/clock.ts';
import { loadConfig } from '../../apps/server/src/config.ts';
import { migrateCeoBuiltin } from '../../apps/server/src/data-migrations/ceo-builtin.ts';
import { createPool } from '../../apps/server/src/db/pool.ts';
import { PgEventStore } from '../../apps/server/src/eventstore/pg-event-store.ts';
import { buildProjectors } from '../../apps/server/src/projections/index.ts';

const config = loadConfig();
const app = await createApp(config, { background: false });
await registerBuiltins(app.ctx);
await app.close();
const pool = createPool(config.databaseUrl, 2);
try {
  const clock = createClock();
  const report = await migrateCeoBuiltin({
    pool,
    store: new PgEventStore(pool, buildProjectors(), clock),
    clock,
    log: (m) => console.log(m),
    inboundDomain: config.inbound.domain,
    projectGraphs: config.projectGraphs.enabled,
  });
  console.log(JSON.stringify(report));
} finally {
  await pool.end();
}
