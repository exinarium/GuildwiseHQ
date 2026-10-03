import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const E2E_DIR = process.env.AOM_E2E_DIR ?? '/tmp/aom-e2e';
export const PORT = Number(process.env.AOM_E2E_PORT ?? 4601);
export const BASE_URL = `http://localhost:${PORT}`;
export const DB_NAME = process.env.AOM_E2E_DB ?? 'aom_e2e';
export const PG_ADMIN_URL = 'postgres://aom:aom@127.0.0.1:5433/postgres';
export const DATABASE_URL = `postgres://aom:aom@127.0.0.1:5433/${DB_NAME}`;
export const MAILPIT_API = process.env.AOM_MAILPIT_API ?? 'http://127.0.0.1:8025';
export const SMTP_URL = process.env.AOM_E2E_SMTP_URL ?? 'smtp://127.0.0.1:1025';

export const ADMIN = { email: 'admin@e2e.test', name: 'E2E Admin', password: 'admin-password-12345' };
export const MEMBER = { email: 'member@e2e.test', name: 'E2E Member', password: 'member-password-12345' };
export const OTHER = { email: 'other@e2e.test', name: 'E2E Other', password: 'other-password-12345' };

export const paths = {
  server: join(ROOT, 'apps/server/dist/main.mjs'),
  runnerBin: join(ROOT, 'apps/runner/dist/aom-runner.mjs'),
  webDist: join(ROOT, 'apps/web/dist'),
  origin: join(E2E_DIR, 'origin/toy.git'),
  repoRoot: join(E2E_DIR, 'repos'),
  toyClone: join(E2E_DIR, 'repos/toy'),
  runnerData: join(E2E_DIR, 'runner'),
  pids: join(E2E_DIR, 'pids.json'),
  serverLog: join(E2E_DIR, 'server.log'),
  runnerLog: join(E2E_DIR, 'runner.out.log'),
};
