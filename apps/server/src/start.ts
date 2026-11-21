import { createApp } from './app.ts';
import { describeSecuritySettings } from './auth/security-settings.ts';
import { registerBuiltins } from './catalogue/boot.ts';
import { ensureBusinessWorkflowsAtBoot } from './catalogue/business-workflows.ts';
import { createClock } from './clock.ts';
import { publishServerVersion } from './commands/video-posts.ts';
import { configWarnings, loadConfig } from './config.ts';
import { runDataMigrations } from './data-migrations/index.ts';
import { migrate } from './db/migrate.ts';
import { createPool } from './db/pool.ts';
import { PgEventStore } from './eventstore/pg-event-store.ts';
import { extensionMigrationDirs, type ServerExtension } from './extension.ts';
import { rebaseAgentsToCurrentRoles } from './hr/follow-role.ts';
import { platformTeamWarnings, syncPlatformTeamDesignation } from './platform-team/settings.ts';
import { buildProjectors } from './projections/index.ts';
import { signedRunnersAtBoot } from './runner-gateway/signed-sweep.ts';

/**
 * Boots the server: SQL migrations (the core's, then each extension's), data migrations, the app and its listener. The
 * open-source `main.ts` calls it with no extensions; a hosted build calls it with its own (see extension.ts).
 */
export async function startServer(extensions: ServerExtension[] = []): Promise<void> {
  const config = loadConfig();

  for (const w of configWarnings(config)) console.warn(`WARN: ${w}`);
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
    // runDataMigrations holds one connection for its advisory lock for the whole run, and a migration may hold another
    // for a lock of its own (restructure) while it still needs a third for its work: 2 connections deadlocked the boot.
    const pool = createPool(config.databaseUrl, 5);
    try {
      const clock = createClock();
      await runDataMigrations({
        pool,
        store: new PgEventStore(pool, buildProjectors(), clock),
        clock,
        log: (m) => console.log(m),
        inboundDomain: config.inbound.domain,
        projectGraphs: config.projectGraphs.enabled,
        secretKey: config.secretKey,
        twoFactorKey: config.twoFactorKey,
      });
    } finally {
      await pool.end();
    }
  }

  const app = await createApp(config, {
    background: true,
    extensions,
    // "Only signed runners" (R21, R27), after the data migrations and before the dispatcher, scheduler and simulation
    // start: the served release must verify, else boot refuses; then the signed-runner sweep (idempotent, nothing on an
    // empty DB or with the setting off) and the reinstall mails.
    beforeBackground: async (ctx) => {
      const signed = await signedRunnersAtBoot(ctx);
      if (signed.unlinked || signed.mailed) ctx.log.warn(signed, 'signed-runner sweep');
    },
  });
  app.log.info(await describeSecuritySettings(app.ctx), 'security settings');
  // R17-1: the platform team designation follows server config; a legacy designation is read-only and warned about.
  await syncPlatformTeamDesignation(app.ctx);
  for (const w of await platformTeamWarnings(app.ctx)) app.log.warn(w);
  // Video workers on other machines compare their version with this one (here and not in createApp: the video worker
  // also calls createApp and must not overwrite the server's version with its own).
  await publishServerVersion(app.ctx);
  const reg = await registerBuiltins(
    app.ctx,
    config.noLeanTeam ? (d) => !(d.key === 'code' && d.version >= 6) : undefined,
  );
  if (reg.workflows || reg.roles) app.log.info(reg, 'registered built-in catalogue');
  const biz = await ensureBusinessWorkflowsAtBoot(app.ctx);
  if (biz) app.log.info({ orgs: biz }, 'business workflows checked');
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
