import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultMigrationsDir, MigrationChecksumError, migrate } from '../src/db/migrate.ts';
import { TEST_DB_URL } from './helpers/db.ts';

const SCHEMA = 'mig_test';
const client = new pg.Client({ connectionString: TEST_DB_URL });
let connected = false;

beforeEach(async () => {
  if (!connected) {
    await client.connect();
    connected = true;
  }
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
});
afterAll(async () => {
  if (connected) {
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.end();
  }
});

describe('migrate', () => {
  it('applies every migration on an empty schema and is idempotent on re-run', async () => {
    const files = (await readdir(defaultMigrationsDir())).filter((f) => f.endsWith('.sql')).sort();
    expect(files.length).toBeGreaterThanOrEqual(9);
    const first = await migrate(TEST_DB_URL, { schema: SCHEMA });
    expect(first).toEqual(files);
    const second = await migrate(TEST_DB_URL, { schema: SCHEMA });
    expect(second).toEqual([]);
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${SCHEMA}.schema_migrations`);
    expect(rows[0].n).toBe(files.length);
    const tables = await client.query(
      `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = $1 AND tablename IN ('events','cards','agents','runner_commands')`,
      [SCHEMA],
    );
    expect(tables.rows[0].n).toBe(4);
  });

  it('scrubs credentials from stored remote URLs, in projections and in event payloads (review M5)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aom-mig-'));
    await cp(defaultMigrationsDir(), dir, { recursive: true });
    await rm(join(dir, '1100_scrub_url_credentials.sql'));
    await migrate(TEST_DB_URL, { schema: SCHEMA, dir });
    const dirty = 'https://bob:ghp_secret@github.com/acme/web.git';
    const token = 'https://ghp_tokenonly@github.com/acme/web.git';
    const ssh = 'ssh://git@github.com/acme/web.git';
    await client.query(`SET search_path TO ${SCHEMA}`);
    await client.query(`SET session_replication_role = replica`);
    const vault = (id: string, kind: string, url: string) =>
      client.query(
        `INSERT INTO vaults (id, org_id, kind, name, remote_url, created_at) VALUES ($1, gen_random_uuid(), $2, 'v', $3, now())`,
        [id, kind, url],
      );
    await vault('00000000-0000-4000-8000-000000000001', 'work', dirty);
    await vault('00000000-0000-4000-8000-000000000002', 'personal', ssh);
    await client.query(
      `INSERT INTO events (stream_id, stream_version, type, payload, actor_kind, audience) VALUES ('vault-x', 1, 'VaultRegistered', $1, 'system', 'org'), ('vault-x', 2, 'VaultUpdated', $2, 'system', 'org')`,
      [JSON.stringify({ remoteUrl: dirty }), JSON.stringify({ remoteUrl: token })],
    );
    await client.query(`SET session_replication_role = DEFAULT`);

    await migrate(TEST_DB_URL, { schema: SCHEMA, dir: defaultMigrationsDir() });
    const urls = (await client.query(`SELECT remote_url FROM vaults ORDER BY id`)).rows.map(
      (r) => r.remote_url,
    );
    expect(urls).toEqual(['https://github.com/acme/web.git', ssh]);
    const ev = (await client.query(`SELECT payload->>'remoteUrl' AS u FROM events ORDER BY seq`)).rows.map(
      (r) => r.u,
    );
    expect(ev).toEqual(['https://github.com/acme/web.git', 'https://github.com/acme/web.git']);
    // the append-only guard is back on
    await expect(client.query(`UPDATE events SET type = type`)).rejects.toThrow(/append-only/);
  });

  it('aborts if an applied migration file changed (checksum)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aom-mig-'));
    await cp(defaultMigrationsDir(), dir, { recursive: true });
    await migrate(TEST_DB_URL, { schema: SCHEMA, dir });
    const f = join(dir, '0002_users.sql');
    await writeFile(f, `${await readFile(f, 'utf8')}\n-- tampered\n`);
    await expect(migrate(TEST_DB_URL, { schema: SCHEMA, dir })).rejects.toBeInstanceOf(
      MigrationChecksumError,
    );
  });

  it('rolls back a failing migration and does not record it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aom-mig-'));
    await writeFile(join(dir, '0001_ok.sql'), 'CREATE TABLE a (id int);');
    await writeFile(join(dir, '0002_bad.sql'), 'CREATE TABLE b (id int); SELECT nope();');
    await expect(migrate(TEST_DB_URL, { schema: SCHEMA, dir })).rejects.toThrow(/0002_bad.sql failed/);
    const { rows } = await client.query(`SELECT version FROM ${SCHEMA}.schema_migrations`);
    expect(rows.map((r) => r.version)).toEqual(['0001_ok.sql']);
    const b = await client.query(`SELECT 1 FROM pg_tables WHERE schemaname=$1 AND tablename='b'`, [SCHEMA]);
    expect(b.rowCount).toBe(0);
  });
});
