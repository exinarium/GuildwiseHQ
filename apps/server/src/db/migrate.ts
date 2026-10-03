import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadConfig } from '../config.ts';
import { MIGRATION_LOCK_ID } from './tx.ts';

export class MigrationChecksumError extends Error {
  constructor(file: string) {
    super(`migration ${file} was modified after being applied (checksum mismatch)`);
    this.name = 'MigrationChecksumError';
  }
}

export interface MigrateOptions {
  dir?: string;
  /** Run inside this schema (tests); defaults to the connection's search path. */
  schema?: string;
  log?: (msg: string) => void;
}

export function defaultMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.AOM_MIGRATIONS_DIR,
    join(here, '../../migrations'), // src/db -> apps/server/migrations
    join(here, '../migrations'), // dist -> apps/server/migrations
    join(here, 'migrations'),
  ].filter((x): x is string => !!x);
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error(`migrations directory not found (tried ${candidates.join(', ')})`);
  return found;
}

/** Applies pending migrations; returns the applied file names. Aborts if an applied file changed. */
export async function migrate(connectionString: string, opts: MigrateOptions = {}): Promise<string[]> {
  const dir = opts.dir ?? defaultMigrationsDir();
  const log = opts.log ?? (() => {});
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    if (opts.schema) {
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${opts.schema}"`);
      await client.query(`SET search_path TO "${opts.schema}"`);
    }
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
      const done = new Map<string, string>(
        (
          await client.query<{ version: string; checksum: string }>(
            'SELECT version, checksum FROM schema_migrations',
          )
        ).rows.map((r) => [r.version, r.checksum]),
      );
      for (const file of files) {
        const body = await readFile(join(dir, file), 'utf8');
        const checksum = createHash('sha256').update(body).digest('hex');
        const prior = done.get(file);
        if (prior !== undefined) {
          if (prior !== checksum) throw new MigrationChecksumError(file);
          continue;
        }
        await client.query('BEGIN');
        try {
          await client.query(body);
          await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
            file,
            checksum,
          ]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw new Error(`migration ${file} failed: ${(err as Error).message}`);
        }
        log(`applied ${file}`);
        applied.push(file);
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    }
  } finally {
    await client.end();
  }
  return applied;
}

// CLI: `pnpm db:migrate`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cfg = loadConfig();
  migrate(cfg.databaseUrl, { log: (m) => console.log(m) })
    .then((a) => {
      console.log(a.length ? `applied ${a.length} migration(s)` : 'database is up to date');
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
