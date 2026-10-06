import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createFeedProject, feedSchedule } from './helpers/feeds.ts';
import { createWorld, ok, type Session, type World } from './helpers/world.ts';

let w: World;
let feedId: string;
let researchId: string;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  feedId = await createFeedProject(w);
  const r = await ok<any>(
    w.t.req('POST', '/api/projects', {
      cookie: w.owner.cookie,
      body: {
        key: 'RES',
        name: 'Research',
        workflowKey: 'research',
        domain: 'personal',
        subCategories: ['a'],
      },
    }),
    201,
  );
  researchId = r.project.id;
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const as = (s: Session, method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: s.cookie, body });
const owner = (method: string, url: string, body?: unknown) => as(w.owner, method, url, body);
const setNow = (at: Date) => w.t.app.ctx.clock.setOffset(at.getTime() - Date.now());
// biome-ignore lint/suspicious/noExplicitAny: a row read for assertions
const schedule = async (id: string): Promise<any> =>
  (await q('SELECT * FROM schedules WHERE id=$1', [id]))[0];
const create = (body: Record<string, unknown>) => owner('POST', '/api/interests', body);
const fresh = (name: string, extra: Record<string, unknown> = {}) =>
  ok<{ id: string }>(create({ name, feedProjectId: feedId, ...extra }), 201);

describe('creating interests', () => {
  it('needs at least one project and rejects mixed or wrong-kind projects', async () => {
    const none = await create({ name: 'Nothing' });
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe('interest_needs_project');
    const wrongFeed = await create({ name: 'Wrong', feedProjectId: researchId });
    expect(wrongFeed.body.error.code).toBe('not_a_feed_project');
    const wrongResearch = await create({ name: 'Wrong', researchProjectId: feedId });
    expect(wrongResearch.body.error.code).toBe('not_a_research_project');
    const both = await create({
      name: 'Both',
      feedProjectId: feedId,
      newFeedProject: { key: 'ZZ', name: 'Z' },
    });
    expect(both.status).toBe(400);
  });

  it('a feed interest owns one schedule built from its template; a research-only one has none', async () => {
    const { id } = await fresh('Rust async', {
      description: 'Deep dives on tokio internals',
      preferredSites: ['lobste.rs'],
      subCategory: 'rust/async',
      scan: { cron: '0 7 * * *', timezone: 'Africa/Johannesburg', maxItems: 5 },
    });
    const detail = await ok<any>(owner('GET', `/api/interests/${id}`));
    expect(detail.interest).toMatchObject({
      name: 'Rust async',
      status: 'active',
      canManage: true,
      scan: {
        cron: '0 7 * * *',
        timezone: 'Africa/Johannesburg',
        windowHours: 24,
        maxItems: 5,
        manual: false,
      },
    });
    const s = await schedule(detail.interest.scheduleId);
    expect(s).toMatchObject({ interest_id: id, kind: 'feed', enabled: true, name: 'Rust async' });
    expect(s.card_template).toEqual({
      title: 'Rust async',
      cardType: 'feed',
      fields: {
        topic: 'Rust async',
        description: 'Deep dives on tokio internals',
        windowHours: 24,
        preferredSites: ['lobste.rs'],
        maxItems: 5,
        subCategory: 'rust/async',
      },
    });
    expect(new Date(s.next_fire_at).getUTCHours()).toBe(5);

    const research = await ok<{ id: string }>(
      create({ name: 'Reloading powders', researchProjectId: researchId, subCategory: 'shooting/reloading' }),
      201,
    );
    const rd = await ok<any>(owner('GET', `/api/interests/${research.id}`));
    expect(rd.interest.scheduleId).toBeNull();
    expect(rd.interest.scan).toBeNull();
    // the owner of the research project gets the new sub-category
    const proj = (await q('SELECT sub_categories FROM projects WHERE id=$1', [researchId]))[0];
    expect(proj?.sub_categories).toContain('shooting/reloading');
  });

  it('names are unique per organization, ignoring case', async () => {
    await fresh('Unique topic');
    const dup = await create({ name: 'UNIQUE topic', feedProjectId: feedId });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('interest_name_taken');
  });

  it('a bad cron or time zone is a 400 and appends nothing', async () => {
    const before = (await q('SELECT count(*)::int AS n FROM interests'))[0]?.n;
    const bad = await create({ name: 'Bad cron', feedProjectId: feedId, scan: { cron: 'nope' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_cron');
    expect((await q('SELECT count(*)::int AS n FROM interests'))[0]?.n).toBe(before);
  });

  it('creates a new feed project, the interest and its schedule in one go (and nothing when the key is taken)', async () => {
    const taken = await create({ name: 'Taken key', newFeedProject: { key: 'NEWS', name: 'Again' } });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('project_key_taken');
    expect(await q(`SELECT 1 FROM interests WHERE name='Taken key'`)).toHaveLength(0);

    const { id } = await ok<{ id: string }>(
      create({ name: 'AI feeds', newFeedProject: { key: 'AIF', name: 'AI feeds', domain: 'personal' } }),
      201,
    );
    const p = (await q(`SELECT * FROM projects WHERE key='AIF'`))[0];
    expect(p).toMatchObject({ workflow_key: 'feed', domain: 'personal' });
    const i = (await q('SELECT * FROM interests WHERE id=$1', [id]))[0];
    expect(i?.feed_project_id).toBe(p?.id);
    expect(
      await q('SELECT 1 FROM schedules WHERE interest_id=$1 AND project_id=$2', [id, p?.id]),
    ).toHaveLength(1);
  });
});

describe('authorization (any member of the linked projects may manage; others see nothing)', () => {
  it('a stranger sees no interests, a member of only one linked project cannot edit', async () => {
    const { id } = await ok<{ id: string }>(
      create({ name: 'Shared topic', feedProjectId: feedId, researchProjectId: researchId }),
      201,
    );
    const stranger = await w.t.userSession(uniqueEmail('stranger'));
    expect((await as(stranger, 'GET', '/api/interests')).body.interests).toEqual([]);
    expect((await as(stranger, 'GET', `/api/interests/${id}`)).status).toBe(404);
    expect((await as(stranger, 'PATCH', `/api/interests/${id}`, { name: 'x' })).status).toBe(404);
    expect((await as(stranger, 'GET', '/api/interests/adoptable')).body.schedules).toEqual([]);

    const guest = await w.t.userSession(uniqueEmail('guest'));
    await ok(owner('POST', `/api/projects/${feedId}/members`, { email: guest.email }), 201);
    await ok(as(guest, 'POST', `/api/projects/${feedId}/members/accept`));
    const list = await ok<any>(as(guest, 'GET', '/api/interests'));
    const seen = list.interests.find((x: any) => x.id === id);
    expect(seen).toMatchObject({ canManage: false, canRun: true, canResearch: false });
    const denied = await as(guest, 'PATCH', `/api/interests/${id}`, { description: 'mine' });
    expect(denied.status).toBe(403);

    // a feed-only interest made by the Owner: a guest of its feed project sees it but cannot edit it (rank rule)
    const feedOnly = await fresh('Owner made');
    const listed = await ok<any>(as(guest, 'GET', '/api/interests'));
    expect(listed.interests.find((x: any) => x.id === feedOnly.id)).toMatchObject({
      canManage: false,
      canRun: true,
    });
    const refused = await as(guest, 'PATCH', `/api/interests/${feedOnly.id}`, { description: 'mine now' });
    expect(refused.status).toBe(403);
    expect((await as(guest, 'POST', `/api/interests/${feedOnly.id}/run`)).status).toBe(403);
    expect((await as(guest, 'DELETE', `/api/interests/${feedOnly.id}`)).status).toBe(403);
  });

  it('creator rank: a guest edits their own interest, the Owner (higher rank) can edit it too', async () => {
    const guest = await w.t.userSession(uniqueEmail('guest2'));
    await ok(owner('POST', `/api/projects/${feedId}/members`, { email: guest.email }), 201);
    await ok(as(guest, 'POST', `/api/projects/${feedId}/members/accept`));
    const made = await ok<{ id: string }>(
      as(guest, 'POST', '/api/interests', { name: 'Guest topic', feedProjectId: feedId }),
      201,
    );
    const mine = await as(guest, 'PATCH', `/api/interests/${made.id}`, { description: 'by the guest' });
    expect(mine.status).toBe(200);
    expect(mine.body.canManage).toBe(true);
    const byOwner = await owner('PATCH', `/api/interests/${made.id}`, { description: 'by the owner' });
    expect(byOwner.status).toBe(200);
    expect(byOwner.body.description).toBe('by the owner');
  });
});

describe('the interest owns its schedule', () => {
  it('locks the linked schedule (409), keeps run now, and syncs edits', async () => {
    const { id } = await fresh('Sync me', { scan: { cron: '0 7 * * *', timezone: 'UTC' } });
    const d0 = await ok<any>(owner('GET', `/api/interests/${id}`));
    const sid = d0.interest.scheduleId as string;
    const patch = await owner('PATCH', `/api/schedules/${sid}`, { enabled: false });
    expect(patch.status).toBe(409);
    expect(patch.body.error).toMatchObject({
      code: 'schedule_managed_by_interest',
      details: { interestId: id },
    });
    expect((await owner('DELETE', `/api/schedules/${sid}`)).status).toBe(409);
    const listed = (await ok<any>(owner('GET', `/api/schedules?projectId=${feedId}`))).schedules.find(
      (s: any) => s.id === sid,
    );
    expect(listed).toMatchObject({ interestId: id, interestName: 'Sync me' });
    await ok(owner('POST', `/api/interests/${id}/run`), 201);
    const card = (await q('SELECT * FROM cards WHERE schedule_id=$1', [sid]))[0];
    expect(card?.interest_id).toBe(id);

    // description, sites, window, max items -> the template, same pending fire
    const before = (await schedule(sid)).next_fire_at;
    await ok(
      owner('PATCH', `/api/interests/${id}`, {
        description: 'new angle',
        scan: { maxItems: 3, windowHours: 12 },
      }),
    );
    const s1 = await schedule(sid);
    expect(s1.card_template.fields).toMatchObject({ description: 'new angle', maxItems: 3, windowHours: 12 });
    expect(s1.next_fire_at).toEqual(before);

    // cron change recomputes the next fire
    await ok(owner('PATCH', `/api/interests/${id}`, { scan: { cron: '30 18 * * *' } }));
    const s2 = await schedule(sid);
    expect(s2.cron).toBe('30 18 * * *');
    expect(new Date(s2.next_fire_at).getUTCHours()).toBe(18);

    // pause keeps the template and clears the next fire; resume gets a fresh one
    await ok(owner('PATCH', `/api/interests/${id}`, { status: 'paused' }));
    const s3 = await schedule(sid);
    expect(s3).toMatchObject({ enabled: false, next_fire_at: null });
    expect(s3.card_template).toEqual(s2.card_template);
    await ok(owner('PATCH', `/api/interests/${id}`, { status: 'active' }));
    const s4 = await schedule(sid);
    expect(s4.enabled).toBe(true);
    expect(s4.next_fire_at).not.toBeNull();

    // manual only
    await ok(owner('PATCH', `/api/interests/${id}`, { scan: { manual: true } }));
    expect((await schedule(sid)).enabled).toBe(false);
    expect((await ok<any>(owner('GET', `/api/interests/${id}`))).interest.stats.nextScanAt).toBeNull();
  });

  it('the window follows the cadence when only the cron changes', async () => {
    const { id } = await fresh('Window follows', { scan: { cron: '0 7 * * *' } });
    await ok(owner('PATCH', `/api/interests/${id}`, { scan: { cron: '0 7 * * 1' } }));
    const d = await ok<any>(owner('GET', `/api/interests/${id}`));
    expect(d.interest.scan.windowHours).toBe(168);
  });

  it('fires like any schedule and the card carries the interest id', async () => {
    const { id } = await fresh('Fires on time', { scan: { cron: '0 7 * * *', timezone: 'UTC' } });
    const d = await ok<any>(owner('GET', `/api/interests/${id}`));
    const due = new Date(d.interest.schedule.nextFireAt);
    setNow(new Date(due.getTime() + 2_000));
    try {
      const fired = await w.t.app.ctx.services.scheduler.run();
      expect(fired.length).toBeGreaterThan(0);
    } finally {
      w.t.app.ctx.clock.setOffset(0);
    }
    const cards = await q(`SELECT interest_id FROM cards WHERE schedule_id=$1`, [d.interest.scheduleId]);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.interest_id).toBe(id);
  });

  it('moving the feed project deletes the old schedule and creates a new one; removing it keeps the research link', async () => {
    const other = await ok<any>(
      w.t.req('POST', '/api/projects', {
        cookie: w.owner.cookie,
        body: { key: 'OTH', name: 'Other feed', workflowKey: 'feed', domain: 'personal' },
      }),
      201,
    );
    const { id } = await ok<{ id: string }>(
      create({ name: 'Mover', feedProjectId: feedId, researchProjectId: researchId }),
      201,
    );
    const first = (await ok<any>(owner('GET', `/api/interests/${id}`))).interest.scheduleId;
    await ok(owner('PATCH', `/api/interests/${id}`, { feedProjectId: other.project.id }));
    const moved = (await ok<any>(owner('GET', `/api/interests/${id}`))).interest;
    expect(moved.scheduleId).not.toBe(first);
    expect(await q('SELECT 1 FROM schedules WHERE id=$1', [first])).toHaveLength(0);
    expect((await schedule(moved.scheduleId))?.project_id).toBe(other.project.id);

    await ok(owner('PATCH', `/api/interests/${id}`, { feedProjectId: null }));
    const research = (await ok<any>(owner('GET', `/api/interests/${id}`))).interest;
    expect(research).toMatchObject({ scheduleId: null, scan: null, feedProject: null });
    expect(await q('SELECT 1 FROM schedules WHERE interest_id=$1', [id])).toHaveLength(0);
    const none = await owner('PATCH', `/api/interests/${id}`, { researchProjectId: null });
    expect(none.status).toBe(400);
  });

  it('deleting removes the schedule, or unlinks it when asked to keep it', async () => {
    const a = await fresh('Delete both');
    const sa = (await ok<any>(owner('GET', `/api/interests/${a.id}`))).interest.scheduleId;
    await ok(owner('DELETE', `/api/interests/${a.id}`));
    expect(await q('SELECT 1 FROM schedules WHERE id=$1', [sa])).toHaveLength(0);
    expect((await owner('GET', `/api/interests/${a.id}`)).status).toBe(404);

    const b = await fresh('Keep schedule');
    const sb = (await ok<any>(owner('GET', `/api/interests/${b.id}`))).interest.scheduleId;
    await ok(owner('DELETE', `/api/interests/${b.id}?keepSchedule=true`));
    const kept = await schedule(sb);
    expect(kept).toMatchObject({ interest_id: null });
    // a plain schedule again: editable
    await ok(owner('PATCH', `/api/schedules/${sb}`, { enabled: false }));
  });
});

describe('adopting existing schedules', () => {
  it('turns schedules into interests without rewriting the template, back-fills earlier cards, and refuses repeats', async () => {
    await q('DELETE FROM interests');
    await q('UPDATE schedules SET interest_id = NULL');
    await q('DELETE FROM schedules');
    const s1 = await ok<any>(
      feedSchedule(w, feedId, {
        name: 'Daily news',
        cardTemplate: {
          title: 'News run',
          fields: {
            topic: 'reloading',
            description: 'powders',
            maxPerKind: { article: 4, video: 3 },
            windowHours: 48,
          },
        },
      }),
      201,
    );
    const s2 = await ok<any>(
      feedSchedule(w, feedId, {
        name: 'Other',
        enabled: false,
        cardTemplate: { title: 'Other', fields: { topic: 'reloading' } },
      }),
      201,
    );
    await ok(owner('POST', `/api/schedules/${s1.id}/run`), 201);
    expect(
      (await q('SELECT interest_id FROM cards WHERE schedule_id=$1', [s1.id]))[0]?.interest_id,
    ).toBeNull();

    const adoptable = await ok<any>(owner('GET', '/api/interests/adoptable'));
    expect(adoptable.schedules.map((s: any) => s.id).sort()).toEqual([s1.id, s2.id].sort());
    expect((await ok<any>(owner('GET', '/api/interests'))).adoptableCount).toBe(2);

    const res = await ok<any>(owner('POST', '/api/interests/adopt', { scheduleIds: [s1.id, s2.id] }));
    expect(res.results.every((r: any) => r.interestId)).toBe(true);
    const list = (await ok<any>(owner('GET', '/api/interests'))).interests;
    const a = list.find((i: any) => i.name === 'reloading');
    const b = list.find((i: any) => i.name === 'reloading (2)');
    expect(a).toMatchObject({
      status: 'active',
      description: 'powders',
      scan: { cron: '0 7 * * *', windowHours: 48, maxItems: 7, manual: false },
    });
    expect(b.status).toBe('paused');
    // the template was not rewritten, the earlier card was back-filled
    expect((await schedule(s1.id)).card_template.fields.maxPerKind).toEqual({ article: 4, video: 3 });
    expect((await q('SELECT interest_id FROM cards WHERE schedule_id=$1', [s1.id]))[0]?.interest_id).toBe(
      a.id,
    );
    expect(a.stats.scans30d).toBe(1);

    const again = await ok<any>(owner('POST', '/api/interests/adopt', { scheduleIds: [s1.id] }));
    expect(again.results[0].error).toMatch(/already belongs/);

    // the first edit normalizes the template
    await ok(owner('PATCH', `/api/interests/${a.id}`, { description: 'powders and bullets' }));
    expect((await schedule(s1.id)).card_template.fields).toEqual({
      topic: 'reloading',
      description: 'powders and bullets',
      windowHours: 48,
      maxItems: 7,
    });
  });

  it('refuses other users schedules', async () => {
    const s = await ok<any>(feedSchedule(w, feedId, { name: 'Mine' }), 201);
    const stranger = await w.t.userSession(uniqueEmail('stranger'));
    const res = await ok<any>(as(stranger, 'POST', '/api/interests/adopt', { scheduleIds: [s.id] }));
    expect(res.results[0].error).toBeTruthy();
    expect(res.results[0].interestId).toBeUndefined();
  });
});
