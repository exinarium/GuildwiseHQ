import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cardUsage, stopLossBudget, stopLossEvents } from '../src/commands/stop-loss.ts';
import { withTx } from '../src/db/tx.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { freshState, shiftHelpers } from './helpers/shifts.ts';
import { createWorld, type World } from './helpers/world.ts';

/**
 * Stop-loss baseline: budgets count from the deploy for the cards that existed then (migration 2190), a new card is
 * counted from zero history; crash-dominated questions say so; a card the loop breaker parked gets no second item.
 */

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
const cardRow = async (id: string) => (await q('SELECT * FROM cards WHERE id=$1', [id]))[0]!;
const stopItems = (cardId: string) =>
  q(`SELECT * FROM desk_items WHERE card_id=$1 AND subkind='stop_loss'`, [cardId]);
const DAY = 86_400_000;

async function setup() {
  await freshState();
  await q('DELETE FROM desk_items');
  await q('DELETE FROM card_stop_loss_baseline');
  await q('UPDATE projects SET stop_loss = NULL');
  const bea = await w.hire('Bea', 'builder', 'junior');
  const card = await w.card({ title: 'Long runner', designNeeded: false });
  return { bea, card };
}

async function seedShifts(
  agentId: string,
  cardId: string,
  n: number,
  startedAt: Date,
  outcome = 'crashed',
): Promise<void> {
  for (let i = 0; i < n; i++)
    await q(
      `INSERT INTO shifts (id, org_id, agent_id, workstation_id, card_id, kind, stage, status, outcome, runtime, model, overflow, started_at, ended_at)
       VALUES ($1,$2,$3,$4,$5,'card','build','ended',$6,'mock','mock',false,$7,$7)`,
      [randomUUID(), w.owner.id, agentId, w.workstationId, cardId, outcome, startedAt],
    );
}

const baseline = (cardId: string, since: Date) =>
  q('INSERT INTO card_stop_loss_baseline (card_id, since) VALUES ($1,$2)', [cardId, since]);

describe('stop-loss baseline', () => {
  it('an existing card with a large history and a baseline is not parked', async () => {
    const { bea, card } = await setup();
    const now = w.t.clock.now();
    await seedShifts(bea.id, card.id, 143, new Date(now.getTime() - 5 * DAY));
    await baseline(card.id, new Date(now.getTime() - 60_000));
    const usage = await cardUsage(w.t.app.ctx.pool, card.id);
    expect(usage.shifts).toBe(0);
    const start = await h().dispatchTo(r, 'Bea', r.received.length);
    expect(start.brief.card.id).toBe(card.id);
    expect((await cardRow(card.id)).status).toBe('claimed');
    expect(await stopItems(card.id)).toHaveLength(0);
  });

  it('a new card (no baseline) is counted from zero history and parks at the budget', async () => {
    const { bea, card } = await setup();
    const now = w.t.clock.now();
    await seedShifts(bea.id, card.id, 10, new Date(now.getTime() - 5 * DAY));
    expect((await cardUsage(w.t.app.ctx.pool, card.id)).shifts).toBe(10);
    await w.t.app.ctx.services.dispatcher.run();
    expect((await cardRow(card.id)).status).toBe('blocked');
    expect(await stopItems(card.id)).toHaveLength(1);
  });

  it('only counts shifts, and arbitrations, at or after the baseline; those still trigger', async () => {
    const { bea, card } = await setup();
    const now = w.t.clock.now();
    await seedShifts(bea.id, card.id, 50, new Date(now.getTime() - 5 * DAY));
    await baseline(card.id, new Date(now.getTime() - DAY));
    await seedShifts(bea.id, card.id, 10, new Date(now.getTime() - 60_000), 'reported');
    const usage = await cardUsage(w.t.app.ctx.pool, card.id);
    expect(usage.shifts).toBe(10);
    // An arbitration answered before the baseline adds nothing to the budget.
    await q(
      `INSERT INTO desk_items (id, org_id, card_id, kind, subkind, status, title, created_at, updated_at)
       VALUES ($1,$2,$3,'question','stop_loss','answered','old',$4,$4)`,
      [randomUUID(), w.owner.id, card.id, new Date(now.getTime() - 3 * DAY)],
    );
    const row = await cardRow(card.id);
    const budget = await stopLossBudget(w.t.app.ctx.pool, row);
    expect(budget.shifts).toBe(10);
    await w.t.app.ctx.services.dispatcher.run();
    expect((await cardRow(card.id)).status).toBe('blocked');
    expect((await stopItems(card.id)).filter((i) => i.status === 'open')).toHaveLength(1);
  });

  it('says so when the shifts mostly crashed, with the last error, and does not ask about the reviewer', async () => {
    const { bea, card } = await setup();
    const now = w.t.clock.now();
    await seedShifts(bea.id, card.id, 9, new Date(now.getTime() - 60_000));
    await seedShifts(bea.id, card.id, 1, new Date(now.getTime() - 30_000), 'reported');
    await q(
      `INSERT INTO desk_items (id, org_id, card_id, kind, subkind, status, title, body, created_at, updated_at)
       VALUES ($1,$2,$3,'alert','loop_backoff','dismissed','keeps failing',$4,$5,$5)`,
      [
        randomUUID(),
        w.owner.id,
        card.id,
        'The shifts ended without a report 3 times.\n\nLast output:\nBash was denied',
        now,
      ],
    );
    await w.t.app.ctx.services.dispatcher.run();
    const [item] = await stopItems(card.id);
    expect(item?.title).toContain('9 of 10 shifts ended without a report');
    expect(item?.title).toContain('mostly crashed');
    expect(item?.title).toContain('last error: Bash was denied');
    expect(item?.title).not.toContain('reviewer');
  });

  it('raises no second blocking item for a card the loop breaker already parked', async () => {
    const { bea, card } = await setup();
    const now = w.t.clock.now();
    await seedShifts(bea.id, card.id, 12, new Date(now.getTime() - 60_000));
    await q(
      `INSERT INTO desk_items (id, org_id, card_id, kind, subkind, status, blocking, title, created_at, updated_at)
       VALUES ($1,$2,$3,'escalation','loop_parked','open',true,'parked',$4,$4)`,
      [randomUUID(), w.owner.id, card.id, now],
    );
    const row = await cardRow(card.id);
    const events = await withTx(w.t.app.ctx.pool, async (tx) => {
      const usage = await cardUsage(tx, card.id);
      const budget = await stopLossBudget(tx, row);
      return stopLossEvents(w.t.app.ctx, tx, row, 'shifts', usage, budget);
    });
    expect(events).toEqual([]);
    expect(await stopItems(card.id)).toHaveLength(0);
  });

  it('a projection rebuild keeps the baseline', async () => {
    const { card } = await setup();
    // The earlier tests wiped projections without events (freshState), so a replay would hire twice: start from an empty log.
    await q('TRUNCATE events CASCADE');
    const since = new Date(w.t.clock.now().getTime() - 60_000);
    await baseline(card.id, since);
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    const rowsAfter = await q('SELECT since FROM card_stop_loss_baseline WHERE card_id=$1', [card.id]);
    expect(rowsAfter).toHaveLength(1);
    expect(new Date(rowsAfter[0]?.since).getTime()).toBe(since.getTime());
  });
});
