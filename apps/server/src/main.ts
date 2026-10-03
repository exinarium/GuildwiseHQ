import { createApp } from './app.ts';
import { registerBuiltins } from './catalogue/boot.ts';
import { loadConfig } from './config.ts';
import { migrate } from './db/migrate.ts';

const config = loadConfig();

if (config.migrateOnBoot) {
  const applied = await migrate(config.databaseUrl);
  if (applied.length) console.log(`applied ${applied.length} migration(s)`);
}

const app = await createApp(config, { background: true });
const reg = await registerBuiltins(app.ctx);
if (reg.workflows || reg.roles) app.log.info(reg, 'registered built-in catalogue');

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
