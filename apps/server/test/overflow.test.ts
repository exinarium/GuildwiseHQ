import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createFeedInterest, runNow } from './helpers/feeds.ts';
import { shiftHelpers } from './helpers/shifts.ts';
import { createWorld, markOnline, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
let busyId: string;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
  busyId = (await createFeedInterest(w, { name: 'Busy' })).id;
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });

describe('overflow for late scheduled cards (docs/ARCHITECTURE.md section 9.4)', () => {
  it('with all scouts busy exactly one overflow shift starts and a second late schedule waits', async () => {
    const h = shiftHelpers(w);
    await w.hire('Solo', 'scout', 'junior', { capacity: 1 });
    // The only scout is busy with normal work.
    const normal = await runNow(w, busyId);
    // an ordinary (unscheduled) card: the scout's busy shift is normal work
    await q('UPDATE cards SET scheduled=false WHERE id=$1', [normal.cardId]);
    const busy = await h.dispatchTo(r, 'Solo');
    await h.startShift(r, busy);

    // Two schedules come due; both cards are scheduled and queued for the same role.
    const a = await createFeedInterest(w, { name: 'Late A', scan: { cron: '0 7 * * *' } });
    const b = await createFeedInterest(w, { name: 'Late B', scan: { cron: '0 7 * * *' } });
    const dueOf = async (id: string) =>
      new Date((await q('SELECT next_scan_at FROM interests WHERE id=$1', [id]))[0]?.next_scan_at).getTime();
    const due = Math.max(await dueOf(a.id), await dueOf(b.id));
    w.t.app.ctx.clock.setOffset(due - Date.now() + 1000);
    await w.t.app.ctx.services.scheduler.run();
    expect((await q(`SELECT 1 FROM cards WHERE scheduled AND status='queued'`)).length).toBe(2);
    await markOnline(w.t, w.workstationId);
    // "Late": queued for more than 30 s (the pass takes the card's queue time, so back-date it).
    await q(`UPDATE cards SET queued_at = $1 WHERE scheduled`, [
      new Date(w.t.app.ctx.clock.now().getTime() - 120_000),
    ]);

    const first = await w.t.app.ctx.services.dispatcher.runPass();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ overflow: true, agentId: busy.agent.agentId });
    // One extra shift at a time: the second late schedule waits.
    expect(await w.t.app.ctx.services.dispatcher.runPass()).toEqual([]);
    const claimed = await q(
      'SELECT ref, claim_overflow, scheduled FROM cards WHERE claim_id IS NOT NULL ORDER BY number',
    );
    expect(claimed.filter((c) => c.claim_overflow)).toHaveLength(1);
    expect(claimed.filter((c) => c.scheduled)).toHaveLength(1);
    const waiting = await q(`SELECT ref FROM cards WHERE scheduled AND status='queued'`);
    expect(waiting).toHaveLength(1);

    // When the overflow shift is over the next late schedule gets the extra shift.
    const overflowStart = await r.waitFor('shift.start', (f) => f.shiftId === first[0]?.shiftId);
    await h.startShift(r, overflowStart);
    r.ended(overflowStart.shiftId, 'no_report');
    await until(
      async () =>
        (await q(`SELECT 1 FROM cards WHERE scheduled AND status='queued' AND queued_at IS NOT NULL`))
          .length === 2,
      3000,
      'overflow card released',
    );
    const next = await w.t.app.ctx.services.dispatcher.runPass();
    expect(next).toHaveLength(1);
    expect(next[0]?.overflow).toBe(true);
  });
});
