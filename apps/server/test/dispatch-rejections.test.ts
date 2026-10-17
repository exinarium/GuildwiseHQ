import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { cardRow, pipeline } from './helpers/pipeline.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, type World } from './helpers/world.ts';

// Lean Team v3 (S1b), section 9 "Rejection storm on a broken worktree": every worktree_failed kind backs off, and three
// identical rejections raise one desk item.

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

const DETAIL = 'git worktree add failed: fatal: a branch named card/x is already checked out';
const items = () =>
  q(`SELECT id, status, repeat_count, title FROM desk_items WHERE subkind='worktree_rejections'`);
const reject = (agent: string, reason: string, extra: Record<string, unknown>) => {
  w.t.app.ctx.services.dispatcher.cooldown.clear(); // the agent's own 30 s pause after a rejection
  return p.reject(agent, reason, extra);
};
const dispatch = async () => {
  w.t.app.ctx.services.dispatcher.cooldown.clear();
  await q('UPDATE workstations SET last_seen_at=$1 WHERE connected', [w.t.clock.now()]);
  await r.barrier();
  await w.t.app.ctx.services.dispatcher.run();
  await r.barrier();
};

describe('a card whose worktree cannot be made', () => {
  it('backs off after every rejection (not only a missing branch), and raises one desk item after three identical ones', async () => {
    await freshState();
    await w.hire('Bea', 'builder', 'junior');
    const card = await w.card({ title: 'Broken worktree' });

    // 1st rejection: held back, no desk item yet
    await reject('Bea', 'worktree_failed', { detail: DETAIL });
    let c = await cardRow(card.id);
    expect(c.retry_failures).toBe(1);
    expect(new Date(c.retry_after).getTime()).toBeGreaterThan(w.t.clock.now().getTime());
    expect(c.last_rejection).toMatchObject({ reason: 'worktree_failed' });
    const starts = r.of('shift.start').length;
    await dispatch();
    expect(r.of('shift.start').length).toBe(starts); // the dispatcher does not claim it again every tick
    expect(await items()).toHaveLength(0);

    // the reason is on the shift
    const shift = (await q(`SELECT rejection_reason, outcome FROM shifts WHERE card_id=$1`, [card.id]))[0]!;
    expect(shift.outcome).toBe('rejected');
    expect(shift.rejection_reason).toContain('worktree_failed');
    expect(shift.rejection_reason).toContain('already checked out');

    // 2nd: still no item. The back-off ends (time passes), the card is offered again.
    await q('UPDATE cards SET retry_after=NULL WHERE id=$1', [card.id]);
    await reject('Bea', 'worktree_failed', { detail: DETAIL });
    expect((await cardRow(card.id)).retry_failures).toBe(2);
    expect(await items()).toHaveLength(0);

    // 3rd identical: one desk item, linked to the card
    await q('UPDATE cards SET retry_after=NULL WHERE id=$1', [card.id]);
    await reject('Bea', 'worktree_failed', { detail: DETAIL });
    c = await cardRow(card.id);
    expect(c.retry_failures).toBe(3);
    const open = await items();
    expect(open).toHaveLength(1);
    expect(open[0]?.title).toContain('keeps being turned away');

    // a 4th does not make a second item, it counts on the first
    await q('UPDATE cards SET retry_after=NULL WHERE id=$1', [card.id]);
    await reject('Bea', 'worktree_failed', { detail: DETAIL });
    const after = await items();
    expect(after).toHaveLength(1);
    expect(after[0]?.repeat_count).toBe(2);
  });

  it('different reasons do not add up to one storm', async () => {
    await freshState();
    await w.hire('Bea', 'builder', 'junior');
    const card = await w.card({ title: 'Mixed rejections' });
    await reject('Bea', 'worktree_failed', { detail: 'one cause' });
    await q('UPDATE cards SET retry_after=NULL WHERE id=$1', [card.id]);
    await reject('Bea', 'repo_missing', { detail: 'another cause' });
    await q('UPDATE cards SET retry_after=NULL WHERE id=$1', [card.id]);
    await reject('Bea', 'worktree_failed', { detail: 'a third cause' });
    expect(await items()).toHaveLength(0);
  });
});
