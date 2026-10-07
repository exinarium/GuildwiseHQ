import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import { createFeedProject } from './helpers/feeds.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_LEGACY_FEED_SCHEDULES: 'true' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });

describe('AOM_LEGACY_FEED_SCHEDULES (the e2e stack)', () => {
  it('still creates a feed schedule, which keeps kind feed through an edit; other projects get ordinary schedules', async () => {
    const feedId = await createFeedProject(w);
    const s = await ok<any>(
      owner('POST', '/api/schedules', {
        projectId: feedId,
        name: 'Old feed',
        cron: '0 7 * * *',
        timezone: 'UTC',
        cardTemplate: { title: 'News', fields: { topic: 'reloading' } },
      }),
      201,
    );
    expect(s).toMatchObject({ kind: 'feed', action: { kind: 'create_card' } });
    await ok(owner('PATCH', `/api/schedules/${s.id}`, { name: 'Renamed feed', cron: '0 8 * * *' }));
    expect((await q('SELECT kind, cron FROM schedules WHERE id=$1', [s.id]))[0]).toEqual({
      kind: 'feed',
      cron: '0 8 * * *',
    });
    const code = await ok<any>(
      owner('POST', '/api/schedules', {
        projectId: w.projectId,
        name: 'A card',
        kind: 'card',
        cron: '0 7 * * *',
        cardTemplate: { title: 'Run', fields: {} },
      }),
      201,
    );
    expect(code.kind).toBe('card');
  });
});
