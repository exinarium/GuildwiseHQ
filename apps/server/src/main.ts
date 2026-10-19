import { createApp } from './app.ts';
import { paymentsUnavailable } from './billing/guard.ts';
import { registerBuiltins } from './catalogue/boot.ts';
import { createClock } from './clock.ts';
import { loadConfig } from './config.ts';
import { runDataMigrations } from './data-migrations/index.ts';
import { migrate } from './db/migrate.ts';
import { createPool } from './db/pool.ts';
import { PgEventStore } from './eventstore/pg-event-store.ts';
import { rebaseAgentsToCurrentRoles } from './hr/follow-role.ts';
import { buildProjectors } from './projections/index.ts';

const config = loadConfig();

// Without a real payment provider on a production domain the server still starts: it takes no fake payments and hides
// self-service sign-up and card payments instead (billing/guard.ts).
const unavailable = paymentsUnavailable(config);
if (unavailable)
  console.warn(
    `WARN: ${unavailable} Origin: ${config.publicOrigin}. Set AOM_ALLOW_FAKE_PAYMENTS=true to use the fake provider on purpose (staging).`,
  );

if (config.migrateOnBoot) {
  const applied = await migrate(config.databaseUrl);
  if (applied.length) console.log(`applied ${applied.length} migration(s)`);
}

// Data migrations run after the SQL migrations and before the dispatcher, scheduler and listener start
// (docs/design/organizations.md section 2.3). Idempotent; `AOM_DATA_MIGRATIONS=false` skips them.
if (config.dataMigrations) {
  const pool = createPool(config.databaseUrl, 2);
  try {
    const clock = createClock();
    await runDataMigrations({
      pool,
      store: new PgEventStore(pool, buildProjectors(), clock),
      clock,
      log: (m) => console.log(m),
      inboundDomain: config.inbound.domain,
      projectGraphs: config.projectGraphs.enabled,
    });
  } finally {
    await pool.end();
  }
}

const app = await createApp(config, { background: true });
const reg = await registerBuiltins(app.ctx);
if (reg.workflows || reg.roles) app.log.info(reg, 'registered built-in catalogue');
// Hired agents follow their role's current version (permissions = role + the agent's own deviations).
const rebased = await rebaseAgentsToCurrentRoles(app.ctx);
if (rebased) app.log.info({ rebased }, 'agents rebased onto their current role version');

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    app.log.info({ sig }, 'shutting down');
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}

await app.listen({ port: config.port, host: config.host });
