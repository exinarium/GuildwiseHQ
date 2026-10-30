import { ledgerToday } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reviewDueBriefSection } from '../src/ceo/review-due.ts';
import { standingOrdersFor } from '../src/queries/ledger.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

// Release 1.4.0: review dates on ledger entries. A passed date marks an entry; it never unbinds it.

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const call = (method: string, url: string, body?: unknown, status = 200) =>
  ok<any>(w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) }), status);
const day = (offset: number) =>
  new Date(w.t.clock.now().getTime() + offset * 86_400_000).toISOString().slice(0, 10);
const add = (body: Record<string, unknown>) =>
  call('POST', '/api/ledger', { scope: 'standing_order', ...body }, 201).then((r) => r.entry);
const events = (id: string) =>
  q('SELECT type, payload FROM events WHERE stream_id=$1 ORDER BY seq', [`ledger-${id}`]);

describe('review dates through the API', () => {
  it('creates a decision and a standing order with a date, and entries without one have none', async () => {
    const order = await add({ title: 'Dated order', body: 'Dated order text, quokka.', reviewDate: day(5) });
    const decision = await add({
      scope: 'decision',
      title: 'Dated decision',
      body: 'Dated decision text.',
      projectId: w.projectId,
      reviewDate: day(3),
    });
    const plain = await add({ title: 'Plain order', body: 'Plain order text, wombat.' });
    expect(order).toMatchObject({ reviewDate: day(5), reviewDue: false, reviewedAt: null });
    expect(decision).toMatchObject({ reviewDate: day(3), reviewDue: false });
    expect(plain).toMatchObject({ reviewDate: null, reviewDue: false });
    const list = (await call('GET', '/api/ledger')).entries;
    expect(list.find((e: any) => e.id === order.id)?.reviewDate).toBe(day(5));
  });

  it('rejects a past date on create (400 review_date_past) and on change', async () => {
    const r = await w.t.req('POST', '/api/ledger', {
      cookie: w.owner.cookie,
      body: { scope: 'standing_order', title: 'Past', body: 'Past date.', reviewDate: day(-1) },
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain('review_date_past');
    const e = await add({ title: 'Edit me', body: 'Edit me text, lemur.' });
    await call('PATCH', `/api/ledger/${e.id}`, { reviewDate: day(-1) }, 400);
  });

  it('changes and clears a date on a decision and a standing order, recorded as events, without touching the version', async () => {
    const order = await add({ title: 'Change order', body: 'Change order text, ibex.', reviewDate: day(2) });
    const changed = await call('PATCH', `/api/ledger/${order.id}`, { reviewDate: day(9) });
    expect(changed.entry).toMatchObject({ reviewDate: day(9), version: 1 });
    const cleared = await call('PATCH', `/api/ledger/${order.id}`, { reviewDate: null });
    expect(cleared.entry).toMatchObject({ reviewDate: null, version: 1 });
    const types = (await events(order.id)).map((e: any) => e.type);
    expect(types.filter((t: string) => t === 'LedgerEntryReviewDateSet')).toHaveLength(2);
    expect(types).not.toContain('LedgerEntryEdited');

    const dec = await add({ scope: 'decision', title: 'A decision', body: 'Text.', projectId: w.projectId });
    expect((await call('PATCH', `/api/ledger/${dec.id}`, { reviewDate: day(4) })).entry.reviewDate).toBe(
      day(4),
    );
    // wording of a decision still cannot be changed
    await call('PATCH', `/api/ledger/${dec.id}`, { title: 'New' }, 409);
  });

  it('a mixed edit changes wording and date in one request', async () => {
    const e = await add({ title: 'Mixed', body: 'Mixed text, tapir.' });
    const r = await call('PATCH', `/api/ledger/${e.id}`, { body: 'Mixed text two.', reviewDate: day(6) });
    expect(r.entry).toMatchObject({ version: 2, reviewDate: day(6) });
  });
});

describe('a date that has come', () => {
  it('is due, filterable, still binding, and listed in the CEO brief; confirming removes the marker', async () => {
    const e = await add({ title: 'Soon due', body: 'Soon due order, narwhal.', reviewDate: day(1) });
    const other = await add({ title: 'Never due', body: 'Never due order, okapi.', reviewDate: day(300) });
    w.t.clock.advance(2 * 86_400_000);
    const today = ledgerToday(w.t.clock.now());

    const due = (await call('GET', '/api/ledger?due=true')).entries;
    expect(due.map((x: any) => x.id)).toContain(e.id);
    expect(due.map((x: any) => x.id)).not.toContain(other.id);
    expect(due.find((x: any) => x.id === e.id)).toMatchObject({ reviewDue: true });

    // still binding
    const orgId = (await q('SELECT org_id FROM ledger_entries WHERE id=$1', [e.id]))[0]?.org_id as string;
    const orders = await standingOrdersFor(w.t.app.ctx.pool, orgId, w.projectId);
    expect(orders.map((o) => o.title)).toContain('Soon due');

    // the CEO brief
    const section = await reviewDueBriefSection(w.t.app.ctx.pool, orgId, today);
    expect(section).toContain('Ledger entries due for review');
    expect(section).toContain('Soon due');
    expect(section).toContain(day(1));
    expect(section).not.toContain('Never due');
    expect(await reviewDueBriefSection(w.t.app.ctx.pool, orgId, '2000-01-01')).toBeUndefined();

    // confirm needs a date after today, or none
    await call('POST', `/api/ledger/${e.id}/review`, { reviewDate: today }, 400);
    const confirmed = await call('POST', `/api/ledger/${e.id}/review`, { reviewDate: day(40) });
    expect(confirmed.entry).toMatchObject({ reviewDate: day(40), reviewDue: false });
    expect(confirmed.entry.reviewedAt).toEqual(expect.any(String));
    expect((await events(e.id)).some((x: any) => x.payload.confirmed === true)).toBe(true);
    // not due any more: confirm is refused
    await call('POST', `/api/ledger/${e.id}/review`, { reviewDate: null }, 409);
  });

  it('a due entry can be retired as before, and a retired entry is no longer due', async () => {
    const e = await add({ title: 'Retire when due', body: 'Retire when due, civet.', reviewDate: day(0) });
    expect((await call('GET', `/api/ledger/${e.id}/history`)).entry.reviewDue).toBe(true);
    await call('POST', `/api/ledger/${e.id}/retire`, { reason: 'done' });
    expect((await call('GET', `/api/ledger/${e.id}/history`)).entry.reviewDue).toBe(false);
    await call('POST', `/api/ledger/${e.id}/review`, { reviewDate: null }, 409);
  });
});

describe('visibility', () => {
  it('an unknown entry gives 404', async () => {
    await call('POST', '/api/ledger/0192f3a0-0000-7000-8000-000000000999/review', { reviewDate: null }, 404);
    await call('PATCH', '/api/ledger/0192f3a0-0000-7000-8000-000000000999', { reviewDate: null }, 404);
  });
});

describe('migration', () => {
  it('entries without a date have NULL review columns', async () => {
    const e = await add({ title: 'Old style', body: 'Old style order, gecko.' });
    const row = (await q('SELECT review_date, reviewed_at FROM ledger_entries WHERE id=$1', [e.id]))[0];
    expect(row).toMatchObject({ review_date: null, reviewed_at: null });
  });
});
