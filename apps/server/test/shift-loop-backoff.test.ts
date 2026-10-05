import { loopBackoffMinutes } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { freshState, shiftHelpers } from './helpers/shifts.ts';
import { createWorld, markOnline, ok, until, type World } from './helpers/world.ts';

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

const h = () => shiftHelpers(w);
const clock = () => w.t.app.ctx.clock;
const cardRow = async (id: string) => (await q('SELECT * FROM cards WHERE id=$1', [id]))[0]!;
const alerts = (cardId: string) =>
  q(`SELECT id, status FROM desk_items WHERE card_id=$1 AND subkind='loop_backoff'`, [cardId]);
const failMessages = async (cardId: string) =>
  (
    await q(`SELECT body FROM thread_messages WHERE thread_id=$1 AND kind='system' ORDER BY created_at`, [
      cardId,
    ])
  )
    .map((m) => m.body as string)
    .filter((b) => b.includes('without a report'));

/** One shift on the card that ends without a report; resolves once the claim is released. */
async function failShift(cardId: string, agent = 'Fay') {
  const start = await h().dispatchTo(r, agent, r.received.length);
  await h().startShift(r, start);
  r.ended(start.shiftId, 'no_report', { finalText: 'Bash was denied' });
  await until(async () => (await cardRow(cardId)).claim_id === null, 3000, 'claim released');
  await until(
    async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'ended']))[0],
    3000,
    'shift ended',
  );
  return start;
}

async function setup() {
  await freshState();
  await q('DELETE FROM desk_items');
  clock().setOffset(0);
  await w.hire('Fay', 'builder', 'junior');
  return w.card({ title: 'Loopy' });
}

describe('loop breaker (shift failures)', () => {
  it('the cap and the doubling', () => {
    expect([3, 4, 5, 6, 7, 8, 9, 10, 20].map(loopBackoffMinutes)).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60]);
  });

  it('3 failures in 10 minutes engage the back-off; the dispatcher skips the card; one alert, one message', async () => {
    const card = await setup();
    await failShift(card.id);
    await failShift(card.id);
    expect((await cardRow(card.id)).retry_after).toBeNull();
    await failShift(card.id);

    const c = await cardRow(card.id);
    expect(c.retry_failures).toBe(3);
    expect(new Date(c.retry_after).getTime() - clock().now().getTime()).toBeGreaterThan(50_000);
    expect(new Date(c.retry_after).getTime() - clock().now().getTime()).toBeLessThanOrEqual(60_000);
    expect(c.status).toBe('queued');

    // the dispatcher does not touch it
    expect(await w.t.app.ctx.services.dispatcher.run()).toEqual([]);
    expect((await cardRow(card.id)).claim_id).toBeNull();

    // thread: the first failure and the engagement, not one message per failure
    const msgs = await failMessages(card.id);
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toMatch(/held back until \d{2}:\d{2} UTC/);
    expect(await alerts(card.id)).toHaveLength(1);

    // visible on the card DTO
    const d = await ok<any>(w.t.req('GET', `/api/cards/${card.id}`, { cookie: w.owner.cookie }));
    expect(d.card.backoff).toMatchObject({ failures: 3 });
    expect(d.permissions.canReleaseBackoff).toBe(true);
  });

  it('after the back-off expires the card is retried; a further failure doubles it without a new alert or message', async () => {
    const card = await setup();
    for (let i = 0; i < 3; i++) await failShift(card.id);
    const msgsBefore = await failMessages(card.id);

    clock().setOffset(61_000);
    await markOnline(w.t, w.workstationId, { repoIds: [w.repoId] });
    await failShift(card.id); // dispatched again once the back-off ended
    const c = await cardRow(card.id);
    expect(c.retry_failures).toBe(4);
    const wait = new Date(c.retry_after).getTime() - clock().now().getTime();
    expect(wait).toBeGreaterThan(110_000);
    expect(wait).toBeLessThanOrEqual(120_000);
    expect(await alerts(card.id)).toHaveLength(1);
    expect(await failMessages(card.id)).toEqual(msgsBefore);

    // the cap
    await q('UPDATE cards SET retry_failures=9, retry_after=NULL WHERE id=$1', [card.id]);
    await failShift(card.id);
    const capped = await cardRow(card.id);
    expect(capped.retry_failures).toBe(10);
    expect(new Date(capped.retry_after).getTime() - clock().now().getTime()).toBeLessThanOrEqual(3_600_000);
    expect(new Date(capped.retry_after).getTime() - clock().now().getTime()).toBeGreaterThan(3_590_000);
  });

  it('a report resets the back-off', async () => {
    const card = await setup();
    for (let i = 0; i < 3; i++) await failShift(card.id);
    clock().setOffset(61_000);
    await markOnline(w.t, w.workstationId, { repoIds: [w.repoId] });
    const start = await h().dispatchTo(r, 'Fay', r.received.length);
    await h().startShift(r, start);
    const res = await h().report(r, start.shiftId, {
      kind: 'outcome',
      outcomeId: 'handoff',
      note: 'done',
      data: {},
    });
    expect(res.accepted).toBe(true);
    const c = await cardRow(card.id);
    expect(c).toMatchObject({ retry_after: null, retry_failures: 0, retry_episode_id: null });
  });

  it('failures separated by a report do not add up', async () => {
    const card = await setup();
    await failShift(card.id);
    await failShift(card.id);
    const start = await h().dispatchTo(r, 'Fay', r.received.length);
    await h().startShift(r, start);
    await h().report(r, start.shiftId, { kind: 'outcome', outcomeId: 'handoff', note: 'done', data: {} });
    r.ended(start.shiftId, 'reported');
    await r.barrier();
    // the card moved on (review); the earlier failures are history
    expect((await cardRow(card.id)).retry_failures).toBe(0);
  });

  it('the manager releases the back-off by hand: dispatchable at once, the alert is resolved', async () => {
    const card = await setup();
    for (let i = 0; i < 3; i++) await failShift(card.id);
    expect(await w.t.app.ctx.services.dispatcher.run()).toEqual([]);

    const res = await ok<any>(
      w.t.req('POST', `/api/cards/${card.id}/release-backoff`, {
        cookie: w.owner.cookie,
        body: { reason: 'fixed the permissions' },
      }),
    );
    expect(res.card.backoff).toBeNull();
    expect(res.permissions.canReleaseBackoff).toBe(false);
    const c = await cardRow(card.id);
    expect(c.retry_after).toBeNull();
    expect(c.retry_failures).toBe(3); // the next failure backs off longer
    expect((await alerts(card.id))[0]?.status).not.toBe('open');
    const types = (await q(`SELECT type FROM events WHERE stream_id=$1`, [`card-${card.id}`])).map(
      (e) => e.type,
    );
    expect(types).toContain('CardRetryReleased');

    const again = await w.t.req('POST', `/api/cards/${card.id}/release-backoff`, {
      cookie: w.owner.cookie,
      body: {},
    });
    expect(again.status).toBe(409);

    // claimable again right away
    const start = await h().dispatchTo(r, 'Fay', r.received.length);
    expect(start.brief.card.ref).toBe(card.ref);
    await h().startShift(r, start);
    r.ended(start.shiftId, 'no_report');
    await until(async () => (await cardRow(card.id)).retry_failures === 4, 3000, 'doubled');
    expect(await alerts(card.id)).toHaveLength(1);
  });

  it('a stopped shift is not a failure', async () => {
    const card = await setup();
    for (let i = 0; i < 4; i++) {
      const start = await h().dispatchTo(r, 'Fay', r.received.length);
      await h().startShift(r, start);
      r.ended(start.shiftId, 'stopped');
      await until(async () => (await cardRow(card.id)).claim_id === null, 3000, 'released');
    }
    expect((await cardRow(card.id)).retry_after).toBeNull();
  });
});
