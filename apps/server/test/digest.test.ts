import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createFeedProject, feedRunner, feedSchedule, item } from './helpers/feeds.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
let feedId: string;
let run: ReturnType<typeof feedRunner>;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
  feedId = await createFeedProject(w);
  await w.hire('Scout', 'scout', 'junior');
  await w.hire('Cora', 'curator', 'junior');
  run = feedRunner(w, r);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const runNow = async (scheduleBody: Record<string, unknown> = {}) => {
  const s = await ok<any>(feedSchedule(w, feedId, { name: `s${Date.now()}`, ...scheduleBody }), 201);
  return ok<{ cardId: string; ref: string }>(owner('POST', `/api/schedules/${s.id}/run`), 201);
};
const feedList = async () => (await ok<any>(owner('GET', `/api/projects/${feedId}/feed`))).items as any[];
const threadOf = async (cardId: string) =>
  q('SELECT kind, body FROM thread_messages WHERE thread_id=$1 ORDER BY created_at, event_seq', [cardId]);

describe('feed pipeline: scout -> curator -> digest', () => {
  it('hands the scout candidates to the curator and logs at most the maximum per kind, oldest to newest', async () => {
    const card = await runNow({
      cardTemplate: {
        title: 'Max run',
        fields: { topic: 'reloading', maxPerKind: { article: 2, video: 1 } },
      },
    });
    const candidates = [
      item(1),
      item(2),
      item(3),
      item(4, { kind: 'video', url: 'https://video.example.test/v4' }),
      item(5, { kind: 'video', url: 'https://video.example.test/v5' }),
    ];
    const { scout, curator } = await run.scan(candidates);
    expect(scout.brief.feed).toMatchObject({ candidates: [], seenUrls: [] });
    expect(scout.brief.shift.outcomes[0]?.data).toBe('candidates');
    // The curator sees the scout's candidates and the card limits.
    expect(curator.brief.shift.stage).toBe('curate');
    expect(curator.brief.feed?.candidates.map((c) => c.url)).toEqual(candidates.map((c) => c.url));
    expect(curator.brief.card.fields.maxPerKind).toEqual({ article: 2, video: 1 });

    const res = await run.digest(curator.shiftId, { items: candidates });
    expect(res).toMatchObject({ accepted: true });
    expect(res.message).toMatch(/Digest posted: 3 new item/);

    const posted = (await q(`SELECT payload FROM events WHERE type='DigestPosted' ORDER BY seq`))[0]?.payload;
    expect(posted).toMatchObject({ nothingQualified: false, duplicatesDropped: 0, overMaximumDropped: 2 });
    expect(posted.items.map((i: any) => i.url)).toEqual([
      candidates[0]?.url,
      candidates[1]?.url,
      candidates[3]?.url,
    ]);
    expect(posted.items[0]).toMatchObject({
      urlNormalized: 'news.example.test/story-1',
      publishedAt: '2026-10-02T00:00:00.000Z',
    });

    expect((await q('SELECT status, stage FROM cards WHERE id=$1', [card.cardId]))[0]).toMatchObject({
      status: 'done',
      stage: 'done',
    });
    const list = await feedList();
    expect(list.map((i) => i.url)).toEqual([candidates[0]?.url, candidates[1]?.url, candidates[3]?.url]);
    expect((await q('SELECT count(*)::int AS n FROM feed_seen'))[0]?.n).toBe(3);

    // One grouped rating item on the desk with the digest's items.
    const desk = await ok<any>(owner('GET', '/api/desk'));
    const rating = desk.items.filter((i: any) => i.kind === 'rating');
    expect(rating).toHaveLength(1);
    expect(rating[0]).toMatchObject({ subkind: 'digest', status: 'open', canAnswer: true });
    expect(rating[0].digestItems).toHaveLength(3);
    expect((await threadOf(card.cardId)).map((m) => m.body).join('\n')).toMatch(/Digest posted: 3 new item/);
  });

  it('appends only new, non-duplicate items: seen URLs and the same story from another source are skipped', async () => {
    await runNow();
    const before = await feedList();
    const candidates = [
      item(1), // seen URL
      item(1, {
        url: 'https://www.news.example.test/story-1/?utm_source=feedly#top',
        title: 'A different headline entirely',
      }), // same URL, tracking params
      item(2, {
        url: 'https://other.example.test/hornady-6mm-arc',
        title: 'Berger releases new hunting bullet line!',
      }), // same story as item 2, other source
      item(6),
      item(6, { url: 'https://third.example.test/lapua', source: 'Third' }), // duplicate inside the digest
    ];
    const { curator } = await run.scan(candidates);
    expect(curator.brief.feed?.seenUrls).toEqual(
      expect.arrayContaining([
        'news.example.test/story-1',
        'news.example.test/story-2',
        'video.example.test/v4',
      ]),
    );
    const res = await run.digest(curator.shiftId, { items: candidates });
    expect(res.accepted).toBe(true);
    const posted = (
      await q(`SELECT payload FROM events WHERE type='DigestPosted' ORDER BY seq DESC LIMIT 1`)
    )[0]?.payload;
    expect(posted.items).toHaveLength(1);
    expect(posted.items[0].url).toBe(candidates[3]?.url);
    expect(posted.duplicatesDropped).toBe(4);
    // Earlier entries are untouched and the new one is last.
    const after = await feedList();
    expect(after.slice(0, before.length).map((i) => i.id)).toEqual(before.map((i) => i.id));
    expect(after.at(-1)?.url).toBe(candidates[3]?.url);
    expect(after).toHaveLength(before.length + 1);
  });

  it('nothing qualified logs nothing and says so on the card', async () => {
    const itemsBefore = (await feedList()).length;
    const ratingBefore = (await q(`SELECT count(*)::int AS n FROM desk_items WHERE kind='rating'`))[0]?.n;
    const card = await runNow();
    const { curator } = await run.scan([]);
    const res = await run.digest(curator.shiftId, { items: [] }, 'nothing new today');
    expect(res.message).toMatch(/Nothing qualified in this run; nothing was logged/);
    expect(await feedList()).toHaveLength(itemsBefore);
    expect((await q(`SELECT count(*)::int AS n FROM desk_items WHERE kind='rating'`))[0]?.n).toBe(
      ratingBefore,
    );
    const posted = (
      await q(`SELECT payload FROM events WHERE type='DigestPosted' ORDER BY seq DESC LIMIT 1`)
    )[0]?.payload;
    expect(posted).toMatchObject({ nothingQualified: true, items: [] });
    expect((await q('SELECT status FROM cards WHERE id=$1', [card.cardId]))[0]?.status).toBe('done');
    const thread = (await threadOf(card.cardId)).map((m) => m.body).join('\n');
    expect(thread).toMatch(/Nothing qualified in this run; nothing was logged/);
    expect(thread).toMatch(/nothing new today/);
  });

  it('rejects a digest with an item the scout never offered, or one missing its summary', async () => {
    await runNow();
    const { curator } = await run.scan([item(7)]);
    const stray = await run.h.report(r, curator.shiftId, {
      kind: 'outcome',
      outcomeId: 'digest',
      note: 'n',
      data: { items: [item(7), item(8)] },
    });
    expect(stray).toMatchObject({ accepted: false });
    expect(stray.error).toMatch(/must come from the scout's candidates.*story-8/);
    const bad = await run.h.report(r, curator.shiftId, {
      kind: 'outcome',
      outcomeId: 'digest',
      note: 'n',
      data: { items: [{ ...item(7), summary: '' }] },
    });
    expect(bad).toMatchObject({ accepted: false });
    expect(bad.error).toMatch(/invalid data/);
    // The shift can still report correctly afterwards.
    expect((await run.digest(curator.shiftId, { items: [item(7)] })).accepted).toBe(true);
  });

  it('rebuilds the feed projections identically from the event log', async () => {
    const snapshot = async () => ({
      items: await q(
        'SELECT id, card_id, url, url_normalized, position, verdict, desk_item_id FROM digest_items ORDER BY event_seq, position',
      ),
      seen: await q('SELECT project_id, url_normalized FROM feed_seen ORDER BY url_normalized'),
      schedules: await q(
        'SELECT id, cron, timezone, enabled, next_fire_at, last_card_id FROM schedules ORDER BY id',
      ),
      cards: await q(`SELECT id, status, stage FROM cards WHERE project_id=$1 ORDER BY number`, [feedId]),
    });
    const before = await snapshot();
    expect(before.items.length).toBeGreaterThan(0);
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect(await snapshot()).toEqual(before);
  });
});
