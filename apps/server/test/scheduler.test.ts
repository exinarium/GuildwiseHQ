import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createFeedProject, feedSchedule } from './helpers/feeds.ts';
import { shiftHelpers } from './helpers/shifts.ts';
import { createWorld, markOnline, ok, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
let feedId: string;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
  feedId = await createFeedProject(w);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const ctx = () => w.t.app.ctx;
const owner = (method: string, url: string, body?: unknown) => w.t.req(method, url, { cookie: w.owner.cookie, body });
const setNow = (at: Date) => ctx().clock.setOffset(at.getTime() - Date.now());
const scheduler = () => ctx().services.scheduler;
const cards = () => q('SELECT * FROM cards WHERE project_id=$1 ORDER BY number', [feedId]);

describe('schedules', () => {
  it('validates the cron expression and the time zone', async () => {
    const bad = await feedSchedule(w, feedId, { cron: 'every day' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_cron');
    expect((await feedSchedule(w, feedId, { cron: '0 7 * * * *' })).status).toBe(400);
    const tz = await feedSchedule(w, feedId, { timezone: 'Mars/Olympus' });
    expect(tz.status).toBe(400);
    expect(tz.body.error.code).toBe('invalid_timezone');
    // a feed schedule needs a feed project; the template must fit the feed field set
    expect((await feedSchedule(w, w.projectId)).status).toBe(400);
    expect((await feedSchedule(w, feedId, { cardTemplate: { title: 'x', fields: { windowHours: 'many' } } })).status).toBe(400);
  });

  it('computes the next fire in the schedule time zone and only the owner manages schedules', async () => {
    const jhb = await ok<any>(feedSchedule(w, feedId, { timezone: 'Africa/Johannesburg', name: 'Joburg 07:00' }), 201);
    expect(new Date(jhb.nextFireAt).getUTCHours()).toBe(5);
    expect(new Date(jhb.nextFireAt).getUTCMinutes()).toBe(0);
    expect(new Date(jhb.nextFireAt).getTime()).toBeGreaterThan(Date.now());
    const utc = await ok<any>(feedSchedule(w, feedId, { name: 'UTC 07:00' }), 201);
    expect(new Date(utc.nextFireAt).getUTCHours()).toBe(7);

    const stranger = await w.t.userSession(uniqueEmail('stranger'));
    const forbidden = await w.t.req('PATCH', `/api/schedules/${jhb.id}`, { cookie: stranger.cookie, body: { enabled: false } });
    expect(forbidden.status).toBe(404);
    const list = await ok<any>(owner('GET', `/api/schedules?projectId=${feedId}`));
    expect(list.schedules.map((s: any) => s.name)).toEqual(expect.arrayContaining(['Joburg 07:00', 'UTC 07:00']));
    expect((await w.t.req('GET', '/api/schedules', { cookie: stranger.cookie })).body.schedules).toEqual([]);

    const patched = await ok<any>(owner('PATCH', `/api/schedules/${utc.id}`, { cron: '30 18 * * 1-5' }));
    expect(new Date(patched.nextFireAt).getUTCHours()).toBe(18);
    expect((await ok<any>(owner('PATCH', `/api/schedules/${utc.id}`, { enabled: false }))).nextFireAt).toBeNull();
    await ok(owner('DELETE', `/api/schedules/${jhb.id}`));
    await ok(owner('DELETE', `/api/schedules/${utc.id}`));
    expect((await ok<any>(owner('GET', `/api/schedules?projectId=${feedId}`))).schedules).toEqual([]);
  });
});

describe('the scheduler fires on time (clock-controlled)', () => {
  it('does not fire early, fires when due with a scheduled feed card, and schedules the next day', async () => {
    const s = await ok<any>(feedSchedule(w, feedId, { name: 'Morning' }), 201);
    const due = new Date(s.nextFireAt);
    setNow(new Date(due.getTime() - 60_000));
    expect(await scheduler().run()).toEqual([]);
    expect(await cards()).toHaveLength(0);

    setNow(new Date(due.getTime() + 2_000));
    const fired = await scheduler().run();
    expect(fired).toHaveLength(1);
    const [card] = await cards();
    expect(card).toMatchObject({
      scheduled: true,
      origin: 'schedule',
      schedule_id: s.id,
      card_type: 'feed',
      stage: 'scan',
      status: 'queued',
    });
    expect(card?.title).toMatch(/^News run \(\d{4}-\d{2}-\d{2}\)$/);
    expect(card?.fields).toMatchObject({ topic: 'reloading', windowHours: 24, maxPerKind: { article: 5, video: 3 } });

    const after = await ok<any>(owner('GET', `/api/schedules?projectId=${feedId}`));
    const next = new Date(after.schedules[0].nextFireAt);
    expect(next.getTime() - due.getTime()).toBe(24 * 3600_000);
    expect(after.schedules[0].lastCardId).toBe(card?.id);
    const events = await q(`SELECT type FROM events WHERE payload->>'cardId'=$1 ORDER BY seq`, [card?.id]);
    expect(events.map((e) => e.type)).toEqual(['CardCreated', 'ScheduleFired']);

    // the same minute does not fire twice
    expect(await scheduler().run()).toEqual([]);
    expect(await cards()).toHaveLength(1);
  });

  it('fires once after downtime instead of once per missed day, and not at all when disabled', async () => {
    await q('DELETE FROM schedules');
    await q('TRUNCATE cards, card_dependencies, card_handoffs, card_transitions CASCADE');
    const s = await ok<any>(feedSchedule(w, feedId, { name: 'Catch-up' }), 201);
    const off = await ok<any>(feedSchedule(w, feedId, { name: 'Off', enabled: false }), 201);
    expect(off.nextFireAt).toBeNull();
    setNow(new Date(new Date(s.nextFireAt).getTime() + 5 * 24 * 3600_000 + 1000));
    expect(await scheduler().run()).toHaveLength(1);
    expect(await cards()).toHaveLength(1);
    const next = (await ok<any>(owner('GET', `/api/schedules?projectId=${feedId}`))).schedules.find((x: any) => x.name === 'Catch-up');
    expect(new Date(next.nextFireAt).getTime()).toBeGreaterThan(ctx().clock.now().getTime());
  });

  it('claims the scheduled card ahead of normal work', async () => {
    await q('DELETE FROM schedules');
    await q('TRUNCATE cards, card_dependencies, card_handoffs, card_transitions, shifts, agents CASCADE');
    setNow(new Date());
    await w.hire('Scout', 'scout', 'junior');
    // normal work first (queued earlier) ...
    const normal = await ok<any>(
      owner('POST', '/api/cards', {
        projectId: feedId,
        title: 'Manual feed card',
        cardType: 'feed',
        fields: { topic: 'optics' },
        specify: true,
      }),
      201,
    );
    expect(normal.card.status).toBe('queued');
    // ... then the schedule fires
    const s = await ok<any>(feedSchedule(w, feedId, { name: 'Priority' }), 201);
    setNow(new Date(new Date(s.nextFireAt).getTime() + 1000));
    await scheduler().run();
    await markOnline(w.t, w.workstationId);
    const h = shiftHelpers(w);
    const start = await h.dispatchTo(r, 'Scout');
    expect(start.brief.card.title).toMatch(/^News run/);
    const card = (await q('SELECT scheduled FROM cards WHERE id=$1', [start.brief.card.id]))[0];
    expect(card?.scheduled).toBe(true);
    // the manual card is still waiting
    expect((await q('SELECT status FROM cards WHERE id=$1', [normal.card.id]))[0]?.status).toBe('queued');
  });
});

describe('run now', () => {
  it('emits a scheduled card at once from a schedule or from the feed project, without moving the schedule', async () => {
    await q('DELETE FROM schedules');
    await q('TRUNCATE cards, card_dependencies, card_handoffs, card_transitions, shifts CASCADE');
    setNow(new Date());
    // no schedule: a default template (topic = project name)
    const first = await ok<any>(owner('POST', `/api/projects/${feedId}/feed/run`, {}), 201);
    expect(first.ref).toMatch(/^NEWS-\d+$/);
    const c1 = (await q('SELECT * FROM cards WHERE id=$1', [first.cardId]))[0];
    expect(c1).toMatchObject({ scheduled: true, origin: 'schedule', stage: 'scan', status: 'queued' });
    expect(c1?.fields).toMatchObject({ topic: 'News' });

    const s = await ok<any>(feedSchedule(w, feedId, { name: 'Daily' }), 201);
    const second = await ok<any>(owner('POST', `/api/schedules/${s.id}/run`), 201);
    const c2 = (await q('SELECT * FROM cards WHERE id=$1', [second.cardId]))[0];
    expect(c2?.fields).toMatchObject({ topic: 'reloading' });
    expect(c2?.schedule_id).toBe(s.id);
    const after = (await ok<any>(owner('GET', `/api/schedules?projectId=${feedId}`))).schedules[0];
    expect(after.nextFireAt).toBe(s.nextFireAt);
    expect(after.lastCardId).toBe(second.cardId);
    expect((await q(`SELECT count(*)::int AS n FROM events WHERE type='FeedRunRequested'`))[0]?.n).toBe(2);

    // a code project has no feed to run
    expect((await owner('POST', `/api/projects/${w.projectId}/feed/run`, {})).status).toBe(400);
  });
});
