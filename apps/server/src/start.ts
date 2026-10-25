import { createApp } from './app.ts';
import { registerBuiltins } from './catalogue/boot.ts';
import { createClock } from './clock.ts';
import { loadConfig } from './config.ts';
import { runDataMigrations } from './data-migrations/index.ts';
import { migrate } from './db/migrate.ts';
import { createPool } from './db/pool.ts';
import { PgEventStore } from './eventstore/pg-event-store.ts';
import { extensionMigrationDirs, type ServerExtension } from './extension.ts';
import { rebaseAgentsToCurrentRoles } from './hr/follow-role.ts';
import { buildProjectors } from './projections/index.ts';

/**
 * Boots the server: SQL migrations (the core's, then each extension's), data migrations, the app and its listener. The
 * open-source `main.ts` calls it with no extensions; a hosted build calls it with its own (see extension.ts).
 */
export async function startServer(extensions: ServerExtension[] = []): Promise<void> {
  const config = loadConfig();

  for (const e of extensions) {
    const warning = e.startupWarning?.(config);
    if (warning) console.warn(`WARN: ${warning}`);
  }

  if (config.migrateOnBoot) {
    const applied = await migrate(config.databaseUrl, { extraDirs: extensionMigrationDirs(extensions) });
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

  const app = await createApp(config, { background: true, extensions });
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
}
