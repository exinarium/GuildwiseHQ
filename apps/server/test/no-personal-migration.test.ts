import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  formatNoPersonalPlan,
  migrateNoPersonal,
  NO_PERSONAL_MIGRATION,
  planNoPersonal,
} from '../src/data-migrations/index.ts';
import { defaultMigrationsDir, migrate, withPendingMigrations } from '../src/db/migrate.ts';
import { PgEventStore } from '../src/eventstore/pg-event-store.ts';
import { buildProjectors, PROJECTION_TABLES } from '../src/projections/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q, TEST_DB_URL } from './helpers/db.ts';
import { registerLegacyVault, snapshotDomain } from './helpers/domains.ts';
import { createWorld, ok, pairWorkstation, type World } from './helpers/world.ts';

/**
 * `no-personal-2026-10` against the shape of the live UAT database: one organization with one member, a work project
 * (TOY), the hidden project of an interest (AINEWS), a work vault and a personal vault. Plus personal projects,
 * personal interests and a second member, so the order, the folder lifts and the Owner's notice are all exercised.
 */
let w: World;
const ctx = () => w.t.app.ctx;
const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
// A store with no hooks, like the one the boot migration uses.
const env = () => ({
  pool: ctx().pool,
  store: new PgEventStore(ctx().pool, buildProjectors(), ctx().clock),
  clock: ctx().clock,
  log: () => {},
});

const OPERATIONAL: Record<string, string[]> = {
  users: ['last_login_at', 'last_org_id'],
  workstations: ['connected', 'last_seen_at', 'runtimes', 'hostname', 'platform', 'runner_version'],
  cards: ['lease_expires_at'],
  shifts: ['progress_tail', 'accepted_at'],
  card_transitions: ['id'],
  card_activity: ['id'],
};
async function snapshot(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const table of PROJECTION_TABLES) {
    const drop = (OPERATIONAL[table] ?? []).map((c) => ` - '${c}'`).join('');
    out[table] = (await q(`SELECT (to_jsonb(t)${drop})::text AS j FROM "${table}" t`))
      .map((r) => r.j as string)
      .sort();
  }
  return out;
}

const ids: Record<string, string> = {};
let orgId: string;
let workVault: string;
let personalVault: string;
const keysByRank = async () =>
  (await q(`SELECT key FROM projects WHERE org_id=$1 AND kind='project' ORDER BY rank`, [orgId])).map(
    (r) => r.key as string,
  );
const count = async (type: string) =>
  (await q(`SELECT count(*)::int AS n FROM events WHERE type=$1`, [type]))[0]!.n as number;
const mergeCommands = () => q(`SELECT * FROM runner_commands WHERE type='vault.merge' ORDER BY created_at`);

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  orgId = (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]?.org_id as string;
  // The old data: TOY (work, tier 2, the world's own project), and personal projects, created later than the work ones.
  ids.TOY = w.projectId;
  for (const [key, name] of [
    ['SIDE', 'Side project'],
    ['HOBBY', 'Hobby'],
    ['WORK2', 'Second work project'],
  ] as const) {
    const p = await ok<any>(owner('POST', '/api/projects', { key, name }), 201);
    ids[key] = p.project.id;
  }
  // the old ordering key: work first, then the tier, then age
  await snapshotDomain(ids.TOY!, 'work', 2);
  await snapshotDomain(ids.SIDE!, 'personal', 2);
  await snapshotDomain(ids.HOBBY!, 'personal', 1);
  await snapshotDomain(ids.WORK2!, 'work', 1);
  // Two interests: AINEWS lived in the personal vault, the work one in the work vault.
  for (const [name, domain] of [
    ['AI news', 'personal'],
    ['Competitor watch', 'work'],
  ] as const) {
    const i = await ok<{ id: string }>(
      owner('POST', '/api/interests', { name, scan: { manual: true } }),
      201,
    );
    const row = (await q('SELECT project_id, slug FROM interests WHERE id=$1', [i.id]))[0]!;
    ids[name] = row.project_id;
    await snapshotDomain(row.project_id, domain);
  }
  workVault = await registerLegacyVault(w.t, {
    orgId,
    kind: 'work',
    remoteUrl: 'git@example.test:srv/work.git',
  });
  personalVault = await registerLegacyVault(w.t, {
    orgId,
    kind: 'personal',
    remoteUrl: 'git@example.test:srv/personal.git',
  });
  // what the SQL migration seeded before the data migration: the creation order
  await q(`UPDATE projects SET rank = NULL WHERE org_id=$1`, [orgId]);
  let n = 0;
  for (const k of ['TOY', 'SIDE', 'HOBBY', 'WORK2'])
    await q('UPDATE projects SET rank=$2 WHERE id=$1', [ids[k], ++n]);
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('the plan (--dry-run)', () => {
  it('reads what would happen and writes nothing', async () => {
    const eventsBefore = (await q('SELECT count(*)::int AS n FROM events'))[0]!.n;
    const plan = await planNoPersonal(ctx().pool);
    expect(plan.alreadyDone).toBe(false);
    const org = plan.orgs.find((o) => o.orgId === orgId);
    expect(org).toMatchObject({
      rankPending: true,
      vaultPending: true,
      vaultAction: 'merge',
      workstationAvailable: true,
      liftedInterests: ['interests/ai-news'],
    });
    expect(org?.projects.map((p) => `${p.newRank}:${p.key}:${p.domain}`)).toEqual([
      '1:WORK2:work',
      '2:TOY:work',
      '3:HOBBY:personal',
      '4:SIDE:personal',
    ]);
    expect(org?.projects.find((p) => p.key === 'SIDE')?.vaultDir).toEqual({
      from: 'projects/side',
      to: 'personal/projects/side',
    });
    const text = formatNoPersonalPlan(plan);
    expect(text).toContain('has not run yet');
    expect(text).toContain('personal vault');
    expect(text).toContain('interests/ai-news');
    expect(text).toMatch(/1\. WORK2/);
    expect((await q('SELECT count(*)::int AS n FROM events'))[0]!.n).toBe(eventsBefore);
    expect(await mergeCommands()).toHaveLength(0);
    expect(await q(`SELECT 1 FROM data_migrations WHERE name LIKE 'no-personal%'`)).toHaveLength(0);
    // migrateNoPersonal with dryRun is the same read
    expect((await migrateNoPersonal(env(), { dryRun: true })).dryRun).toBe(true);
    expect(await keysByRank()).toEqual(['TOY', 'SIDE', 'HOBBY', 'WORK2']);
  });
});

describe('the migration', () => {
  let before: Record<string, string[]>;

  it('ranks work before personal in the old tier order, merges the personal vault and tells the Owner', async () => {
    const report = await migrateNoPersonal(env());
    const org = report.orgs.find((o) => o.orgId === orgId);
    expect(org).toMatchObject({
      ranked: 4,
      personalProjects: 2,
      vault: 'merged',
      liftedInterests: 1,
      warnings: [],
    });

    // the ranking: work (tier, age) then personal (tier, age); the interests are not ranked
    expect(await keysByRank()).toEqual(['WORK2', 'TOY', 'HOBBY', 'SIDE']);
    expect(
      (await q(`SELECT rank FROM projects WHERE kind='interest' AND org_id=$1`, [orgId])).map((r) => r.rank),
    ).toEqual([null, null]);
    const ranked = (await q(`SELECT payload FROM events WHERE type='ProjectsRanked'`))[0]!.payload;
    expect(ranked).toMatchObject({ orgId, reason: 'migration' });
    expect(ranked.projectIds).toEqual(['WORK2', 'TOY', 'HOBBY', 'SIDE'].map((k) => ids[k]));

    // the vault: the personal row is gone, the work vault is the organization vault, one merge command is queued
    expect(
      (await q('SELECT id, kind FROM vaults WHERE project_id IS NULL')).map((v) => [v.id, v.kind]),
    ).toEqual([[workVault, 'org']]);
    expect(await count('VaultMerged')).toBe(1);
    const cmds = await mergeCommands();
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({ workstation_id: w.workstationId, status: 'pending' });
    expect(cmds[0]!.payload).toEqual({
      vaultId: workVault,
      from: { vaultId: personalVault, remoteUrl: 'git@example.test:srv/personal.git' },
      into: 'personal',
      lift: ['interests/ai-news'],
      commitMessage: 'aom: merge the personal vault into the organization vault',
      push: true,
    });
    // the personal projects read their folders from personal/; work projects and interests are untouched
    expect(
      Object.fromEntries(
        (await q('SELECT key, vault_dir FROM projects WHERE vault_dir IS NOT NULL')).map((p) => [
          p.key,
          p.vault_dir,
        ]),
      ),
    ).toMatchObject({ SIDE: 'personal/projects/side', HOBBY: 'personal/projects/hobby' });
    expect((await q(`SELECT vault_dir FROM projects WHERE key='TOY'`))[0]!.vault_dir).toBeNull();
    expect((await q(`SELECT vault_dir FROM projects WHERE id=$1`, [ids['AI news']]))[0]!.vault_dir).toBe(
      'interests/ai-news',
    );

    // the Owner's desk
    const notice = (await q(`SELECT * FROM desk_items WHERE subkind='no_personal_migrated'`))[0]!;
    expect(notice).toMatchObject({
      kind: 'alert',
      addressee_user_id: w.owner.id,
      org_id: orgId,
      status: 'open',
    });
    expect(notice.title).toBe('Projects are ranked now, and personal is gone');
    expect(notice.body).toContain('HOBBY, SIDE');
    expect(notice.body).toContain('personal/');
    expect(notice.body).toContain('interests/ai-news');
    const item = (await ok<any>(owner('GET', '/api/desk'))).items.find(
      (i: any) => i.subkind === 'no_personal_migrated',
    );
    expect(item).toBeTruthy();

    // the rows are recorded, the whole migration too
    expect(
      (await q(`SELECT name FROM data_migrations WHERE name LIKE 'no-personal%' ORDER BY name`)).map(
        (r) => r.name,
      ),
    ).toEqual([
      NO_PERSONAL_MIGRATION,
      `${NO_PERSONAL_MIGRATION}/rank/${orgId}`,
      `${NO_PERSONAL_MIGRATION}/vault/${orgId}`,
    ]);
    before = await snapshot();
  });

  it('the API shows the ranking and no domain', async () => {
    const list = (await ok<any>(owner('GET', '/api/projects'))).projects;
    expect(list.map((p: any) => `${p.rank}:${p.key}`)).toEqual(['1:WORK2', '2:TOY', '3:HOBBY', '4:SIDE']);
    expect(list[0]).not.toHaveProperty('domain');
    expect(list[0]).not.toHaveProperty('priorityTier');
    const vaults = (await ok<any>(owner('GET', '/api/vaults'))).vaults;
    expect(vaults.map((v: any) => v.kind)).toEqual(['org']);
  });

  it('is idempotent: running it again changes nothing, not even a ranking the Owner changed meanwhile', async () => {
    const events = (await q('SELECT count(*)::int AS n FROM events'))[0]!.n;
    // the Owner reorders by hand
    const order = ['SIDE', 'TOY', 'WORK2', 'HOBBY'];
    await ok(owner('PUT', '/api/projects/ranking', { projectIds: order.map((k) => ids[k]) }));
    const afterManual = (await q('SELECT count(*)::int AS n FROM events'))[0]!.n;
    expect(afterManual).toBe(events + 1);
    const report = await migrateNoPersonal(env());
    expect(report.plan.alreadyDone).toBe(true);
    expect(report.orgs).toEqual([]);
    expect((await q('SELECT count(*)::int AS n FROM events'))[0]!.n).toBe(afterManual);
    expect(await mergeCommands()).toHaveLength(1);
    expect(await count('DeskItemCreated')).toBeGreaterThan(0);
    expect(
      (await q(`SELECT count(*)::int AS n FROM desk_items WHERE subkind='no_personal_migrated'`))[0]!.n,
    ).toBe(1);
    expect(await keysByRank()).toEqual(order);
    // and the plan says so
    expect(formatNoPersonalPlan(await planNoPersonal(ctx().pool))).toContain('has already run');
    // put the migration's ranking back for the rebuild comparison below
    await ok(
      owner('PUT', '/api/projects/ranking', {
        projectIds: ['WORK2', 'TOY', 'HOBBY', 'SIDE'].map((k) => ids[k]),
      }),
    );
    before = await snapshot();
  });

  it('is rebuild-safe: replaying the events reproduces every projection', async () => {
    await rebuildProjections(ctx().pool, ctx().store);
    expect(await snapshot()).toEqual(before);
    expect(await keysByRank()).toEqual(['WORK2', 'TOY', 'HOBBY', 'SIDE']);
    expect((await q('SELECT kind FROM vaults WHERE project_id IS NULL')).map((v) => v.kind)).toEqual(['org']);
    expect((await q(`SELECT vault_dir FROM projects WHERE key='SIDE'`))[0]!.vault_dir).toBe(
      'personal/projects/side',
    );
  });

  it('the dispatcher and the vault lookup use the organization vault only', async () => {
    // a project without its own vault reads the organization vault on the Owner's workstation (folder under personal/)
    const { vaultForProject } = await import('../src/commands/vaults.ts');
    expect(await vaultForProject(ctx().pool, ids.SIDE!, w.owner.id)).toEqual({
      id: workVault,
      kind: 'org',
      folder: 'personal/projects/side',
    });
    expect(await vaultForProject(ctx().pool, ids.TOY!, w.owner.id)).toEqual({
      id: workVault,
      kind: 'org',
      folder: 'projects/toy',
    });
  });
});

describe('other shapes', () => {
  it('an organization with only a personal vault keeps it as the organization vault (nothing moves), and a member org gets its notice for the Owner', async () => {
    const t = w.t;
    const ownerS = await t.userSession(uniqueEmail('owner2'));
    const memberS = await t.userSession(uniqueEmail('member2'));
    const org2 = await t.createOrg(ownerS.id, 'Second');
    await t.addOrgMember(org2, memberS.id, 'member');
    const ws = await pairWorkstation(t, ownerS, 'owner2-box');
    void ws;
    const p = await ok<any>(
      t.req('POST', '/api/projects', {
        cookie: ownerS.cookie,
        headers: { 'x-aom-org': org2 },
        body: { key: 'ONLY', name: 'Only' },
      }),
      201,
    );
    await snapshotDomain(p.project.id, 'personal', 3);
    const only = await registerLegacyVault(t, {
      orgId: org2,
      kind: 'personal',
      remoteUrl: 'git@example.test:srv/only.git',
    });
    const before = (await mergeCommands()).length;
    const report = await migrateNoPersonal(env());
    expect(report.orgs.find((o) => o.orgId === org2)).toMatchObject({ vault: 'promoted', ranked: 1 });
    expect(await q('SELECT id, kind, name FROM vaults WHERE org_id=$1', [org2])).toEqual([
      { id: only, kind: 'org', name: 'Organization vault' },
    ]);
    expect((await mergeCommands()).length).toBe(before);
    const notice = (
      await q(
        `SELECT addressee_user_id, body FROM desk_items WHERE org_id=$1 AND subkind='no_personal_migrated'`,
        [org2],
      )
    )[0]!;
    expect(notice.addressee_user_id).toBe(ownerS.id); // the Owner, not the member
    expect(notice.body).toContain('became it');
    // an organization created after the migration is never touched: its ranking is its Owner's
    const org3 = await t.createOrg(ownerS.id, 'Third');
    await ok(
      t.req('POST', '/api/projects', {
        cookie: ownerS.cookie,
        headers: { 'x-aom-org': org3 },
        body: { key: 'NEW', name: 'New' },
      }),
      201,
    );
    const rankedEvents = await count('ProjectsRanked');
    await migrateNoPersonal(env());
    expect(await count('ProjectsRanked')).toBe(rankedEvents);
  });

  it('waits for a workstation when the personal vault cannot be merged yet, ranks anyway, and finishes on the next run', async () => {
    const t = w.t;
    const ownerS = await t.userSession(uniqueEmail('owner4'));
    const org4 = await t.createOrg(ownerS.id, 'Fourth');
    const p = await ok<any>(
      t.req('POST', '/api/projects', {
        cookie: ownerS.cookie,
        headers: { 'x-aom-org': org4 },
        body: { key: 'WAIT', name: 'Wait' },
      }),
      201,
    );
    await snapshotDomain(p.project.id, 'work', 2);
    await registerLegacyVault(t, { orgId: org4, kind: 'work', remoteUrl: 'git@example.test:srv/w4.git' });
    const personal = await registerLegacyVault(t, {
      orgId: org4,
      kind: 'personal',
      remoteUrl: 'git@example.test:srv/p4.git',
    });
    const first = await migrateNoPersonal(env());
    expect(first.orgs.find((o) => o.orgId === org4)).toMatchObject({ vault: 'waiting', ranked: 1 });
    expect(first.orgs.find((o) => o.orgId === org4)?.warnings.join(' ')).toMatch(/no workstation/);
    // the ranking is done, the vault is still there, the whole migration is not marked done
    expect(await q('SELECT 1 FROM vaults WHERE id=$1', [personal])).toHaveLength(1);
    expect(
      await q(`SELECT 1 FROM data_migrations WHERE name=$1`, [`${NO_PERSONAL_MIGRATION}/rank/${org4}`]),
    ).toHaveLength(1);
    expect(
      await q(`SELECT 1 FROM data_migrations WHERE name=$1`, [`${NO_PERSONAL_MIGRATION}/vault/${org4}`]),
    ).toHaveLength(0);
    const rankedEvents = await count('ProjectsRanked');
    // a workstation is paired: the next run merges (and does not rank again)
    await pairWorkstation(t, ownerS, 'owner4-box');
    const second = await migrateNoPersonal(env());
    expect(second.orgs.find((o) => o.orgId === org4)).toMatchObject({ vault: 'merged', ranked: 0 });
    expect(await count('ProjectsRanked')).toBe(rankedEvents);
    expect(await q('SELECT 1 FROM vaults WHERE id=$1', [personal])).toHaveLength(0);
    expect((await mergeCommands()).filter((c) => (c.payload as any).from.vaultId === personal)).toHaveLength(
      1,
    );
  });
});

describe('dry run on a database that is not migrated yet (withPendingMigrations)', () => {
  const SCHEMA = 'mig_nopers';
  const client = new pg.Client({ connectionString: TEST_DB_URL });
  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await client.end().catch(() => {});
  });

  it('applies the pending SQL migration in a rolled-back transaction, plans from the migrated schema, writes nothing', async () => {
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    const dir = await mkdtemp(join(tmpdir(), 'aom-mig-'));
    await cp(defaultMigrationsDir(), dir, { recursive: true });
    await rm(join(dir, '1322_project_ranking.sql'));
    await migrate(TEST_DB_URL, { schema: SCHEMA, dir });
    // the live shape: projects with a domain and a tier, a work and a personal vault, one organization
    await client.query(`SET search_path TO ${SCHEMA}`);
    await client.query(`SET session_replication_role = replica`);
    const O = '00000000-0000-4000-8000-0000000000f1';
    await client.query(
      `INSERT INTO organizations (id, name, owner_user_id, status, status_changed_at, plan, created_via, created_at)
       VALUES ($1, 'Pieter''s organization', $1, 'active', now(), 'free', 'legacy_migration', now())`,
      [O],
    );
    const project = (id: string, key: string, domain: string, tier: number, kind = 'project') =>
      client.query(
        `INSERT INTO projects (id, org_id, key, name, domain, workflow_key, priority_tier, kind, created_at)
         VALUES ($1, $2, $3, $3, $4, 'code', $5, $6, now() + ($7 || ' seconds')::interval)`,
        [id, O, key, domain, tier, kind, String(tier)],
      );
    await project('00000000-0000-4000-8000-0000000000a1', 'TEST01', 'work', 2);
    await project('00000000-0000-4000-8000-0000000000a2', 'AINEWS', 'personal', 2, 'interest');
    for (const [id, kind] of [
      ['00000000-0000-4000-8000-0000000000b1', 'work'],
      ['00000000-0000-4000-8000-0000000000b2', 'personal'],
    ])
      await client.query(
        `INSERT INTO vaults (id, org_id, kind, name, remote_url, created_at) VALUES ($1, $2, $3, 'v', 'git@example.test:x.git', now())`,
        [id, O, kind],
      );
    await client.query(`SET session_replication_role = DEFAULT`);
    const migrationsBefore = (await client.query(`SELECT count(*)::int AS n FROM schema_migrations`)).rows[0]
      .n;

    const { result, pending } = await withPendingMigrations(
      TEST_DB_URL,
      (db) => planNoPersonal(db as never),
      { schema: SCHEMA },
    );
    expect(pending).toEqual(['1322_project_ranking.sql']);
    expect(result.orgs).toHaveLength(1);
    expect(result.orgs[0]).toMatchObject({
      name: "Pieter's organization",
      rankPending: true,
      vaultPending: true,
      // the work vault was renamed to the organization vault by the pending SQL migration
      vaultAction: 'merge',
      liftedInterests: [],
    });
    expect(result.orgs[0]?.projects.map((p) => `${p.key}:${p.domain}:${p.newRank}`)).toEqual([
      'TEST01:work:1',
    ]);
    // nothing was written: the migration is still pending and the columns are still there
    expect((await client.query(`SELECT count(*)::int AS n FROM schema_migrations`)).rows[0].n).toBe(
      migrationsBefore,
    );
    expect(
      (await client.query(`SELECT to_regclass('${SCHEMA}.legacy_project_domains') AS t`)).rows[0].t,
    ).toBeNull();
    expect(
      (
        await client.query(
          `SELECT 1 FROM information_schema.columns WHERE table_schema='${SCHEMA}' AND table_name='projects' AND column_name='domain'`,
        )
      ).rowCount,
    ).toBe(1);

    // The real thing on the same data: the SQL migration seeds the rank and the snapshot, keeps the personal vault
    await migrate(TEST_DB_URL, { schema: SCHEMA });
    expect((await client.query(`SELECT key, domain FROM legacy_project_domains ORDER BY key`)).rows).toEqual([
      { key: 'AINEWS', domain: 'personal' },
      { key: 'TEST01', domain: 'work' },
    ]);
    expect((await client.query(`SELECT key, rank FROM projects ORDER BY key`)).rows).toEqual([
      { key: 'AINEWS', rank: null },
      { key: 'TEST01', rank: 1 },
    ]);
    expect((await client.query(`SELECT kind FROM vaults ORDER BY kind`)).rows.map((r) => r.kind)).toEqual([
      'org',
      'personal',
    ]);
    // and the migration is safe to run twice (a second `migrate` finds nothing pending)
    expect(await migrate(TEST_DB_URL, { schema: SCHEMA })).toEqual([]);
  });
});
