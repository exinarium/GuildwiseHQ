import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultMigrationsDir, migrate } from '../src/db/migrate.ts';
import { TEST_DB_URL } from './helpers/db.ts';

/**
 * Migration 3023 (deps-without-sudo): every queued sudo ciphertext is forgotten whatever its status (F4), queued ones
 * fail, the stored sudo facts and the `sudo` access flag go; other commands and access fields are untouched.
 */
const SCHEMA = 'mig_remove_sudo';
const FILE = '3023_remove_sudo_password.sql';
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

describe('migration 3023 remove sudo password', () => {
  it('empties sudo payloads in every status, fails queued ones, clears the facts and the access flag', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aom-mig-3023-'));
    try {
      await cp(defaultMigrationsDir(), dir, { recursive: true });
      await rm(join(dir, FILE));
      await migrate(TEST_DB_URL, { schema: SCHEMA, dir });

      await client.query(`SET search_path TO ${SCHEMA}`);
      await client.query('SET session_replication_role = replica');
      const user = '00000000-0000-4000-8000-0000000000a1';
      const ws = '00000000-0000-4000-8000-0000000000c1';
      await client.query(
        `INSERT INTO users (id, email, display_name, password_hash, kind, status, created_at)
         VALUES ($1, 'u@example.test', 'U', 'x', 'user', 'active', now())`,
        [user],
      );
      await client.query(
        `INSERT INTO workstations (id, user_id, name, token_hash, status, paired_at, devops_access,
                                   devops_sudo_set_at, devops_sudo_works, devops_sudo_key_id)
         VALUES ($1, $2, 'Laptop', 'h', 'active', now(), $3, now(), true, 'abcd')`,
        [
          ws,
          user,
          JSON.stringify({ allowInstall: true, allowDocker: true, allowedPaths: ['/srv'], sudo: true }),
        ],
      );
      const cipher = JSON.stringify({ ciphertext: 'c2VjcmV0', keyId: 'abcd' });
      for (const [id, type, status, payload] of [
        ['00000000-0000-4000-8000-000000000001', 'sudo.set', 'pending', cipher],
        ['00000000-0000-4000-8000-000000000002', 'sudo.set', 'sent', cipher],
        ['00000000-0000-4000-8000-000000000003', 'sudo.set', 'done', cipher],
        ['00000000-0000-4000-8000-000000000004', 'sudo.set', 'failed', cipher],
        ['00000000-0000-4000-8000-000000000005', 'sudo.clear', 'pending', '{}'],
        ['00000000-0000-4000-8000-000000000006', 'env.ensure', 'pending', '{"x":1}'],
      ] as const)
        await client.query(
          `INSERT INTO runner_commands (id, workstation_id, type, payload, status) VALUES ($1, $2, $3, $4, $5)`,
          [id, ws, type, payload, status],
        );
      await client.query('SET session_replication_role = DEFAULT');
      await client.query('SET search_path TO public');

      expect(await migrate(TEST_DB_URL, { schema: SCHEMA })).toEqual([FILE]);

      await client.query(`SET search_path TO ${SCHEMA}`);
      const cmds = await client.query(`SELECT type, status, payload FROM runner_commands ORDER BY id`);
      expect(cmds.rows).toEqual([
        { type: 'sudo.set', status: 'failed', payload: {} },
        { type: 'sudo.set', status: 'failed', payload: {} },
        { type: 'sudo.set', status: 'done', payload: {} },
        { type: 'sudo.set', status: 'failed', payload: {} },
        { type: 'sudo.clear', status: 'failed', payload: {} },
        { type: 'env.ensure', status: 'pending', payload: { x: 1 } },
      ]);
      const w = await client.query(
        `SELECT devops_access, devops_sudo_set_at, devops_sudo_works, devops_sudo_key_id FROM workstations`,
      );
      expect(w.rows).toEqual([
        {
          devops_access: { allowInstall: true, allowDocker: true, allowedPaths: ['/srv'] },
          devops_sudo_set_at: null,
          devops_sudo_works: null,
          devops_sudo_key_id: null,
        },
      ]);
      // the SQL is idempotent on its own
      await client.query(await readFile(join(defaultMigrationsDir(), FILE), 'utf8'));
      const again = await client.query(
        `SELECT count(*)::int AS n FROM runner_commands WHERE status = 'failed'`,
      );
      expect(again.rows[0].n).toBe(4);
      await client.query('SET search_path TO public');
      expect(await migrate(TEST_DB_URL, { schema: SCHEMA })).toEqual([]);
    } finally {
      await client.query('SET search_path TO public');
      await rm(dir, { recursive: true, force: true });
    }
  });
});
