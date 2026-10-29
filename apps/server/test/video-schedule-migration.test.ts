import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { VideoScript } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_ACTOR, userActor } from '../src/commands/common.ts';
import { insertLibraryRender, RENDER_DEFERRED, videoPostStream } from '../src/commands/video-posts.ts';
import { migrateVideoSchedule, VIDEO_SCHEDULE_MIGRATION } from '../src/data-migrations/index.ts';
import { PgEventStore } from '../src/eventstore/pg-event-store.ts';
import { buildProjectors } from '../src/projections/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { createTestApp, type TestApp } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';

/**
 * `video-schedule-2026-10` against the shape of the live database: one approved library video (lib:overview) already on
 * YouTube with its slot, several library imports waiting in review, six rejected release videos with failed renders. Plus
 * an approved video waiting to upload (with the slot it had reserved) and two writer drafts in review, one with a finished
 * render and one whose render was only queued.
 */
const LONG: VideoScript = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../../packages/video/test/fixtures/agents-long.json'),
    'utf8',
  ),
);
let t: TestApp;
let admin: { id: string };
const adminScope = { orgId: null, projectId: null, audience: 'admin' } as const;
const env = () => ({
  pool: t.app.ctx.pool,
  store: new PgEventStore(t.app.ctx.pool, buildProjectors(), t.app.ctx.clock),
  clock: t.app.ctx.clock,
  log: () => {},
});

const ids: Record<string, string> = {};

async function submitted(
  key: string,
  ref: string,
  opts: {
    kind?: 'article' | 'release' | 'tutorial';
    status?: 'draft' | 'in_review';
    lib?: boolean;
    origin?: boolean;
  } = {},
) {
  const postId = randomUUID();
  ids[key] = postId;
  await t.app.ctx.store.append([
    {
      streamId: videoPostStream(postId),
      event: {
        type: 'VideoPostSubmitted',
        payload: {
          postId,
          kind: opts.kind ?? 'article',
          format: 'long',
          ref,
          script: opts.lib ? null : { ...LONG, ref },
          meta: { ...LONG.meta, title: `Title of ${key}` },
          origin: opts.origin ? { system: 'blog-writer' } : { userId: admin.id },
          status: opts.status ?? 'in_review',
        },
      },
      actor: opts.origin ? SYSTEM_ACTOR : userActor(admin.id),
      scope: adminScope,
    },
  ]);
  return postId;
}
/** The old approval: pins the rendered revision. */
async function oldApprove(postId: string, renderId: string) {
  await t.app.ctx.store.append([
    {
      streamId: videoPostStream(postId),
      event: { type: 'VideoPostApproved', payload: { postId, renderId, by: admin.id } },
      actor: userActor(admin.id),
      scope: adminScope,
    },
  ]);
}
async function render(postId: string, status: string, extra: { error?: string; library?: boolean } = {}) {
  const id = randomUUID();
  await q(
    `INSERT INTO video_renders (id, post_id, revision, status, attempts, error, artifacts, library, created_at, finished_at)
     VALUES ($1,$2,1,$3,1,$4,$5::jsonb,$6, now(), now())`,
    [
      id,
      postId,
      status,
      extra.error ?? null,
      JSON.stringify(status === 'rendered' ? { video: `${postId}/1/video.mp4` } : {}),
      !!extra.library,
    ],
  );
  return id;
}
async function share(postId: string, status: string, detail: Record<string, unknown>, videoId?: string) {
  await q(
    `INSERT INTO social_shares (post_id, network, source, status, external_id, url, created_at, updated_at, detail)
     VALUES ($1,'youtube','video',$2,$3,$4, now(), now(), $5::jsonb)`,
    [
      postId,
      status,
      videoId ?? null,
      videoId ? `https://www.youtube.com/watch?v=${videoId}` : null,
      JSON.stringify(detail),
    ],
  );
}

beforeAll(async () => {
  t = await createTestApp();
  admin = await t.superAdminSession();
  await q('DELETE FROM video_renders');
  await q('DELETE FROM social_shares');
  await q('DELETE FROM video_posts');
  await q('DELETE FROM platform_settings WHERE key = $1', ['video_posts']);

  // lib:overview: approved, on YouTube, with the slot YouTube has
  const overview = await submitted('overview', 'lib:overview', { kind: 'tutorial', lib: true });
  await insertLibraryRender(
    t.app.ctx,
    overview,
    { slug: 'overview', title: 'Overview', duration: 80, vtt: true, chapters: [] },
    1,
  );
  const overviewRender = (await q('SELECT id FROM video_renders WHERE post_id=$1', [overview]))[0]?.id;
  await oldApprove(overview, overviewRender);
  await share(
    overview,
    'sent',
    {
      videoId: 'ovrv1234567',
      uploadedAt: '2026-10-28T12:00:00.000Z',
      publishAt: '2026-10-29T08:00:00.000Z',
      privacy: 'public',
      reservedAt: '2026-10-28T12:00:00.000Z',
    },
    'ovrv1234567',
  );
  // library imports waiting in review
  for (const slug of ['agents', 'board', 'cards']) {
    const id = await submitted(`lib-${slug}`, `lib:${slug}`, { kind: 'tutorial', lib: true });
    await insertLibraryRender(t.app.ctx, id, { slug, title: slug, duration: 60, vtt: true, chapters: [] }, 1);
  }
  // six rejected release videos with failed renders
  for (let i = 0; i < 6; i++) {
    const id = await submitted(`rel-${i}`, `1.0.${i}`, { kind: 'release', origin: true });
    await render(id, 'failed', { error: 'ffmpeg exploded' });
    await t.app.ctx.store.append([
      {
        streamId: videoPostStream(id),
        event: { type: 'VideoPostRejected', payload: { postId: id, reason: 'no', by: admin.id } },
        actor: userActor(admin.id),
        scope: adminScope,
      },
    ]);
  }
  // approved, rendered, waiting to upload with a slot it had reserved
  const waiting = await submitted('waiting', 'waiting-article');
  await oldApprove(waiting, await render(waiting, 'rendered'));
  await share(waiting, 'pending', {
    reservedAt: '2026-10-28T13:00:00.000Z',
    publishAt: '2026-10-30T08:00:00.000Z',
    privacy: 'public',
  });
  // two in review: a finished render, a render that was only queued
  const done = await submitted('rendered-review', 'review-rendered', { origin: true });
  await render(done, 'rendered');
  const queued = await submitted('queued-review', 'review-queued', { origin: true });
  await render(queued, 'queued');
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

describe('video-schedule-2026-10', () => {
  it('gives each approved post its slot, makes finished reviews previews and defers unfinished renders', async () => {
    await q('DELETE FROM data_migrations WHERE name = $1', [VIDEO_SCHEDULE_MIGRATION]);
    const report = await migrateVideoSchedule(env());
    expect(report?.scheduled.map((s) => s.step).sort()).toEqual(['uploaded', 'waiting']);
    const post = async (key: string) => (await q('SELECT * FROM video_posts WHERE id=$1', [ids[key]]))[0];

    // lib:overview keeps the slot it has on YouTube
    const overview = await post('overview');
    expect(overview).toMatchObject({ status: 'approved', publish_mode: 'slot', destinations: ['youtube'] });
    expect(new Date(overview?.slot_at).toISOString()).toBe('2026-10-29T08:00:00.000Z');
    // the waiting post takes the next free long slot, and drops the slot reserved in its share
    const waiting = await post('waiting');
    expect(waiting?.slot_at).not.toBeNull();
    expect(new Date(waiting?.slot_at).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(waiting?.slot_at).getUTCHours()).toBe(8); // 10:00 SAST
    const detail = (await q(`SELECT detail FROM social_shares WHERE post_id=$1`, [ids.waiting]))[0]?.detail;
    expect(detail.publishAt).toBeUndefined();
    expect(detail.reservedAt).toBeUndefined();
    expect(detail.privacy).toBe('public');
    // its existing render is kept (rendered)
    expect((await q('SELECT status FROM video_renders WHERE post_id=$1', [ids.waiting]))[0]?.status).toBe(
      'rendered',
    );

    // in review: a finished render is a preview, a queued one is deferred and does not count as a used render
    expect(
      (await q('SELECT preview FROM video_renders WHERE post_id=$1', [ids['rendered-review']]))[0]?.preview,
    ).toBe(true);
    const deferred = (
      await q('SELECT status, error FROM video_renders WHERE post_id=$1', [ids['queued-review']])
    )[0];
    expect(deferred).toMatchObject({ status: 'failed', error: RENDER_DEFERRED });
    const dto = await t.req('GET', `/api/platform/video/posts/${ids['queued-review']}`, {
      cookie: (await t.superAdminSession()).cookie,
    });
    expect(dto.body.rendersUsed).toBe(0);

    // library imports in review and the rejected releases are untouched
    for (const slug of ['agents', 'board', 'cards']) {
      expect(await post(`lib-${slug}`)).toMatchObject({ status: 'in_review', slot_at: null });
      expect(
        (
          await q('SELECT status, library, preview FROM video_renders WHERE post_id=$1', [ids[`lib-${slug}`]])
        )[0],
      ).toMatchObject({
        status: 'rendered',
        library: true,
        preview: false,
      });
    }
    for (let i = 0; i < 6; i++) {
      expect(await post(`rel-${i}`)).toMatchObject({ status: 'rejected', slot_at: null });
      expect(
        (await q('SELECT status FROM video_renders WHERE post_id=$1', [ids[`rel-${i}`]]))[0]?.status,
      ).toBe('failed');
    }
  });

  it('is idempotent: recorded once, a second run does nothing', async () => {
    expect(await migrateVideoSchedule(env())).toBeNull();
    expect((await q('SELECT 1 FROM data_migrations WHERE name=$1', [VIDEO_SCHEDULE_MIGRATION])).length).toBe(
      1,
    );
    await q('DELETE FROM data_migrations WHERE name = $1', [VIDEO_SCHEDULE_MIGRATION]);
    const again = await migrateVideoSchedule(env());
    expect(again?.scheduled).toEqual([]); // every approved post already has its slot
  });

  it('a projection rebuild reproduces the migrated slots', async () => {
    const cols = 'id, status, slot_at, publish_mode, destinations, approved_render_id';
    const before = await q(`SELECT ${cols} FROM video_posts ORDER BY id`);
    await rebuildProjections(t.app.ctx.pool, t.app.ctx.store);
    expect(await q(`SELECT ${cols} FROM video_posts ORDER BY id`)).toEqual(before);
    expect(before.filter((r) => r.slot_at)).toHaveLength(2);
  });
});
