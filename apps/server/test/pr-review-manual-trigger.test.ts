import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dispatchPrReviews } from '../src/commands/pr-review-runs.ts';
import { closeAdminPool } from './helpers/db.ts';
import { BASE, HEAD, manualWorld } from './helpers/pr-review-manual.ts';

/**
 * GWP-201 AC1: the owner starts a review by hand on a "not reviewed" PR that is not in the queue (failed run), and the
 * PR state follows the run result. Needs the test database (127.0.0.1:5433).
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

async function triggerAndGetCommand(prId: string, body?: unknown) {
  const from = m.r.received.length;
  const res = await m.trigger(prId, body);
  expect(res.status).toBe(200);
  const cmd: any = await m.r.waitFor('command', (f: any) => f.command === 'pr_review.run', 5000, from);
  await m.r.barrier();
  return { res, cmd };
}
const answer = async (cmd: any, result: unknown) => {
  m.r.send('command.result', { commandId: cmd.commandId, ok: true, result });
  await m.r.barrier();
  await m.ctx().notifier.flush();
};

describe('AC1: a by-hand review of a not reviewed PR starts a run and the state follows the result', () => {
  it('starts a run on a PR whose run failed, with no body (the Queue button)', async () => {
    const pr = await m.addPr();
    await m.addRun(pr, { state: 'failed', code: 'error' });
    const { res } = await triggerAndGetCommand(pr);
    expect(res.body).toMatchObject({
      id: pr,
      lastRun: { state: 'running', trigger: 'manual', rerunOf: null },
    });
    const runs = await m.runs(pr);
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ state: 'running', trigger: 'manual', requested_by: m.w.owner.id });
    expect(runs[1].rerun_of_run_id).toBeNull();
  });

  it('completed and posted: the PR is reviewed and offers no action', async () => {
    const pr = await m.addPr();
    await m.addRun(pr, { state: 'failed', code: 'error' });
    const { cmd } = await triggerAndGetCommand(pr);
    const from = m.r.received.length;
    await answer(cmd, {
      outcome: 'completed',
      headSha: HEAD,
      baseSha: BASE,
      durationMs: 60_000,
      summary: 'Fine.',
      changedLines: 100,
      findings: [],
    });
    const post: any = await m.r.waitFor('command', (f: any) => f.command === 'pr_review.post', 5000, from);
    await m.r.barrier();
    await answer(post, {
      ok: true,
      reviewUrl: 'https://github.com/acme/toy/pull/1#review-1',
      alreadyPosted: false,
    });
    expect(await m.prOf(pr)).toMatchObject({ state: 'reviewed', manualAction: null });
  });

  it('failed: the PR stays not reviewed, the owner may start again, and nothing starts by itself', async () => {
    const pr = await m.addPr();
    await m.addRun(pr, { state: 'failed', code: 'error' });
    const { cmd } = await triggerAndGetCommand(pr);
    await answer(cmd, {
      outcome: 'failed',
      code: 'model_error',
      error: 'boom',
      retryable: true,
      durationMs: 1000,
    });
    expect(await m.prOf(pr)).toMatchObject({
      state: 'not_reviewed',
      lastRun: { state: 'failed' },
      manualAction: { kind: 'review_now', previousRunId: null },
    });
    // no automatic retry: a scheduler pass an hour later starts nothing
    m.w.t.clock.setOffset(3_600_000);
    const before = await m.runCommands();
    expect(await dispatchPrReviews(m.ctx())).toBe(0);
    expect(await m.runCommands()).toBe(before);
    m.w.t.clock.setOffset(0);
  });

  it('refuses a reviewed, a running, a closed and an unready PR with no new run', async () => {
    const reviewed = await m.addPr({ state: 'reviewed' });
    const running = await m.addPr();
    await m.addRun(running, { state: 'running', agoMin: 1 });
    const closed = await m.addPr({ closed: true });
    expect(
      (await m.trigger(reviewed)).body.error?.code ?? JSON.stringify((await m.trigger(reviewed)).body),
    ).toMatch(/not_reviewable/);
    expect(JSON.stringify((await m.trigger(running)).body)).toMatch(/review_running/);
    expect(JSON.stringify((await m.trigger(closed)).body)).toMatch(/pr_closed/);
    const idle = await m.addPr();
    await m.db().query('UPDATE workstations SET connected=false WHERE id=$1', [m.w.workstationId]);
    const res = await m.trigger(idle);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/reviewer_not_ready/);
    expect(await m.runs(reviewed)).toHaveLength(0);
    expect(await m.runs(running)).toHaveLength(1);
    expect(await m.runs(closed)).toHaveLength(0);
    expect(await m.runs(idle)).toHaveLength(0);
  });

  it('two triggers at once start one run and refuse the other', async () => {
    const pr = await m.addPr();
    await m.addRun(pr, { state: 'failed', code: 'error' });
    const [a, b] = await Promise.all([m.trigger(pr), m.trigger(pr)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await m.runs(pr)).filter((x) => x.state === 'running')).toHaveLength(1);
  });
});
