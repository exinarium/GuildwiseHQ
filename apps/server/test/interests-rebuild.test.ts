import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createFeedProject, feedSchedule } from './helpers/feeds.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });

const snap = async () => ({
  interests: (await q(`SELECT to_jsonb(i)::text AS j FROM interests i ORDER BY id`)).map((r) => r.j),
  seeds: (await q(`SELECT to_jsonb(t)::text AS j FROM taste_seeds t ORDER BY project_id`)).map((r) => r.j),
  schedules: (
    await q(`SELECT id, interest_id, enabled, card_template, next_fire_at FROM schedules ORDER BY id`)
  ).map((r) => JSON.stringify(r)),
  cards: (await q(`SELECT id, interest_id FROM cards ORDER BY id`)).map((r) => JSON.stringify(r)),
});

describe('projections:rebuild with interests', () => {
  it('replays interests, taste seeds, schedules.interest_id and cards.interest_id identically', async () => {
    const feedId = await createFeedProject(w);
    const research = await ok<any>(
      owner('POST', '/api/projects', {
        key: 'RES',
        name: 'Research',
        workflowKey: 'research',
        domain: 'personal',
      }),
      201,
    );
    // an adopted schedule with an earlier card (back-filled), a new interest, an edited one, a deleted one
    const old = await ok<any>(feedSchedule(w, feedId, { name: 'Old' }), 201);
    await ok(owner('POST', `/api/schedules/${old.id}/run`), 201);
    await ok(owner('POST', '/api/interests/adopt', { scheduleIds: [old.id] }));
    const a = await ok<any>(
      owner('POST', '/api/interests', {
        name: 'A',
        feedProjectId: feedId,
        researchProjectId: research.project.id,
      }),
      201,
    );
    await ok(owner('POST', `/api/interests/${a.id}/run`), 201);
    await ok(owner('PATCH', `/api/interests/${a.id}`, { description: 'edited', status: 'paused' }));
    await ok(owner('PUT', `/api/interests/${a.id}/taste`, { rules: ['one', 'two'] }));
    const b = await ok<any>(owner('POST', '/api/interests', { name: 'B', feedProjectId: feedId }), 201);
    await ok(owner('PUT', `/api/interests/${b.id}/taste`, { rules: ['b rule'] }));
    await ok(owner('DELETE', `/api/interests/${b.id}?keepSchedule=true`));

    const before = await snap();
    expect(before.interests).toHaveLength(2);
    expect(before.seeds).toHaveLength(1);
    expect(before.cards.filter((c) => !c.includes('"interest_id":null'))).toHaveLength(2);
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect(await snap()).toEqual(before);
  });
});
