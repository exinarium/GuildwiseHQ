import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rebuildProjections, unsavedCascadeTargets } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ listen: false, env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('platform team and projection rebuild', () => {
  it('keeps open pauses (a projection of events) and leaves the operational bug tables alone', async () => {
    const root = await w.t.superAdminSession();
    await ok(
      w.t.req('PUT', '/api/platform/team', {
        cookie: root.cookie,
        body: { orgId: w.owner.id, projectId: w.projectId },
      }),
    );
    const other = await ok<any>(
      w.t.req('POST', '/api/projects', { cookie: w.owner.cookie, body: { key: 'OTH', name: 'Other' } }),
      201,
    );
    await ok(
      w.t.req('POST', '/api/platform-team/pauses', {
        cookie: w.owner.cookie,
        body: { projectId: other.project.id, reason: 'rebuild me' },
      }),
    );
    await q(
      `INSERT INTO platform_bugs (signature, source, title, first_seen_at, last_seen_at) VALUES ('s','manual','t',now(),now())`,
    );
    expect(await unsavedCascadeTargets(w.t.app.ctx.pool)).toEqual([]);
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    const list = await q('SELECT * FROM platform_pauses');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ project_id: other.project.id, reason: 'rebuild me', resumed_at: null });
    expect(await q('SELECT 1 FROM platform_bugs')).toHaveLength(1);
    // the designation (platform_settings) and decisions_project_only survive too
    expect(
      (await q('SELECT decisions_project_only FROM projects WHERE id=$1', [w.projectId]))[0]
        ?.decisions_project_only,
    ).toBe(true);
  });
});
