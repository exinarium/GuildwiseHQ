import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createFeedInterest, runNow } from './helpers/feeds.ts';
import { shiftHelpers } from './helpers/shifts.ts';
import { createWorld, markOnline, ok, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const ctx = () => w.t.app.ctx;
const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const setNow = (at: Date) => ctx().clock.setOffset(at.getTime() - Date.now());
const scheduler = () => ctx().services.scheduler;
const cardsOf = (projectId: string) =>
  q('SELECT * FROM cards WHERE project_id=$1 ORDER BY number', [projectId]);
// biome-ignore lint/suspicious/noExplicitAny: a row read for assertions
const interest = async (id: string): Promise<any> =>
  (await q('SELECT * FROM interests WHERE id=$1', [id]))[0];

describe('schedules', () => {
  it('validates the cron expression and the time zone, and refuses feeds (they are interests)', async () => {
    const make = (over: Record<string, unknown> = {}) =>
      owner('POST', '/api/schedules', {
        projectId: w.projectId,
        name: 'Check',
        kind: 'card',
        cron: '0 7 * * *',
        timezone: 'UTC',
        cardTemplate: { title: 't', fields: {} },
        ...over,
      });
    const bad = await make({ cron: 'every day' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_cron');
    expect((await make({ cron: '0 7 * * * *' })).status).toBe(400);
    const tz = await make({ timezone: 'Mars/Olympus' });
    expect(tz.status).toBe(400);
    expect(tz.body.error.code).toBe('invalid_timezone');
    const feed = await make({ kind: 'feed' });
    expect(feed.status).toBe(400);
    expect(feed.body.error.code).toBe('use_interests');
  });
});

describe('the scheduler runs interests on time (clock-controlled)', () => {
  it('computes the next scan in the interest time zone, does not fire early, fires when due and schedules the next day', async () => {
    const a = await createFeedInterest(w, {
      name: 'Morning',
      scan: { cron: '0 7 * * *', timezone: 'Africa/Johannesburg' },
    });
    const i0 = await interest(a.id);
    const due = new Date(i0.next_scan_at);
    expect(due.getUTCHours()).toBe(5);
    setNow(new Date(due.getTime() - 60_000));
    await scheduler().run();
    expect(await cardsOf(a.projectId)).toHaveLength(0);

    setNow(new Date(due.getTime() + 2_000));
    await scheduler().run();
    const [card] = await cardsOf(a.projectId);
    expect(card).toMatchObject({
      scheduled: true,
      origin: 'interest',
      interest_id: a.id,
      card_type: 'feed',
      stage: 'scan',
      status: 'queued',
    });
    expect(card?.title).toMatch(/^Morning \d{4}-\d{2}-\d{2}$/);
    expect(card?.fields).toMatchObject({ topic: 'Morning', windowHours: 24, maxItems: 10 });
    expect(card?.interest_run_id).toBeTruthy();

    const after = await interest(a.id);
    expect(new Date(after.next_scan_at).getTime() - due.getTime()).toBe(24 * 3600_000);
    const run = (await q('SELECT * FROM interest_runs WHERE interest_id=$1', [a.id]))[0];
    expect(run).toMatchObject({ kind: 'scan', trigger: 'cron', status: 'queued', card_id: card?.id });
    const events = await q(`SELECT type FROM events WHERE payload->>'cardId'=$1 ORDER BY seq`, [card?.id]);
    expect(events.map((e) => e.type)).toEqual(['InterestRunStarted', 'CardCreated']);

    // the same minute does not fire twice, and the next scan was already scheduled (the second pass is a no-op)
    await scheduler().run();
    expect(await cardsOf(a.projectId)).toHaveLength(1);
  });

  it('a run is skipped (recorded, no failure) while the previous one is still running', async () => {
    const a = await createFeedInterest(w, { name: 'Overlap', scan: { cron: '0 * * * *' } });
    setNow(new Date(new Date((await interest(a.id)).next_scan_at).getTime() + 1000));
    await scheduler().run();
    expect(await cardsOf(a.projectId)).toHaveLength(1);
    setNow(new Date(ctx().clock.now().getTime() + 3600_000));
    await scheduler().run();
    expect(await cardsOf(a.projectId)).toHaveLength(1);
    const skipped = await q(
      `SELECT payload FROM events WHERE type='InterestRunFailed' AND payload->>'interestId'=$1`,
      [a.id],
    );
    expect(skipped[0]?.payload).toMatchObject({ error: 'previous_run_active', counted: false });
    expect((await interest(a.id)).fail_count).toBe(0);
  });

  it('fires once after downtime instead of once per missed day, and not at all when paused or by hand', async () => {
    const a = await createFeedInterest(w, { name: 'Catch-up', scan: { cron: '0 7 * * *' } });
    const off = await createFeedInterest(w, { name: 'Off', status: 'paused', scan: { cron: '0 7 * * *' } });
    const manual = await createFeedInterest(w, { name: 'By hand' });
    expect((await interest(off.id)).next_scan_at).toBeNull();
    expect((await interest(manual.id)).next_scan_at).toBeNull();
    setNow(new Date(new Date((await interest(a.id)).next_scan_at).getTime() + 5 * 24 * 3600_000 + 1000));
    await scheduler().run();
    expect(await cardsOf(a.projectId)).toHaveLength(1);
    expect(new Date((await interest(a.id)).next_scan_at).getTime()).toBeGreaterThan(
      ctx().clock.now().getTime(),
    );
    expect(await cardsOf(off.projectId)).toHaveLength(0);
    expect(await cardsOf(manual.projectId)).toHaveLength(0);
  });

  it('claims the scheduled card ahead of normal work', async () => {
    await q('TRUNCATE cards, card_dependencies, card_handoffs, card_transitions, shifts, agents CASCADE');
    setNow(new Date());
    await w.hire('Scout', 'scout', 'junior');
    // ordinary work first (queued earlier) ...
    const side = await createFeedInterest(w, { name: 'Side' });
    const normal = await runNow(w, side.id);
    await q('UPDATE cards SET scheduled=false WHERE id=$1', [normal.cardId]);
    // ... then an interest comes due
    const a = await createFeedInterest(w, { name: 'Priority', scan: { cron: '0 7 * * *' } });
    setNow(new Date(new Date((await interest(a.id)).next_scan_at).getTime() + 1000));
    await scheduler().run();
    await markOnline(w.t, w.workstationId);
    const h = shiftHelpers(w);
    const start = await h.dispatchTo(r, 'Scout');
    expect(start.brief.card.title).toMatch(/^Priority/);
    expect((await q('SELECT scheduled FROM cards WHERE id=$1', [start.brief.card.id]))[0]?.scheduled).toBe(
      true,
    );
    expect((await q('SELECT status FROM cards WHERE id=$1', [normal.cardId]))[0]?.status).toBe('queued');
  });
});

describe('run now', () => {
  it('emits a scheduled card at once without moving the next scan, and refuses a second scan while one runs', async () => {
    setNow(new Date());
    const a = await createFeedInterest(w, { name: 'Now', scan: { cron: '0 7 * * *' } });
    const next = (await interest(a.id)).next_scan_at;
    const first = await runNow(w, a.id);
    expect(first.ref).toMatch(/^[A-Z0-9]+-1$/);
    const c1 = (await q('SELECT * FROM cards WHERE id=$1', [first.cardId]))[0];
    expect(c1).toMatchObject({ scheduled: true, origin: 'interest', stage: 'scan', status: 'queued' });
    expect((await interest(a.id)).next_scan_at).toEqual(next);
    expect(
      (await q('SELECT trigger, started_by FROM interest_runs WHERE id=$1', [first.runId]))[0],
    ).toMatchObject({ trigger: 'manual', started_by: w.owner.id });
    const again = await owner('POST', `/api/interests/${a.id}/run`, {});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('run_in_progress');
    expect(again.body.error.details.ref).toBe(first.ref);
    // research may run next to a scan
    expect((await owner('POST', `/api/interests/${a.id}/run`, { kind: 'research' })).status).toBe(201);
    // a code project has no feed to run
    expect((await owner('POST', `/api/projects/${w.projectId}/feed/run`, {})).status).toBe(404);
  });
});
