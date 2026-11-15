import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dispatchPrReviews } from '../src/commands/pr-review-runs.ts';
import { closeAdminPool } from './helpers/db.ts';
import { manualWorld } from './helpers/pr-review-manual.ts';

/** GWP-201 AC4, from the trigger side: the daily cap is used up and the owner's trigger still starts. Needs the test database. */

let m: Awaited<ReturnType<typeof manualWorld>>;

beforeAll(async () => {
  m = await manualWorld();
});
afterAll(async () => {
  m.r.close();
  await m.w.t.close();
  await closeAdminPool();
});
beforeEach(async () => {
  await m.clean();
  await m.db().query('UPDATE projects SET pr_review_daily_cap=1 WHERE id=$1', [m.w.projectId]);
});

const queue = async () =>
  (await m.w.t.req('GET', `/api/projects/${m.w.projectId}/pull-requests/queue`, { cookie: m.w.owner.cookie }))
    .body;

describe('AC4: the owner triggers past the cap', () => {
  it('the cap is used up by an automatic run: the scheduler starts nothing, the owner starts a queued PR and a re-run', async () => {
    const used = await m.addPr({ state: 'reviewed' });
    await m.addRun(used, { state: 'posted', agoMin: 5 });
    const queued = await m.addPr();
    const timedOut = await m.addPr();
    const first = await m.addRun(timedOut, { state: 'timed_out', code: 'timeout', agoMin: 5 });
    const q0 = await queue();
    expect(q0).toMatchObject({ used: 2, cap: 1 }); // the timed-out automatic run still counted
    expect(await dispatchPrReviews(m.ctx())).toBe(0);
    expect(await m.runCommands()).toBe(0);

    expect((await m.trigger(queued)).status).toBe(200);
    const rerun = await m.trigger(timedOut, { previousRunId: first });
    expect(rerun.status).toBe(200);
    expect(rerun.body.lastRun).toMatchObject({ trigger: 'manual', rerunOf: { runId: first } });
    expect(await m.runCommands()).toBe(2);
    // never counted: used stays, manual runs are listed separately
    expect(await queue()).toMatchObject({ used: 2, cap: 1, manualToday: 2 });
  });
});
