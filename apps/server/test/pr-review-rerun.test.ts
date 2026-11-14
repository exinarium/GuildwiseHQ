import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dispatchPrReviews } from '../src/commands/pr-review-runs.ts';
import { manualReviewAction } from '../src/review/manual-action.ts';
import { closeAdminPool } from './helpers/db.ts';
import { manualWorld } from './helpers/pr-review-manual.ts';

/**
 * GWP-201 AC2: a re-run of a timed-out PR is recorded as a re-run of that run. Needs the test database (127.0.0.1:5433).
 */

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
});

describe('manualReviewAction (pure)', () => {
  const base = { reviewState: 'not_reviewed', closed: false, prOnly: true } as const;
  it('offers a re-run only after a timeout, linked to that run', () => {
    expect(manualReviewAction({ ...base, lastRun: { id: 'r1', state: 'timed_out' } })).toEqual({
      kind: 'rerun',
      previousRunId: 'r1',
    });
    expect(manualReviewAction({ ...base, lastRun: { id: 'r2', state: 'failed' } })).toEqual({
      kind: 'review_now',
      previousRunId: null,
    });
    expect(manualReviewAction({ ...base, lastRun: null })).toEqual({
      kind: 'review_now',
      previousRunId: null,
    });
  });
  it('refuses closed, reviewed, not PR-only and an active run', () => {
    expect(manualReviewAction({ ...base, closed: true, lastRun: null })).toEqual({ refused: 'closed' });
    expect(manualReviewAction({ ...base, reviewState: 'reviewed', lastRun: null })).toEqual({
      refused: 'not_eligible',
    });
    expect(manualReviewAction({ ...base, prOnly: false, lastRun: null })).toEqual({
      refused: 'not_eligible',
    });
    expect(manualReviewAction({ ...base, lastRun: { id: 'r', state: 'running' } })).toEqual({
      refused: 'running',
    });
    expect(manualReviewAction({ ...base, lastRun: { id: 'r', state: 'completed' } })).toEqual({
      refused: 'running',
    });
  });
});

describe('AC2: the re-run is linked to the run that timed out', () => {
  it('the owner sees a re-run offer; the POST with the id starts a linked manual run', async () => {
    const pr = await m.addPr();
    const first = await m.addRun(pr, { state: 'timed_out', code: 'timeout' });
    expect((await m.prOf(pr)).manualAction).toEqual({ kind: 'rerun', previousRunId: first });
    const res = await m.trigger(pr, { previousRunId: first });
    expect(res.status).toBe(200);
    expect(res.body.lastRun).toMatchObject({
      state: 'running',
      trigger: 'manual',
      rerunOf: { runId: first },
    });
    const runs = await m.runs(pr);
    expect(runs[1]).toMatchObject({ trigger: 'manual', requested_by: m.w.owner.id, rerun_of_run_id: first });
  });

  it('a POST with no body links too (the server decides, not the client)', async () => {
    const pr = await m.addPr();
    const first = await m.addRun(pr, { state: 'timed_out', code: 'timeout' });
    expect((await m.trigger(pr)).status).toBe(200);
    expect((await m.runs(pr))[1].rerun_of_run_id).toBe(first);
  });

  it('a wrong previousRunId is refused as stale and starts nothing', async () => {
    const pr = await m.addPr();
    await m.addRun(pr, { state: 'timed_out', code: 'timeout' });
    const res = await m.trigger(pr, { previousRunId: randomUUID() });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/stale_action/);
    expect(await m.runs(pr)).toHaveLength(1);
    expect(await m.runCommands()).toBe(0);
  });

  it('a failed latest run after an older timeout is a plain Review now, and the old id is stale', async () => {
    const pr = await m.addPr();
    const old = await m.addRun(pr, { state: 'timed_out', code: 'timeout', agoMin: 90 });
    await m.addRun(pr, { state: 'failed', code: 'error', agoMin: 30 });
    expect((await m.prOf(pr)).manualAction).toEqual({ kind: 'review_now', previousRunId: null });
    expect((await m.trigger(pr, { previousRunId: old })).status).toBe(409);
    const ok = await m.trigger(pr);
    expect(ok.status).toBe(200);
    expect((await m.runs(pr))[2].rerun_of_run_id).toBeNull();
  });

  it('a re-run that times out again stays not reviewed, is offered as a re-run of the second run and is not retried', async () => {
    const pr = await m.addPr();
    const first = await m.addRun(pr, { state: 'timed_out', code: 'timeout', agoMin: 60 });
    const from = m.r.received.length;
    expect((await m.trigger(pr)).status).toBe(200);
    const cmd: any = await m.r.waitFor('command', (f: any) => f.command === 'pr_review.run', 5000, from);
    await m.r.barrier();
    m.r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: { outcome: 'timeout', durationMs: 600_000, phase: 'review' },
    });
    await m.r.barrier();
    await m.ctx().notifier.flush();
    const second = (await m.runs(pr))[1];
    expect(second).toMatchObject({ state: 'timed_out', rerun_of_run_id: first });
    expect(await m.prOf(pr)).toMatchObject({
      state: 'not_reviewed',
      manualAction: { kind: 'rerun', previousRunId: second.id },
    });
    // no automatic retry, now or later
    const before = await m.runCommands();
    m.w.t.clock.setOffset(3_600_000);
    expect(await dispatchPrReviews(m.ctx())).toBe(0);
    m.w.t.clock.setOffset(0);
    expect(await m.runCommands()).toBe(before);
  });

  it('an event without rerunOfRunId projects null; the field survives a re-projection of the event', async () => {
    const pr = await m.addPr();
    const first = await m.addRun(pr, { state: 'timed_out', code: 'timeout' });
    expect((await m.trigger(pr)).status).toBe(200);
    const ev = (
      await m
        .db()
        .query(`SELECT payload FROM events WHERE type='PrReviewRunStarted' ORDER BY seq DESC LIMIT 1`)
    ).rows[0].payload;
    expect(ev.rerunOfRunId).toBe(first);
  });
});
