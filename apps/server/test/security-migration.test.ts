import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultMigrationsDir, migrate } from '../src/db/migrate.ts';
import { TEST_DB_URL } from './helpers/db.ts';

/**
 * Migration 3020 (security hardening): additive and idempotent, on an empty database and on the development schema
 * (every migration before it applied, with data in it). Super-admin sessions are ended; other sessions stay.
 */
const SCHEMA = 'mig_security';
const FILE = '3020_security_hardening.sql';
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

const NEW_TABLES = [
  'login_failures',
  'sign_ins',
  'platform_blocklist',
  'workstation_org_serving',
  'render_workers',
  'render_worker_log',
  'two_factor_recoveries',
  'org_ownership_transfers',
  'workstation_passkeys',
  'security_notices',
  'release_signatures',
];
const NEW_COLUMNS: Array<[string, string]> = [
  ['auth_sessions', 'method'],
  ['auth_sessions', 'second_factor_at'],
  ['password_resets', 'attempts'],
  ['video_renders', 'worker_id'],
  ['video_renders', 'encoder'],
  ['organizations', 'created_as_simulation'],
  ['workstations', 'release_signed'],
  ['workstations', 'release_key_id'],
  ['workstations', 'startup_refused'],
  ['deploy_targets', 'signing'],
];

async function expectSchema(): Promise<void> {
  const t = await client.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename = ANY($2::text[])`,
    [SCHEMA, NEW_TABLES],
  );
  expect(t.rows.map((r) => r.tablename).sort()).toEqual([...NEW_TABLES].sort());
  for (const [table, column] of NEW_COLUMNS) {
    const c = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
      [SCHEMA, table, column],
    );
    expect(c.rowCount, `${table}.${column}`).toBe(1);
  }
}

describe('migration 3020 security hardening', () => {
  it('applies on an empty database, then again as a no-op', async () => {
    const applied = await migrate(TEST_DB_URL, { schema: SCHEMA });
    expect(applied).toContain(FILE);
    await expectSchema();
    expect(await migrate(TEST_DB_URL, { schema: SCHEMA })).toEqual([]);
    // the SQL itself is idempotent too (every statement IF NOT EXISTS), not only the migration bookkeeping
    const { readFile } = await import('node:fs/promises');
    await client.query(`SET search_path TO ${SCHEMA}`);
    await client.query(await readFile(join(defaultMigrationsDir(), FILE), 'utf8'));
    await client.query('SET search_path TO public');
    await expectSchema();
  });

  it('applies on the development schema with data: ends super-admin sessions only, backfills created_as_simulation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aom-mig-3020-'));
    try {
      await cp(defaultMigrationsDir(), dir, { recursive: true });
      await rm(join(dir, FILE));
      await migrate(TEST_DB_URL, { schema: SCHEMA, dir });

      await client.query(`SET search_path TO ${SCHEMA}`);
      await client.query('SET session_replication_role = replica');
      const root = '00000000-0000-4000-8000-0000000000a1';
      const member = '00000000-0000-4000-8000-0000000000a2';
      const simOrg = '00000000-0000-4000-8000-0000000000b1';
      const realOrg = '00000000-0000-4000-8000-0000000000b2';
      await client.query(
        `INSERT INTO users (id, email, display_name, password_hash, kind, status, created_at)
         VALUES ($1, 'root@example.test', 'Root', 'x', 'super_admin', 'active', now()),
                ($2, 'member@example.test', 'Member', 'x', 'user', 'active', now())`,
        [root, member],
      );
      await client.query(
        `INSERT INTO auth_sessions (id, user_id, expires_at) VALUES ('s-root', $1, now() + interval '1 hour'),
                ('s-member', $2, now() + interval '1 hour')`,
        [root, member],
      );
      await client.query(
        `INSERT INTO organizations (id, name, owner_user_id, status, status_changed_at, plan, created_via, created_at, simulation)
         VALUES ($1, 'Sim', $3, 'active', now(), 'free', 'cli', now(), true),
                ($2, 'Real', $3, 'active', now(), 'free', 'cli', now(), true)`,
        [simOrg, realOrg, member],
      );
      await client.query(
        `INSERT INTO events (stream_id, stream_version, type, payload, actor_kind, audience)
         VALUES ('org-a', 1, 'OrganizationCreated', $1, 'system', 'admin'),
                ('org-b', 1, 'OrganizationCreated', $2, 'system', 'admin')`,
        [JSON.stringify({ orgId: simOrg, simulation: true }), JSON.stringify({ orgId: realOrg })],
      );
      await client.query('SET session_replication_role = DEFAULT');
      await client.query('SET search_path TO public');

      expect(await migrate(TEST_DB_URL, { schema: SCHEMA })).toEqual([FILE]);
      await expectSchema();
      await client.query(`SET search_path TO ${SCHEMA}`);
      const sessions = await client.query(
        `SELECT id, method, second_factor_at FROM auth_sessions ORDER BY id`,
      );
      expect(sessions.rows).toEqual([{ id: 's-member', method: null, second_factor_at: null }]);
      const orgs = await client.query(`SELECT name, created_as_simulation FROM organizations ORDER BY name`);
      // "Real" was switched to simulation after it was created: it is not a simulation by creation
      expect(orgs.rows).toEqual([
        { name: 'Real', created_as_simulation: false },
        { name: 'Sim', created_as_simulation: true },
      ]);
      const ws = await client.query(
        `SELECT column_default, is_nullable FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'workstations' AND column_name = 'release_signed'`,
        [SCHEMA],
      );
      expect(ws.rows[0]).toMatchObject({ column_default: 'false', is_nullable: 'NO' });
      await expect(
        client.query(`INSERT INTO login_failures (at, reason) VALUES (now(), 'guess')`),
      ).rejects.toThrow(/check constraint/);
      await client.query('SET search_path TO public');
      expect(await migrate(TEST_DB_URL, { schema: SCHEMA })).toEqual([]);
    } finally {
      await client.query('SET search_path TO public');
      await rm(dir, { recursive: true, force: true });
    }
  });
});
