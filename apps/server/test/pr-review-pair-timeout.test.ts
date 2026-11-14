import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchPrReviews, RUN_GRACE_MS, sweepStalePrReviewRuns } from '../src/commands/pr-review-runs.ts';
import { closeAdminPool } from './helpers/db.ts';
import {
  completedResult,
  createPairWorld,
  finding,
  type PairWorld,
  seedRecordedReplay,
} from './helpers/pr-review-pair.ts';
import { ok } from './helpers/world.ts';

/**
 * GWP-204 AC4: when either run of a pair times out or fails, no comment from either run is posted, the pull request is
 * "not reviewed" and nothing starts it again by itself. Needs the test database (127.0.0.1:5433). Fake workstation.
 */

let p: PairWorld;
const commandsOf = async (type: string) =>
  (
    await p
      .db()
      .query('SELECT id, payload, status FROM runner_commands WHERE type=$1 ORDER BY created_at', [type])
  ).rows;
const answer = async (cmd: any, result: unknown, okFlag = true) => {
  p.r.send('command.result', { commandId: cmd.commandId, ok: okFlag, result });
  await p.r.barrier();
  await p.ctx().notifier.flush();
};
const pr = async (changeId: string) =>
  (await ok<any>(p.owner('GET', `/api/projects/${p.w.projectId}/pull-requests`))).pullRequests.find(
    (x: any) => x.changeId === changeId,
  );
const roundOf = async (changeId: string) =>
  (
    await p.db().query(
      `SELECT rd.* FROM pr_review_rounds rd JOIN pr_reviews x ON x.id = rd.pr_review_id
        WHERE x.change_id=$1 ORDER BY rd.started_at DESC, rd.id LIMIT 1`,
      [changeId],
    )
  ).rows[0];
const runState = async (reviewer: string, roundId: string) =>
  (
    await p
      .db()
      .query('SELECT state, error_code FROM pr_review_runs WHERE round_id=$1 AND reviewer=$2', [
        roundId,
        reviewer,
      ])
  ).rows[0];
const noPostsAndNoPostedFindings = async () => {
  expect(await commandsOf('pr_review.post')).toHaveLength(0);
  expect(
    (await p.db().query('SELECT count(*)::int AS n FROM pr_review_findings WHERE posted')).rows[0].n,
  ).toBe(0);
};
const timeout = { outcome: 'timeout', durationMs: 600_000, phase: 'review' };

async function startPair(expectedPr: number) {
  const from = p.r.received.length;
  expect(await dispatchPrReviews(p.ctx())).toBe(1);
  await p.r.waitFor(
    'command',
    (f: any) => f.command === 'pr_review.run' && f.payload.reviewer === 'second',
    5000,
    from,
  );
  await p.r.barrier();
  const cmds = p.r.received.slice(from).filter((f: any) => f.command === 'pr_review.run') as any[];
  const first = cmds.find((c) => c.payload.reviewer === 'first');
  const second = cmds.find((c) => c.payload.reviewer === 'second');
  expect(first.payload.prNumber).toBe(expectedPr);
  return { first, second, from };
}

beforeAll(async () => {
  p = await createPairWorld(6);
  await seedRecordedReplay(p);
  await ok(p.owner('PUT', `/api/projects/${p.w.projectId}/second-reviewer`, { enabled: true }));
});
afterAll(async () => {
  await p.close();
  await closeAdminPool();
});

describe('AC4: either run timing out or failing ends the round with nothing posted', () => {
  it('Sonnet completes, then Opus times out: nothing is posted, the round is timed out, the PR stays not reviewed', async () => {
    const { first, second } = await startPair(1);
    await answer(first, completedResult([finding()], { changedLines: 50 }));
    expect(await commandsOf('pr_review.post')).toHaveLength(0);
    await answer(second, timeout);
    await noPostsAndNoPostedFindings();
    const round = await roundOf('1');
    expect(round).toMatchObject({ state: 'timed_out', end_code: 'timeout' });
    expect((await pr('1')).state).toBe('not_reviewed');
    const dto = (await pr('1')).lastRun;
    expect(dto).toMatchObject({ state: 'timed_out', code: 'timeout', postedCount: 0, runCount: 2 });
    // nothing was posted, so nothing is blind: the owner sees which run timed out
    expect(dto.runs.find((r: any) => r.state === 'timed_out')).toMatchObject({
      reviewer: 'second',
      model: 'opus',
    });
    // no cancel: the partner was already done
    expect(await commandsOf('pr_review.cancel')).toHaveLength(0);
    // the next pass starts another pull request, never this one again
    expect(await dispatchPrReviews(p.ctx())).toBe(1);
    expect(
      (
        await p
          .db()
          .query(
            `SELECT count(*)::int AS n FROM pr_review_rounds rd JOIN pr_reviews x ON x.id = rd.pr_review_id WHERE x.change_id='1'`,
          )
      ).rows[0].n,
    ).toBe(1);
    // clean up: end round of PR 2 so the next test starts from a known place
    const r2 = await roundOf('2');
    await p.db().query(`UPDATE pr_review_rounds SET state='failed', end_code='timeout' WHERE id=$1`, [r2.id]);
    await p.db().query(`UPDATE pr_review_runs SET state='timed_out' WHERE round_id=$1`, [r2.id]);
  });

  it('Opus times out first: Sonnet is cancelled, a late Sonnet answer is ignored, nothing is posted', async () => {
    // PR 2 was parked by the previous test: mark it reviewed-by-nothing but not eligible again
    await p.db().query(`UPDATE pr_reviews SET closed_at=now() WHERE change_id='2'`);
    const { first, second, from } = await startPair(3);
    await answer(second, timeout);
    const roundId = (await roundOf('3')).id;
    expect(await roundOf('3')).toMatchObject({ state: 'timed_out' });
    expect(await runState('first', roundId)).toMatchObject({ state: 'cancelled', error_code: 'cancelled' });
    const cancel: any = await p.r.waitFor(
      'command',
      (f: any) => f.command === 'pr_review.cancel',
      5000,
      from,
    );
    expect(cancel.payload).toMatchObject({ runId: first.payload.runId, reason: 'partner_timeout' });
    await answer(cancel, { found: true });
    // the runner's answer for the cancelled run, and even a "completed" one, change nothing
    await answer(first, {
      outcome: 'failed',
      durationMs: 1,
      code: 'cancelled',
      error: 'stopped',
      retryable: false,
    });
    await answer(first, completedResult([finding()]));
    await noPostsAndNoPostedFindings();
    expect(await runState('first', roundId)).toMatchObject({ state: 'cancelled' });
    expect((await pr('3')).state).toBe('not_reviewed');
    expect((await pr('3')).lastRun).toMatchObject({ state: 'timed_out' });
  });

  it('Opus fails: the same, and the failure text is kept', async () => {
    await p.db().query(`UPDATE pr_reviews SET closed_at=now() WHERE change_id='3'`);
    const { first, second, from } = await startPair(4);
    await answer(second, {
      outcome: 'failed',
      durationMs: 5000,
      code: 'model_error',
      error: 'Opus refused',
      retryable: true,
    });
    const roundId = (await roundOf('4')).id;
    expect(await roundOf('4')).toMatchObject({ state: 'failed', end_code: 'model_error' });
    expect(await runState('first', roundId)).toMatchObject({ state: 'cancelled' });
    const cancel: any = await p.r.waitFor(
      'command',
      (f: any) => f.command === 'pr_review.cancel',
      5000,
      from,
    );
    expect(cancel.payload).toMatchObject({ runId: first.payload.runId, reason: 'partner_failed' });
    await noPostsAndNoPostedFindings();
    expect((await pr('4')).lastRun).toMatchObject({
      state: 'failed',
      code: 'model_error',
      error: 'Opus refused',
    });
  });

  it('the backstop: Opus never answers, the sweep times it out and the round posts nothing', async () => {
    await p.db().query(`UPDATE pr_reviews SET closed_at=now() WHERE change_id='4'`);
    const { first } = await startPair(5);
    await answer(first, completedResult([finding()]));
    expect(await commandsOf('pr_review.post')).toHaveLength(0);
    p.ctx().clock.advance(600_000 + RUN_GRACE_MS + 60_000);
    expect(await sweepStalePrReviewRuns(p.ctx())).toBeGreaterThanOrEqual(1);
    const round = await roundOf('5');
    expect(round).toMatchObject({ state: 'timed_out' });
    expect(await runState('second', round.id)).toMatchObject({ state: 'timed_out' });
    await noPostsAndNoPostedFindings();
    expect((await pr('5')).state).toBe('not_reviewed');
  });

  it('different heads: the round fails with heads_differ, nothing is posted, the next pass starts a new round', async () => {
    await p.db().query(`UPDATE pr_reviews SET closed_at=now() WHERE change_id='5'`);
    const { first, second } = await startPair(6);
    await answer(first, completedResult([finding()], { headSha: 'c'.repeat(40) }));
    await answer(second, completedResult([finding({ line: 99 })]));
    expect(await roundOf('6')).toMatchObject({ state: 'failed', end_code: 'heads_differ' });
    await noPostsAndNoPostedFindings();
    // heads_differ is retried by the next pass (at most 3 rounds)
    const again = await startPair(6);
    expect(again.first.payload.runId).not.toBe(first.payload.runId);
    expect(
      (
        await p
          .db()
          .query(
            `SELECT count(*)::int AS n FROM pr_review_rounds rd JOIN pr_reviews x ON x.id = rd.pr_review_id WHERE x.change_id='6'`,
          )
      ).rows[0].n,
    ).toBe(2);
  });
});
