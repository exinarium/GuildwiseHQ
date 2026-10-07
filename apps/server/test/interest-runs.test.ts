import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createFeedInterest, feedItems, feedRunner, item, runNow } from './helpers/feeds.ts';
import { createWorld, markOnline, ok, until, type World } from './helpers/world.ts';

/**
 * The run log, the delivery schedule and the quiet cap, the soft agent preference, and the failure back-off
 * (docs/design/restructure.md sections 3.4, 5.2, 5.3 and the owner decisions on delivery).
 */
let w: World;
let r: FakeRunner;
let run: ReturnType<typeof feedRunner>;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
  await w.hire('Scout', 'scout', 'junior');
  await w.hire('Cora', 'curator', 'junior');
  run = feedRunner(w, r);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const ctx = () => w.t.app.ctx;
const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
// The clock only moves a day or two ahead (sessions and the runner's presence are real-time facts); the workstation is
// marked online again after every move so the dispatcher still sees it.
const setNow = (at: Date) => {
  ctx().clock.setOffset(at.getTime() - Date.now());
};
const online = () => markOnline(w.t, w.workstationId);
/** The next `hh:00` UTC after the real now. */
const nextUtcHour = (hh: number): Date => {
  const d = new Date();
  d.setUTCHours(hh, 0, 0, 0);
  if (d.getTime() <= Date.now() + 120_000) d.setUTCDate(d.getUTCDate() + 1);
  return d;
};
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);
const MIN = 60_000;
const DAY = 24 * 3600_000;
const ratingItems = async () =>
  (await ok<any>(owner('GET', '/api/desk'))).items.filter(
    (i: any) => i.kind === 'rating' && i.status === 'open',
  );
// biome-ignore lint/suspicious/noExplicitAny: a row read for assertions
const interest = async (id: string): Promise<any> =>
  (await q('SELECT * FROM interests WHERE id=$1', [id]))[0];

/** Runs one scan with the given candidates through scout and curator. */
async function scanAndDigest(id: string, items: unknown[], patch: Record<string, unknown> = {}) {
  await online();
  const card = await runNow(w, id, patch);
  const { curator } = await run.scan(items);
  const res = await run.digest(curator.shiftId, { items });
  expect(res.accepted).toBe(true);
  return card;
}

describe('the run log', () => {
  it('records found, published, dropped and the status of every run, with ratings joined at read time', async () => {
    const a = await createFeedInterest(w, { name: 'Log' });
    const card = await scanAndDigest(a.id, [item(1), item(1, { title: 'dup of one' }), item(2), item(3)], {
      scan: { maxItems: 2 },
    });
    const runs = await ok<any>(owner('GET', `/api/interests/${a.id}/runs`));
    expect(runs.hasMore).toBe(false);
    expect(runs.runs[0]).toMatchObject({
      id: card.runId,
      kind: 'scan',
      trigger: 'manual',
      status: 'published',
      found: 4,
      published: 2,
      duplicatesDropped: 1,
      overMaxDropped: 1,
      card: { id: card.cardId, ref: card.ref },
      ratings: { useful: 0, irrelevant: 0, boring: 0, unrated: 2 },
      startedBy: { id: w.owner.id },
    });
    expect(runs.runs[0].finishedAt).toBeTruthy();
    const detail = await ok<any>(owner('GET', `/api/interests/${a.id}/runs/${card.runId}`));
    expect(detail.items.map((i: any) => i.url)).toEqual([item(1).url, item(2).url]);
    expect(detail.items[0]).toMatchObject({ delivered: true, verdict: null });
    expect(detail.shifts.map((s: any) => [s.role, s.agentName, s.status])).toEqual([
      ['scout', 'Scout', 'ended'],
      ['curator', 'Cora', 'ended'],
    ]);
    await ok(owner('POST', `/api/digest-items/${detail.items[0].id}/rate`, { verdict: 'useful' }));
    expect((await ok<any>(owner('GET', `/api/interests/${a.id}/runs`))).runs[0].ratings).toMatchObject({
      useful: 1,
      unrated: 1,
    });
    // another user cannot read the log
    const stranger = await w.t.userSession(`s${Date.now()}@example.test`);
    expect((await w.t.req('GET', `/api/interests/${a.id}/runs`, { cookie: stranger.cookie })).status).toBe(
      404,
    );
  });

  it('a run that found nothing says so, and a cancelled one is cancelled', async () => {
    const a = await createFeedInterest(w, { name: 'Quiet' });
    const card = await runNow(w, a.id);
    const { curator } = await run.scan([]);
    await run.digest(curator.shiftId, { items: [] });
    expect(
      (await q('SELECT status, found, published FROM interest_runs WHERE id=$1', [card.runId]))[0],
    ).toMatchObject({
      status: 'nothing',
      found: 0,
      published: 0,
    });
    const second = await runNow(w, a.id);
    await ok(owner('POST', `/api/cards/${second.ref}/cancel`, { reason: 'not now' }));
    expect((await q('SELECT status FROM interest_runs WHERE id=$1', [second.runId]))[0]?.status).toBe(
      'cancelled',
    );
  });

  it('InterestRunDone is the event the interest_run_done schedule trigger listens to', async () => {
    const a = await createFeedInterest(w, { name: 'Trigger' });
    const sch = await ok<any>(
      owner('POST', '/api/schedules', {
        name: 'After a run',
        trigger: { kind: 'event', event: 'interest_run_done', interestId: a.id },
        action: {
          kind: 'ba_task',
          projectId: null,
          prompt: 'Tell me what the run found',
          deliver: 'desk_notice',
        },
      }),
      201,
    );
    await ctx().services.scheduler.run(); // the sweep starts at the end of the log
    await scanAndDigest(a.id, [item(1)]);
    await ctx().services.scheduler.run();
    const done = (
      await q(`SELECT payload FROM events WHERE type='InterestRunDone' AND payload->>'interestId'=$1`, [a.id])
    )[0];
    expect(done?.payload).toMatchObject({ kind: 'scan', status: 'published', published: 1 });
    await until(
      async () => (await q('SELECT 1 FROM schedule_runs WHERE schedule_id=$1', [sch.id])).length === 1,
      5000,
      'one run of the schedule',
    );
    expect(
      (await q('SELECT trigger, source_key FROM schedule_runs WHERE schedule_id=$1', [sch.id]))[0],
    ).toMatchObject({
      trigger: 'event',
    });
  });
});

describe('the delivery schedule and the quiet cap', () => {
  it("holds a scheduled interest's items until the delivery time, then puts one digest on the desk", async () => {
    const seven = nextUtcHour(7);
    setNow(plus(seven, -60 * MIN));
    const a = await createFeedInterest(w, {
      name: 'Morning digest',
      delivery: { mode: 'scheduled', cron: '0 7 * * *', timezone: 'UTC' },
    });
    const ratingBefore = (await ratingItems()).length;
    const c1 = await scanAndDigest(a.id, [item(1), item(2)]);
    const c2 = await scanAndDigest(a.id, [item(3)]);
    // nothing reached the desk or the digest tab; the items wait
    expect(await ratingItems()).toHaveLength(ratingBefore);
    expect(await feedItems(w, a.id)).toHaveLength(0);
    const held = await ok<any>(owner('GET', `/api/interests/${a.id}`));
    expect(held.interest.stats.items).toMatchObject({ total: 3, held: 3 });
    expect(held.interest.stats.ratings.unrated).toBe(0);
    const run1 = await ok<any>(owner('GET', `/api/interests/${a.id}/runs/${c1.runId}`));
    expect(run1.items.every((i: any) => i.delivered === false)).toBe(true);
    // before the time: still nothing
    setNow(plus(seven, -MIN));
    await ctx().services.scheduler.run();
    expect(await ratingItems()).toHaveLength(ratingBefore);
    // at 07:00 one digest of everything held
    setNow(plus(seven, 30_000));
    await ctx().services.scheduler.run();
    const rating = (await ratingItems()).filter((i: any) => i.digestItems?.length);
    expect(rating).toHaveLength(ratingBefore + 1);
    const mine = rating.find((i: any) => i.title.includes('Morning digest'));
    expect(mine.digestItems.map((i: any) => i.url)).toEqual([item(1).url, item(2).url, item(3).url]);
    expect(await feedItems(w, a.id)).toHaveLength(3);
    const after = await interest(a.id);
    expect(new Date(after.next_delivery_at).toISOString()).toBe(plus(seven, DAY).toISOString());
    const log = await ok<any>(owner('GET', `/api/interests/${a.id}/deliveries`));
    expect(log.deliveries[0]).toMatchObject({ itemCount: 3, heldBack: 0, trigger: 'schedule' });
    // a second pass at the same time delivers nothing more
    await ctx().services.scheduler.run();
    expect(
      (await q('SELECT count(*)::int AS n FROM interest_deliveries WHERE interest_id=$1', [a.id]))[0]?.n,
    ).toBe(1);
    expect(c2.runId).toBeTruthy();
  });

  it('a delivery time with nothing held only moves the next delivery', async () => {
    const seven = new Date(
      new Date(
        (await q(`SELECT next_delivery_at FROM interests WHERE name='Morning digest'`))[0]?.next_delivery_at,
      ).getTime(),
    );
    setNow(plus(seven, 30_000));
    await ctx().services.scheduler.run();
    const a = (await q(`SELECT * FROM interests WHERE name='Morning digest'`))[0] as Record<string, any>;
    expect(new Date(a.next_delivery_at).toISOString()).toBe(plus(seven, DAY).toISOString());
    expect(
      (await q('SELECT count(*)::int AS n FROM interest_deliveries WHERE interest_id=$1', [a.id]))[0]?.n,
    ).toBe(1);
  });

  it('deliver now puts the held items on the desk ahead of the schedule', async () => {
    const a = await createFeedInterest(w, {
      name: 'Early',
      delivery: { mode: 'scheduled', cron: '0 23 * * *', timezone: 'UTC' },
    });
    await scanAndDigest(a.id, [item(11)]);
    expect(await feedItems(w, a.id)).toHaveLength(0);
    expect(await ok<any>(owner('POST', `/api/interests/${a.id}/deliver`))).toMatchObject({
      delivered: 1,
      heldBack: 0,
    });
    expect(await feedItems(w, a.id)).toHaveLength(1);
    expect(await ok<any>(owner('POST', `/api/interests/${a.id}/deliver`))).toMatchObject({ delivered: 0 });
  });

  it('the quiet cap limits the items per day across all interests; the rest wait for the next day', async () => {
    const t0 = new Date(ctx().clock.now());
    await online();
    const a = await createFeedInterest(w, { name: 'Cap A' });
    const b = await createFeedInterest(w, { name: 'Cap B' });
    // earlier tests delivered items today: the cap leaves room for three more
    const already = (await ok<any>(owner('GET', '/api/interests'))).deliveredToday;
    await ok(owner('PUT', '/api/reporting', { interestDigestCap: already + 3 }));
    await scanAndDigest(a.id, [item(21), item(22)]);
    expect(await feedItems(w, a.id)).toHaveLength(2);
    await scanAndDigest(b.id, [item(23), item(24), item(25)]);
    // one more item fit under the cap of 3; two are held
    expect(await feedItems(w, b.id)).toHaveLength(1);
    expect((await ok<any>(owner('GET', `/api/interests/${b.id}`))).interest.stats.items.held).toBe(2);
    const list = await ok<any>(owner('GET', '/api/interests'));
    expect(list).toMatchObject({ quietCap: already + 3, deliveredToday: already + 3 });
    const log = await ok<any>(owner('GET', `/api/interests/${b.id}/deliveries`));
    expect(log.deliveries[0]).toMatchObject({ itemCount: 1, heldBack: 2 });
    // still capped later the same day
    setNow(plus(t0, 11 * 3600_000));
    await ctx().services.scheduler.run();
    expect(await feedItems(w, b.id)).toHaveLength(1);
    // a day later the held items are delivered
    setNow(plus(t0, 25 * 3600_000));
    await ctx().services.scheduler.run();
    expect(await feedItems(w, b.id)).toHaveLength(3);
    await ok(owner('PUT', '/api/reporting', { interestDigestCap: null }));
  });

  it('drops items of a kind the interest does not want', async () => {
    const a = await createFeedInterest(w, { name: 'Articles only', kinds: ['article'] });
    const vid = item(31, {
      kind: 'video',
      url: 'https://video.example.test/v31',
      title: 'Zeta barrel tuner video',
    });
    await scanAndDigest(a.id, [item(30), vid]);
    const items = await feedItems(w, a.id);
    expect(items.map((i: any) => i.kind)).toEqual(['article']);
  });
});

describe('the assigned agent is a soft preference', () => {
  it('an agent restricted to other projects takes an interest run only when it is the assigned agent', async () => {
    await w.hire('Narrow', 'scout', 'junior', { allowedProjectIds: [w.projectId] });
    const narrow = (await q(`SELECT id FROM agents WHERE name='Narrow'`))[0]?.id as string;
    await q(`UPDATE agents SET status='retired' WHERE name IN ('Scout')`);
    await markOnline(w.t, w.workstationId);
    const a = await createFeedInterest(w, { name: 'Pinned' });
    const first = await runNow(w, a.id);
    expect(await ctx().services.dispatcher.runPass()).toEqual([]);
    await ok(owner('PATCH', `/api/interests/${a.id}`, { agents: { scout: narrow } }));
    const detail = await ok<any>(owner('GET', `/api/interests/${a.id}`));
    expect(detail.interest.agents.scout).toMatchObject({ id: narrow, name: 'Narrow' });
    const eligible = await ok<any>(owner('GET', `/api/interests/${a.id}/agents/eligible`));
    expect(eligible.scout.map((x: any) => x.name)).toContain('Narrow');
    // a new run carries the preference on its card, and the agent takes it at once (no claim window)
    await ok(owner('POST', `/api/cards/${first.ref}/cancel`, { reason: 'try again' }));
    const next = await runNow(w, a.id);
    expect(
      (await q('SELECT preferred_agents FROM cards WHERE id=$1', [next.cardId]))[0]?.preferred_agents,
    ).toEqual({ scout: narrow });
    const passed = await ctx().services.dispatcher.runPass();
    expect(passed).toHaveLength(1);
    expect(passed[0]?.agentId).toBe(narrow);
    // an agent of another role is refused
    const bad = await owner('PATCH', `/api/interests/${a.id}`, { agents: { curator: narrow } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('agent_not_eligible');
  });
});

describe('a run that cannot start', () => {
  it('backs off, raises one notice after the third failure, and closes it when the interest runs again', async () => {
    const a = await createFeedInterest(w, { name: 'Broken', scan: { cron: '0 7 * * *' } });
    await q(`UPDATE projects SET status='archived' WHERE id=$1`, [a.projectId]);
    let at = new Date(new Date((await interest(a.id)).next_scan_at).getTime() + 1000);
    for (let n = 1; n <= 3; n++) {
      setNow(at);
      await ctx().services.scheduler.run();
      const i = await interest(a.id);
      expect(i.fail_count).toBe(n);
      expect(i.last_error).toMatch(/archived/);
      expect(new Date(i.next_scan_at).getTime()).toBeGreaterThan(at.getTime());
      at = new Date(new Date(i.next_scan_at).getTime() + 1000);
    }
    const notices = await q(`SELECT id, status FROM desk_items WHERE subkind='interest_failing'`);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.status).toBe('open');
    const dto = (await ok<any>(owner('GET', `/api/interests/${a.id}`))).interest;
    expect(dto.stats).toMatchObject({ failing: true, failCount: 3 });
    await q(`UPDATE projects SET status='active' WHERE id=$1`, [a.projectId]);
    setNow(at);
    await ctx().services.scheduler.run();
    expect((await interest(a.id)).fail_count).toBe(0);
    expect((await q(`SELECT status FROM desk_items WHERE id=$1`, [notices[0]?.id]))[0]?.status).not.toBe(
      'open',
    );
  });
});

describe('rebuilding the projections', () => {
  it('reproduces interests, runs, deliveries, held items and the taste rules', async () => {
    const snap = async () => ({
      interests: (await q(`SELECT to_jsonb(i)::text AS j FROM interests i ORDER BY id`)).map((x) => x.j),
      runs: (await q(`SELECT to_jsonb(x)::text AS j FROM interest_runs x ORDER BY id`)).map((x) => x.j),
      deliveries: (await q(`SELECT to_jsonb(x)::text AS j FROM interest_deliveries x ORDER BY id`)).map(
        (x) => x.j,
      ),
      items: (
        await q(`SELECT id, card_id, delivered_at, desk_item_id, verdict FROM digest_items ORDER BY id`)
      ).map((x) => JSON.stringify(x)),
      cards: (
        await q(`SELECT id, interest_id, interest_run_id, preferred_agents FROM cards ORDER BY id`)
      ).map((x) => JSON.stringify(x)),
      projects: (await q(`SELECT id, kind, vault_dir FROM projects ORDER BY id`)).map((x) =>
        JSON.stringify(x),
      ),
    });
    const before = await snap();
    expect(before.runs.length).toBeGreaterThan(3);
    expect(before.deliveries.length).toBeGreaterThan(1);
    await rebuildProjections(ctx().pool, ctx().store);
    const after = await snap();
    expect(after).toEqual(before);
  });
});
