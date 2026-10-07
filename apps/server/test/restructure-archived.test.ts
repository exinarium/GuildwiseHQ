import { streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateRestructure } from '../src/data-migrations/index.ts';
import { PgEventStore } from '../src/eventstore/pg-event-store.ts';
import { buildProjectors } from '../src/projections/index.ts';
import { buildLegacyFeeds, type LegacyFeeds } from './fixtures/legacy-feeds.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/** A feed project that was archived before the migration: its interests come out archived, and can be restored. */
let w: World;
let f: LegacyFeeds;
const ctx = () => w.t.app.ctx;
const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  const orgId = (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]?.org_id as string;
  f = await buildLegacyFeeds({ pool: ctx().pool, store: ctx().store, orgId, ownerId: w.owner.id });
  await ctx().store.append([
    {
      streamId: streamId.project(f.newsId),
      event: { type: 'ProjectArchived', payload: { projectId: f.newsId, archivedBy: w.owner.id } },
      actor: { kind: 'user', id: w.owner.id },
      scope: { orgId, projectId: f.newsId, audience: 'project' },
    },
  ]);
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('restructure-2026-10 with an archived feed project', () => {
  it('archives its interests and their new backing projects, and keeps everything restorable', async () => {
    const env = {
      pool: ctx().pool,
      store: new PgEventStore(ctx().pool, buildProjectors(), ctx().clock),
      clock: ctx().clock,
      log: () => {},
    };
    const r = await migrateRestructure(env);
    const rep = r.orgs.find((o) => o.feedProjects > 0);
    expect(rep).toMatchObject({ feedProjects: 1, newProjects: 3 });
    // no vault is registered in this world: said once, nothing moved
    expect(rep?.warnings).toEqual([
      'NEWS: no vault is registered for it, so no folder was moved and no file written',
    ]);
    const live = (await ok<any>(owner('GET', '/api/interests'))).interests.map((i: any) => i.name);
    expect(live).toEqual(['Powders']); // the research-only interest was not on the archived project
    const archived = (await ok<any>(owner('GET', '/api/interests?archived=true'))).interests;
    expect(archived.map((i: any) => i.name).sort()).toEqual(['Optics', 'Reloading', 'Shotguns']);
    expect(archived.every((i: any) => i.archived)).toBe(true);
    expect(
      (await q(`SELECT count(*)::int AS n FROM projects WHERE kind='interest' AND status='archived'`))[0]?.n,
    ).toBe(3);
    // restoring one brings its project back and gives it a fresh schedule
    const rel = archived.find((i: any) => i.name === 'Reloading');
    await ok(owner('POST', `/api/interests/${rel.id}/restore`));
    expect((await q('SELECT status FROM projects WHERE id=$1', [f.newsId]))[0]?.status).toBe('active');
    const restored = (await q('SELECT archived_at, next_scan_at FROM interests WHERE id=$1', [rel.id]))[0];
    expect(restored?.archived_at).toBeNull();
    expect(restored?.next_scan_at).not.toBeNull();
  });
});
