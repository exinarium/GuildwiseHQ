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

describe('1313_agent_allow_list', () => {
  it('gives project-scoped agents an allow-list of their old project, org-wide agents "any", and is safe to run again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aom-mig-'));
    await cp(defaultMigrationsDir(), dir, { recursive: true });
    await rm(join(dir, '1313_agent_allow_list.sql'));
    await migrate(TEST_DB_URL, { schema: SCHEMA, dir });
    await client.query(`SET search_path TO ${SCHEMA}`);
    await client.query(`SET session_replication_role = replica`);
    const P = '00000000-0000-4000-8000-0000000000a1';
    const U = '00000000-0000-4000-8000-0000000000b1';
    await client.query(
      `INSERT INTO projects (id, org_id, key, name, domain, workflow_key, created_at)
       VALUES ($1, $2, 'OLD', 'Old', 'work', 'code', now())`,
      [P, U],
    );
    const agent = (id: string, name: string, project: string | null) =>
      client.query(
        `INSERT INTO agents (id, org_id, project_id, hired_by_user_id, manager_user_id, name, role_key, role_version,
           seniority, runtime, model, status, hired_at, avatar_seed)
         VALUES ($1, $2, $3, $2, $2, $4, 'builder', 1, 'junior', 'mock', 'mock', 'active', now(), $4 || '-seed')`,
        [id, U, project, name],
      );
    await agent('00000000-0000-4000-8000-0000000000c1', 'Scoped', P);
    await agent('00000000-0000-4000-8000-0000000000c2', 'Wide', null);
    await client.query(`SET session_replication_role = DEFAULT`);

    const applied = await migrate(TEST_DB_URL, { schema: SCHEMA });
    expect(applied).toEqual(['1313_agent_allow_list.sql']);
    const read = async () =>
      (
        await client.query(
          `SELECT name, hired_for_project_id, allowed_project_ids, focus_project_ids FROM agents ORDER BY name`,
        )
      ).rows;
    expect(await read()).toEqual([
      { name: 'Scoped', hired_for_project_id: P, allowed_project_ids: [P], focus_project_ids: [] },
      { name: 'Wide', hired_for_project_id: null, allowed_project_ids: null, focus_project_ids: [] },
    ]);
    expect((await client.query(`SELECT max_concurrent_shifts FROM projects`)).rows).toEqual([
      { max_concurrent_shifts: null },
    ]);

    // A manager changed an allow-list afterwards; running the file again must not reset it.
    await client.query(`UPDATE agents SET allowed_project_ids = NULL WHERE name = 'Scoped'`);
    const sql = await readFile(join(defaultMigrationsDir(), '1313_agent_allow_list.sql'), 'utf8');
    await client.query(sql);
    await client.query(sql);
    expect((await read())[0]).toMatchObject({ name: 'Scoped', allowed_project_ids: null });
  });
});

describe('1314_generic_schedules', () => {
  it('reads old schedules as create_card or regression_run on a cron trigger, and is safe to run again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aom-mig-'));
    await cp(defaultMigrationsDir(), dir, { recursive: true });
    await rm(join(dir, '1314_generic_schedules.sql'));
    await migrate(TEST_DB_URL, { schema: SCHEMA, dir });
    await client.query(`SET search_path TO ${SCHEMA}`);
    await client.query(`SET session_replication_role = replica`);
    const P = '00000000-0000-4000-8000-0000000000a2';
    const U = '00000000-0000-4000-8000-0000000000b2';
    await client.query(
      `INSERT INTO projects (id, org_id, key, name, domain, workflow_key, created_at)
       VALUES ($1, $2, 'OLD2', 'Old', 'work', 'code', now())`,
      [P, U],
    );
    const schedule = (id: string, kind: string) =>
      client.query(
        `INSERT INTO schedules (id, org_id, project_id, name, kind, cron, timezone, card_template, enabled, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, '0 7 * * *', 'UTC', '{"title":"Run","fields":{}}'::jsonb, true, now(), now())`,
        [id, U, P, `S-${kind}`, kind],
      );
    await schedule('00000000-0000-4000-8000-0000000000d1', 'feed');
    await schedule('00000000-0000-4000-8000-0000000000d2', 'regression');
    await client.query(`SET session_replication_role = DEFAULT`);

    const applied = await migrate(TEST_DB_URL, { schema: SCHEMA });
    expect(applied).toEqual(['1314_generic_schedules.sql']);
    const read = async () =>
      (
        await client.query(
          `SELECT kind, project_id, action->>'kind' AS action_kind, trigger FROM schedules ORDER BY kind`,
        )
      ).rows;
    expect(await read()).toEqual([
      {
        kind: 'feed',
        project_id: P,
        action_kind: 'create_card',
        trigger: { kind: 'cron', cron: '0 7 * * *', timezone: 'UTC' },
      },
      {
        kind: 'regression',
        project_id: P,
        action_kind: 'regression_run',
        trigger: { kind: 'cron', cron: '0 7 * * *', timezone: 'UTC' },
      },
    ]);
    // the new tables and columns exist; an org-level schedule (no project, no cron) is allowed
    await client.query(`SET session_replication_role = replica`);
    await client.query(
      `INSERT INTO schedules (id, org_id, project_id, name, kind, enabled, trigger, action, created_at, updated_at)
       VALUES ('00000000-0000-4000-8000-0000000000d3', $1, NULL, 'Org', 'ba_task', true, '{"kind":"manual"}', '{"kind":"ba_task"}', now(), now())`,
      [U],
    );
    await client.query(`SET session_replication_role = DEFAULT`);
    for (const t of ['schedule_runs', 'schedule_attempts', 'schedule_issues', 'schedule_trigger_cursor'])
      expect((await client.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0]).toEqual({ n: 0 });

    // A trigger changed afterwards must survive the file running again.
    await client.query(`UPDATE schedules SET trigger = '{"kind":"manual"}' WHERE kind = 'feed'`);
    const sql = await readFile(join(defaultMigrationsDir(), '1314_generic_schedules.sql'), 'utf8');
    await client.query(sql);
    await client.query(sql);
    expect((await read()).find((r) => r.kind === 'feed')).toMatchObject({ trigger: { kind: 'manual' } });
  });
});

describe('1315_project_stage', () => {
  it('reads what a project started as from its creation event, keeps research projects in the research stage, and is safe to run again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aom-mig-'));
    await cp(defaultMigrationsDir(), dir, { recursive: true });
    await rm(join(dir, '1315_project_stage.sql'));
    await migrate(TEST_DB_URL, { schema: SCHEMA, dir });
    await client.query(`SET search_path TO ${SCHEMA}`);
    await client.query(`SET session_replication_role = replica`);
    const U = '00000000-0000-4000-8000-0000000000b3';
    const mk = (id: string, key: string, workflow: string) =>
      client.query(
        `INSERT INTO projects (id, org_id, key, name, domain, workflow_key, created_at)
         VALUES ($1, $2, $3, $3, 'work', $4, now())`,
        [id, U, key, workflow],
      );
    const RES = '00000000-0000-4000-8000-0000000000a3';
    const CHANGED = '00000000-0000-4000-8000-0000000000a4';
    const BARE = '00000000-0000-4000-8000-0000000000a5';
    await mk(RES, 'RESX', 'research');
    // created as research, its workflow changed later by the old settings form: it started as research
    await mk(CHANGED, 'CHGD', 'code');
    await mk(BARE, 'BARE', 'code'); // no creation event: falls back to the current workflow
    await client.query(
      `INSERT INTO events (stream_id, stream_version, type, payload, actor_kind, org_id, project_id, audience, created_at)
       VALUES ($1, 1, 'ProjectCreated', $2, 'system', $3, $4, 'project', now())`,
      [`project-${CHANGED}`, JSON.stringify({ projectId: CHANGED, workflowKey: 'research' }), U, CHANGED],
    );
    await client.query(`SET session_replication_role = DEFAULT`);

    const applied = await migrate(TEST_DB_URL, { schema: SCHEMA });
    expect(applied).toEqual(['1315_project_stage.sql']);
    const read = async () =>
      (
        await client.query(
          `SELECT key, workflow_key, started_as, converted_at, pending_conversion FROM projects ORDER BY key`,
        )
      ).rows;
    expect(await read()).toEqual([
      { key: 'BARE', workflow_key: 'code', started_as: 'code', converted_at: null, pending_conversion: null },
      {
        key: 'CHGD',
        workflow_key: 'code',
        started_as: 'research',
        converted_at: null,
        pending_conversion: null,
      },
      {
        key: 'RESX',
        workflow_key: 'research',
        started_as: 'research',
        converted_at: null,
        pending_conversion: null,
      },
    ]);
    // repository requests may come from a manager now
    await client.query(`SET session_replication_role = replica`);
    await client.query(
      `INSERT INTO repo_requests (id, org_id, project_id, name, visibility, requested_by_agent_id, requested_by_user_id, desk_item_id, status, created_at, updated_at)
       VALUES ('00000000-0000-4000-8000-0000000000e1', $1, $2, 'acme/x', 'private', NULL, $1, $2, 'pending', now(), now())`,
      [U, RES],
    );
    await client.query(`SET session_replication_role = DEFAULT`);

    // Running the file again keeps a value set afterwards (a conversion changes workflow_key, never started_as).
    await client.query(
      `UPDATE projects SET started_as = 'custom', workflow_key = 'support' WHERE key = 'BARE'`,
    );
    const sql = await readFile(join(defaultMigrationsDir(), '1315_project_stage.sql'), 'utf8');
    await client.query(sql);
    await client.query(sql);
    expect((await read()).find((r) => r.key === 'BARE')).toMatchObject({ started_as: 'custom' });
  });
});
