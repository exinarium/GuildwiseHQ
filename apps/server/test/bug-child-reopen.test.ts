import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import {
  approve,
  cardRow,
  DIFF_SMALL,
  eventsOfType,
  handoff,
  hireTeam,
  pipeline,
  testFail,
  testPass,
} from './helpers/pipeline.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
let p: ReturnType<typeof pipeline>;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
  p = pipeline(w, r);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const detail = (id: string) => ok<any>(w.t.req('GET', `/api/cards/${id}`, { cookie: w.owner.cookie }));
const board = async () =>
  (await ok<any>(w.t.req('GET', `/api/board?projectId=${w.projectId}`, { cookie: w.owner.cookie }))).columns;

describe('reopening a bug child', { timeout: 120_000 }, () => {
  /** Fails the parent in Test, then cancels the bug child so the parent is queued in Test again. */
  async function setup(title: string) {
    await freshState();
    await hireTeam(w, { builders: ['Bea'] });
    const card = await w.card({ title });
    await p.toTest('Bea', ['Rex']);
    await p.run('Tess', testFail());
    const child = (await q('SELECT * FROM cards WHERE parent_card_id=$1', [card.id]))[0]!;
    await ok(
      w.t.req('POST', `/api/cards/${child.id}/cancel`, { cookie: w.owner.cookie, body: { reason: 'no' } }),
    );
    expect(await cardRow(card.id)).toMatchObject({ stage: 'test', status: 'queued' });
    return { card, child };
  }
  const reopenChild = (id: string) =>
    w.t.req('POST', `/api/cards/${id}/reopen`, {
      cookie: w.owner.cookie,
      body: { toStage: 'build', reason: 'it was needed' },
    });
  const messages = async (id: string) =>
    ((await detail(id)).thread as any[]).filter((m) => m.kind === 'system').map((m) => m.body as string);

  it('puts a parent queued in Test back to waiting', async () => {
    const { card, child } = await setup('Reopen queued');
    await ok(reopenChild(child.id));
    expect(await cardRow(card.id)).toMatchObject({ stage: 'test', status: 'waiting' });
    expect((await eventsOfType('ParentCardRewaited')).filter((e) => e.cardId === card.id)).toHaveLength(1);
    expect((await messages(card.id)).some((m) => /waits for it again/.test(m))).toBe(true);
  });

  it('releases a claimed parent and puts it to waiting', async () => {
    const { card, child } = await setup('Reopen claimed');
    const start = await p.next('Tess'); // the real dispatcher claims the parent for a tester shift
    await p.startShift(r, start);
    expect(await cardRow(card.id)).toMatchObject({ stage: 'test', status: 'claimed' });
    await ok(reopenChild(child.id));
    expect(await cardRow(card.id)).toMatchObject({ stage: 'test', status: 'waiting', claim_id: null });
    const order = (
      await q(
        `SELECT type FROM events WHERE stream_id=$1 AND type IN ('ClaimReleased','ParentCardRewaited') ORDER BY seq DESC LIMIT 2`,
        [`card-${card.id}`],
      )
    )
      .map((x) => x.type)
      .reverse();
    expect(order).toEqual(['ClaimReleased', 'ParentCardRewaited']);
    r.ended(start.shiftId, 'cancelled'); // the tester's shift is over; later tests need the runner free
    await r.barrier();
  });

  // (a held card is a design waiting for dependencies and the release sweep frees it at once: not a stable Test state)
  for (const status of ['blocked']) {
    it(`never overrides a ${status} parent in Test`, async () => {
      const { card, child } = await setup(`Reopen ${status}`);
      await q(`UPDATE cards SET status=$2 WHERE id=$1`, [card.id, status]);
      await ok(reopenChild(child.id));
      expect(await cardRow(card.id)).toMatchObject({ stage: 'test', status });
      expect((await eventsOfType('ParentCardRewaited')).filter((e) => e.cardId === card.id)).toHaveLength(0);
      const re = new RegExp(`is ${status} in Test, so it was left as it is`);
      expect((await messages(card.id)).some((m) => re.test(m))).toBe(true);
    });
  }

  it('leaves a parent that is already waiting alone', async () => {
    const { card, child } = await setup('Reopen waiting');
    await q(`UPDATE cards SET status='waiting' WHERE id=$1`, [card.id]);
    await ok(reopenChild(child.id));
    expect(await cardRow(card.id)).toMatchObject({ stage: 'test', status: 'waiting' });
    expect((await eventsOfType('ParentCardRewaited')).filter((e) => e.cardId === card.id)).toHaveLength(0);
  });

  it('does not touch a done parent and warns instead', async () => {
    const { card, child } = await setup('Reopen done');
    await q(`UPDATE cards SET stage='done', status='done' WHERE id=$1`, [card.id]);
    await ok(reopenChild(child.id));
    expect(await cardRow(card.id)).toMatchObject({ stage: 'done', status: 'done' });
    expect((await messages(card.id)).some((m) => /is done, so it was left as it is/.test(m))).toBe(true);
    expect((await messages(child.id)).some((m) => /is done, so it was left as it is/.test(m))).toBe(true);
  });

  it('does not touch a parent that moved past Test and warns instead', async () => {
    const { card, child } = await setup('Reopen beyond');
    await q(`UPDATE cards SET stage='review', status='queued' WHERE id=$1`, [card.id]);
    await ok(reopenChild(child.id));
    expect(await cardRow(card.id)).toMatchObject({ stage: 'review', status: 'queued' });
    expect((await messages(card.id)).some((m) => /is in review, not Test/.test(m))).toBe(true);
  });
});
