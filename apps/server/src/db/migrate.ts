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
  /**
   * Migration sets of extensions (hosted billing, support, ...), applied after the core's `dir` in the order given.
   * Each file keeps its own id (its filename); one `schema_migrations` table tracks them all, so a database that
   * already applied a file under the core never re-runs it from an extension.
   */
  extraDirs?: string[];
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

/** The migration files to consider, core first, then each extension set: `[file name, directory]`. */
async function listMigrations(opts: MigrateOptions): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const dir of [opts.dir ?? defaultMigrationsDir(), ...(opts.extraDirs ?? [])]) {
    for (const f of (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort()) {
      if (seen.has(f)) throw new Error(`migration ${f} exists in two migration sets`);
      seen.add(f);
      out.push([f, dir]);
    }
  }
  return out;
}

/** Applies pending migrations; returns the applied file names. Aborts if an applied file changed. */
export async function migrate(connectionString: string, opts: MigrateOptions = {}): Promise<string[]> {
  const log = opts.log ?? (() => {});
  const files = await listMigrations(opts);
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
      for (const [file, dir] of files) {
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

/**
 * Dry-run support for the data-migration CLIs: applies every pending SQL migration inside one transaction on a single
 * connection, hands that connection to `fn` (so a plan sees the migrated schema), then ROLLS BACK. Nothing is written.
 * Returns the pending file names alongside the result. An applied file whose checksum changed still aborts.
 */
export async function withPendingMigrations<T>(
  connectionString: string,
  fn: (db: pg.ClientBase, pending: string[]) => Promise<T>,
  opts: MigrateOptions = {},
): Promise<{ result: T; pending: string[] }> {
  const files = await listMigrations(opts);
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    if (opts.schema) await client.query(`SET search_path TO "${opts.schema}"`);
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID]);
      const hasTable =
        (await client.query(`SELECT to_regclass('schema_migrations') AS t`)).rows[0].t !== null;
      const done = new Map<string, string>(
        hasTable
          ? (
              await client.query<{ version: string; checksum: string }>(
                'SELECT version, checksum FROM schema_migrations',
              )
            ).rows.map((r) => [r.version, r.checksum])
          : [],
      );
      const pending: string[] = [];
      for (const [file, dir] of files) {
        const body = await readFile(join(dir, file), 'utf8');
        const checksum = createHash('sha256').update(body).digest('hex');
        const prior = done.get(file);
        if (prior !== undefined) {
          if (prior !== checksum) throw new MigrationChecksumError(file);
          continue;
        }
        pending.push(file);
        try {
          await client.query('SAVEPOINT m');
          await client.query(body);
          await client.query('RELEASE SAVEPOINT m');
        } catch (err) {
          throw new Error(`migration ${file} failed: ${(err as Error).message}`);
        }
      }
      return { result: await fn(client, pending), pending };
    } finally {
      await client.query('ROLLBACK');
    }
  } finally {
    await client.end();
  }
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
