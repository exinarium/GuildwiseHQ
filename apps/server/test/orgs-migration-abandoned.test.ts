import { streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateOrgs, planOrgMigration, runDataMigrations } from '../src/data-migrations/index.ts';
import { createTestApp, type TestApp } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';

// UAT R25 F1: a reclaimed or abandoned sign-up removes its organization but keeps its events, and the next boot
// crash-looped in orgs-2026-10 ("org_id values that are neither an organization nor a user").
let t: TestApp;
const env = () => ({
  pool: t.app.ctx.pool,
  store: t.app.ctx.store,
  clock: t.app.ctx.clock,
  log: () => {},
});

async function abandonSignup(email: string, reason: 'expired' | 'reclaimed'): Promise<string> {
  const userId = await t.createUser(email);
  await t.app.ctx.store.append([
    {
      streamId: streamId.user(userId),
      event: {
        type: 'SignupAbandoned',
        payload: {
          userId,
          orgId: userId,
          email,
          displayName: email.split('@')[0] as string,
          orgName: 'Gone Co',
          registeredAt: new Date().toISOString(),
          reason,
        },
      },
      actor: { kind: 'system', id: null },
      scope: { orgId: userId, projectId: null, audience: 'org' },
    },
  ]);
  return userId;
}

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

describe('orgs-2026-10 after a removed sign-up', () => {
  it('the plan ignores the org_id of an abandoned sign-up, before the migration has run', async () => {
    await t.createUser('owner@keep.test');
    const gone = await abandonSignup('gone@expired.test', 'expired');
    expect(await q('SELECT 1 FROM organizations WHERE id=$1', [gone])).toHaveLength(0);
    expect((await q('SELECT count(*)::int AS n FROM events WHERE org_id=$1', [gone]))[0]?.n).toBeGreaterThan(
      0,
    );
    const plan = await planOrgMigration(t.app.ctx.pool);
    expect(plan.orgs.map((o) => o.userId)).not.toContain(gone);
    const r = await migrateOrgs(env());
    expect(r.created).toBe(0);
    expect((await q(`SELECT 1 FROM data_migrations WHERE name='orgs-2026-10'`)).length).toBe(1);
  });

  it('a reclaimed sign-up after the migration, then a restart: the boot step does not abort', async () => {
    const gone = await abandonSignup('gone@reclaimed.test', 'reclaimed');
    await expect(planOrgMigration(t.app.ctx.pool)).resolves.toBeDefined();
    const r = await migrateOrgs(env());
    expect(r.alreadyDone).toBe(true);
    expect(await q('SELECT 1 FROM organizations WHERE id=$1', [gone])).toHaveLength(0);
  });

  it('a completed migration is skipped on boot, even when the data has an org_id it cannot explain', async () => {
    const stray = '00000000-0000-4000-8000-00000000beef';
    await q(
      `INSERT INTO events (stream_id, stream_version, type, payload, actor_kind, org_id, audience, created_at)
       VALUES ('stray-f1', 1, 'Stray', '{}', 'system', $1, 'org', now())`,
      [stray],
    );
    // the read-only plan (the CLI dry run) still reports it; the boot does not re-run a recorded migration
    await expect(planOrgMigration(t.app.ctx.pool)).rejects.toThrow(/neither an organization nor a user/);
    const events = (await q('SELECT count(*)::int AS n FROM events'))[0]?.n;
    await expect(migrateOrgs(env())).resolves.toMatchObject({ alreadyDone: true, created: 0 });
    expect((await q('SELECT count(*)::int AS n FROM events'))[0]?.n).toBe(events);
  });

  it('the whole boot run of data migrations completes after a removed sign-up', async () => {
    await abandonSignup('again@reclaimed.test', 'reclaimed');
    await expect(runDataMigrations(env())).resolves.toBeUndefined();
    await expect(runDataMigrations(env())).resolves.toBeUndefined();
  });
});
