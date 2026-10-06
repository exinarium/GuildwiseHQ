import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateOrgs, planOrgMigration } from '../src/data-migrations/index.ts';
import { PROJECTION_TABLES } from '../src/projections/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { createTestApp, type TestApp } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { buildLegacyWorld, type LegacyWorld } from './helpers/legacy.ts';

let t: TestApp;
let w: LegacyWorld;
const env = () => ({
  pool: t.app.ctx.pool,
  store: t.app.ctx.store,
  clock: t.app.ctx.clock,
  log: () => {},
});

beforeAll(async () => {
  t = await createTestApp();
  w = await buildLegacyWorld(t);
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
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
    const rows = await q(`SELECT (to_jsonb(t)${drop})::text AS j FROM "${table}" t`);
    out[table] = rows.map((r) => r.j as string).sort();
  }
  return out;
}

describe('orgs-2026-10: the legacy database becomes organizations', () => {
  it('starts as the legacy shape: users and data, no organizations, unvalidated org foreign keys', async () => {
    expect((await q('SELECT count(*)::int AS n FROM organizations'))[0]?.n).toBe(0);
    expect((await q('SELECT count(*)::int AS n FROM users'))[0]?.n).toBe(3);
    const bad = await q(
      `SELECT 1 FROM pg_constraint WHERE confrelid='organizations'::regclass AND NOT convalidated`,
    );
    expect(bad.length).toBeGreaterThan(10);
  });

  it('a dry run reports the plan and writes nothing', async () => {
    const before = (await q('SELECT count(*)::int AS n FROM events'))[0]?.n;
    const plan = await migrateOrgs(env(), { dryRun: true });
    expect(plan.dryRun).toBe(true);
    expect(plan.created).toBe(0);
    expect(plan.orgs.map((o) => o.email).sort()).toEqual([
      'ada@legacy.test',
      'lone@legacy.test',
      'sam@legacy.test',
    ]);
    const ada = plan.orgs.find((o) => o.email === 'ada@legacy.test');
    expect(ada?.name).toBe("Ada Legacy's organization");
    expect(ada?.dataRows).toBeGreaterThan(5);
    expect(plan.orgs.find((o) => o.email === 'lone@legacy.test')?.dataRows).toBe(0);
    // Sam only had shared access: that becomes guest access
    expect(plan.guests).toEqual([
      expect.objectContaining({ email: 'sam@legacy.test', projectKey: 'TEST01', orgUserId: w.admin.id }),
    ]);
    expect((await q('SELECT count(*)::int AS n FROM events'))[0]?.n).toBe(before);
    expect((await q('SELECT count(*)::int AS n FROM organizations'))[0]?.n).toBe(0);
  });

  it('gives every user an organization with their own id, validates the keys, and records itself', async () => {
    const r = await migrateOrgs(env());
    expect(r.created).toBe(3);
    expect(r.validated).toBeGreaterThan(10);
    const orgs = await q(
      'SELECT id, name, owner_user_id, status, plan, created_via, max_agents FROM organizations ORDER BY name',
    );
    expect(orgs.map((o) => o.id).sort()).toEqual([w.admin.id, w.lonely.id, w.member.id].sort());
    for (const o of orgs) {
      expect(o.owner_user_id).toBe(o.id);
      expect(o).toMatchObject({
        status: 'active',
        plan: 'founding',
        created_via: 'legacy_migration',
        max_agents: null,
      });
    }
    const members = await q('SELECT org_id, user_id, role, status FROM org_members');
    expect(members).toHaveLength(3);
    expect(members.every((m) => m.org_id === m.user_id && m.role === 'owner' && m.status === 'active')).toBe(
      true,
    );
    expect(
      await q(`SELECT 1 FROM pg_constraint WHERE confrelid='organizations'::regclass AND NOT convalidated`),
    ).toHaveLength(0);
    expect((await q(`SELECT count(*)::int AS n FROM data_migrations WHERE name='orgs-2026-10'`))[0]?.n).toBe(
      1,
    );
  });

  it('keeps the data where it was: no org_id column was rewritten, the admin owns the project, Sam is a guest', async () => {
    expect((await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]?.org_id).toBe(w.admin.id);
    expect((await q('SELECT count(*)::int AS n FROM agents WHERE org_id=$1', [w.admin.id]))[0]?.n).toBe(2);
    expect((await q('SELECT org_id FROM vaults WHERE id=$1', [w.vaultId]))[0]?.org_id).toBe(w.admin.id);
    const pm = await q(
      'SELECT user_id, role, status, direct, org_grant FROM project_members WHERE project_id=$1 ORDER BY role',
      [w.projectId],
    );
    expect(pm.find((r) => r.user_id === w.admin.id)).toMatchObject({
      role: 'owner',
      status: 'active',
      org_grant: true,
    });
    expect(pm.find((r) => r.user_id === w.member.id)).toMatchObject({
      role: 'manager',
      status: 'active',
      direct: true,
      org_grant: false,
    });
    // the pending legacy invitation still works
    const inv = await q(`SELECT kind, status FROM invitations WHERE id=$1`, [w.pendingInvitationId]);
    expect(inv[0]).toMatchObject({ kind: 'legacy', status: 'pending' });
  });

  it('writes one desk notice per organization, addressed to its Owner', async () => {
    const items = await q(
      `SELECT org_id, addressee_user_id, kind, subkind, status, project_id FROM desk_items WHERE subkind='org_migrated'`,
    );
    expect(items).toHaveLength(3);
    for (const i of items)
      expect(i).toMatchObject({
        kind: 'alert',
        status: 'open',
        project_id: null,
        addressee_user_id: i.org_id,
      });
  });

  it('is idempotent: a second run (and the plan) finds nothing to do', async () => {
    const events = (await q('SELECT count(*)::int AS n FROM events'))[0]?.n;
    const again = await migrateOrgs(env());
    expect(again.created).toBe(0);
    expect(again.validated).toBe(0);
    expect((await q('SELECT count(*)::int AS n FROM events'))[0]?.n).toBe(events);
    expect((await planOrgMigration(t.app.ctx.pool)).orgs).toHaveLength(0);
  });

  it('a user created after the upgrade (with an organization of their own) is left alone', async () => {
    const id = await t.createUser('new@after.test', 'member');
    const events = (await q('SELECT count(*)::int AS n FROM events'))[0]?.n;
    const r = await migrateOrgs(env());
    expect(r.created).toBe(0);
    expect((await q('SELECT count(*)::int AS n FROM events'))[0]?.n).toBe(events);
    expect((await q('SELECT count(*)::int AS n FROM organizations WHERE owner_user_id=$1', [id]))[0]?.n).toBe(
      1,
    );
  });

  it('survives a projection rebuild: the late OrganizationCreated events satisfy the deferred foreign keys', async () => {
    const before = await snapshot();
    const r = await rebuildProjections(t.app.ctx.pool, t.app.ctx.store);
    expect(r.events).toBeGreaterThan(10);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses to guess when an org_id is neither an organization nor a user', async () => {
    const stray = '00000000-0000-4000-8000-00000000dead';
    await q(
      `INSERT INTO events (stream_id, stream_version, type, payload, actor_kind, org_id, audience, created_at)
       VALUES ('stray-1', 1, 'Stray', '{}', 'system', $1, 'org', now())`,
      [stray],
    );
    await expect(planOrgMigration(t.app.ctx.pool)).rejects.toThrow(/neither an organization nor a user/);
  });
});
