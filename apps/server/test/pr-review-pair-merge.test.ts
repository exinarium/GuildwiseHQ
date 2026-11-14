import {
  PR_LIST_CAPABILITY,
  PR_REVIEW_CAPABILITY,
  PrReviewPostPayloadSchema,
  prReviewMarker,
} from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchPrReviews } from '../src/commands/pr-review-runs.ts';
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
 * GWP-204 AC2 and AC3: with Opus on, a pull request gets two runs; their findings are merged into one set, capped as one
 * set and posted once; a finding both reviewers found is posted once and credited to both. Needs the test database
 * (127.0.0.1:5433). The workstation is a fake that answers every command by hand; no model runs.
 */

let p: PairWorld;
const commandsOf = async (type: string) =>
  (
    await p
      .db()
      .query('SELECT id, payload, status FROM runner_commands WHERE type=$1 ORDER BY created_at', [type])
  ).rows;
const answer = async (cmd: any, result: unknown) => {
  p.r.send('command.result', { commandId: cmd.commandId, ok: true, result });
  await p.r.barrier();
  await p.ctx().notifier.flush();
};
const pr = async (changeId: string) =>
  (await ok<any>(p.owner('GET', `/api/projects/${p.w.projectId}/pull-requests`))).pullRequests.find(
    (x: any) => x.changeId === changeId,
  );

/** Dispatches once and returns the two run commands the fake workstation received, by reviewer. */
async function startPair() {
  const from = p.r.received.length;
  expect(await dispatchPrReviews(p.ctx())).toBe(1);
  await p.r.waitFor('command', (f: any) => f.command === 'pr_review.run', 5000, from);
  await p.r.waitFor(
    'command',
    (f: any) => f.command === 'pr_review.run' && f.payload.reviewer === 'second',
    5000,
    from,
  );
  await p.r.barrier();
  const cmds = p.r.received.slice(from).filter((f: any) => f.command === 'pr_review.run') as any[];
  return {
    first: cmds.find((c) => c.payload.reviewer === 'first'),
    second: cmds.find((c) => c.payload.reviewer === 'second'),
  };
}

const sonnet = [
  finding({ line: 10, title: 'Null check missing on user', severity: 'high' }),
  finding({ line: 20, title: 'Unbounded loop', severity: 'medium' }),
  finding({ line: 30, title: 'Naming', severity: 'low' }),
  finding({ line: 40, title: 'Comment typo', severity: 'low' }),
];
const opus = [
  finding({ line: 12, title: 'Missing null check for user', severity: 'high' }), // the same issue, 2 lines apart
  finding({ line: 50, title: 'Race in cache refresh', severity: 'medium' }),
  finding({ line: 60, title: 'Leaked handle', severity: 'low' }),
  finding({ line: 70, title: 'Dead branch', severity: 'low' }),
];

beforeAll(async () => {
  p = await createPairWorld(3);
  await seedRecordedReplay(p);
  await ok(p.owner('PUT', `/api/projects/${p.w.projectId}/second-reviewer`, { enabled: true }));
});
afterAll(async () => {
  await p.close();
  await closeAdminPool();
});

describe('AC2: both runs happen and one merged set is posted within the cap', () => {
  let postedIds: string[] = [];
  let roundId = '';

  it('one dispatch pass sends exactly two runs (Sonnet and Opus) of one round to the same workstation', async () => {
    const { first, second } = await startPair();
    expect(first.payload).toMatchObject({ reviewer: 'first', model: 'sonnet', prNumber: 1 });
    expect(second.payload).toMatchObject({
      reviewer: 'second',
      model: 'opus',
      prNumber: 1,
      timeoutMs: 600_000,
    });
    const runs = (await p.db().query('SELECT round_id, workstation_id, reviewer FROM pr_review_runs')).rows;
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map((r) => r.round_id)).size).toBe(1);
    expect(new Set(runs.map((r) => r.workstation_id)).size).toBe(1);
    roundId = runs[0].round_id;
    expect(
      (await p.db().query('SELECT reviewers, state FROM pr_review_rounds WHERE id=$1', [roundId])).rows[0],
    ).toEqual({
      reviewers: ['first', 'second'],
      state: 'running',
    });
    // a second pass does not start the pull request again
    expect(await dispatchPrReviews(p.ctx())).toBe(0);
    expect(await commandsOf('pr_review.run')).toHaveLength(2);
    (p as any).cmds = { first, second };
  });

  it('the first run completing posts nothing; the second one posts one review of the merged findings', async () => {
    const { first, second } = (p as any).cmds;
    await answer(first, completedResult(sonnet, { changedLines: 250 }));
    expect(await commandsOf('pr_review.post')).toHaveLength(0);
    expect(
      (await p.db().query('SELECT state FROM pr_review_rounds WHERE id=$1', [roundId])).rows[0].state,
    ).toBe('running');

    const from = p.r.received.length;
    await answer(second, completedResult(opus, { changedLines: 250 }));
    const post: any = await p.r.waitFor('command', (f: any) => f.command === 'pr_review.post', 5000, from);
    await p.r.barrier();
    expect(await commandsOf('pr_review.post')).toHaveLength(1);

    const body = PrReviewPostPayloadSchema.parse(post.payload);
    expect(body.runId).toBe(roundId);
    expect(body.summary).toContain(prReviewMarker(roundId));
    expect(body.summary).toContain('Automated review: 3 findings posted.');
    expect(body.summary).not.toContain('Model written summary');
    // 7 distinct findings, cap 3 for 250 changed lines: the high one found by both, then the two mediums
    expect(body.findings).toHaveLength(3);
    expect(body.findings.map((f) => f.finding.title)).toEqual([
      '[high] Null check missing on user',
      '[medium] Unbounded loop',
      '[medium] Race in cache refresh',
    ]);
    expect(JSON.stringify(body).toLowerCase()).not.toMatch(/sonnet|opus|claude/);
    postedIds = body.findings.map((f) => f.findingId);
    (p as any).post = post;

    const round = (await p.db().query('SELECT * FROM pr_review_rounds WHERE id=$1', [roundId])).rows[0];
    expect(round).toMatchObject({
      state: 'posting',
      findings_cap: 3,
      held_back_count: 4,
      merged_count: 1,
      changed_lines: 250,
    });
    expect((await pr('1')).state).toBe('not_reviewed');
  });

  it('after the post answers: reviewed, both runs posted, only posted findings flagged', async () => {
    await answer((p as any).post, {
      ok: true,
      reviewUrl: 'https://github.com/acme/toy/pull/1#review-1',
      alreadyPosted: false,
    });
    expect(
      (await p.db().query('SELECT state FROM pr_review_rounds WHERE id=$1', [roundId])).rows[0].state,
    ).toBe('posted');
    expect((await p.db().query('SELECT state FROM pr_review_runs')).rows.map((r) => r.state)).toEqual([
      'posted',
      'posted',
    ]);
    const row = (
      await p
        .db()
        .query('SELECT review_state, reviewed_by, reviewed_by_all FROM pr_reviews WHERE change_id=$1', ['1'])
    ).rows[0];
    expect(row).toEqual({
      review_state: 'reviewed',
      reviewed_by: 'first',
      reviewed_by_all: ['first', 'second'],
    });
    const flagged = (await p.db().query('SELECT id FROM pr_review_findings WHERE posted')).rows.map(
      (r) => r.id,
    );
    expect(flagged.sort()).toEqual([...postedIds].sort());
  });

  it('the pair counts as one automatic review and the pull request shows the round', async () => {
    const q = await ok<any>(p.owner('GET', `/api/projects/${p.w.projectId}/pull-requests/queue`));
    expect(q.used).toBe(1);
    const dto = await pr('1');
    expect(dto.lastRun).toMatchObject({
      state: 'posted',
      runCount: 2,
      postedCount: 3,
      heldBackCount: 4,
      findingsCap: 3,
    });
    // blind: neither the reviewers nor the number of duplicates is shown while findings are unmarked
    expect(dto).toMatchObject({ reviewer: null, reviewers: null, reviewersHidden: true });
    expect(dto.lastRun.mergedCount).toBeNull();
    expect(dto.lastRun.runs.every((r: any) => r.reviewer === null && r.model === null)).toBe(true);
  });
});

describe('AC3: a finding both reviewers found is posted once and credited to both', () => {
  it('the view credits the canonical finding to both reviewers; the duplicate row is merged and never posted', async () => {
    const rows = (
      await p.db().query(
        `SELECT f.id, f.disposition, f.merged_into, f.posted, run.reviewer FROM pr_review_findings f
           JOIN pr_review_runs run ON run.id = f.run_id WHERE f.title LIKE '%null check%' OR f.title LIKE '%Null check%'`,
      )
    ).rows;
    const canonical = rows.find((r) => r.disposition === 'posted');
    const duplicate = rows.find((r) => r.disposition === 'merged');
    expect(rows).toHaveLength(2);
    expect(duplicate).toMatchObject({ merged_into: canonical.id, posted: false });
    const credited = (
      await p
        .db()
        .query(
          'SELECT reviewer, model FROM pr_review_finding_attribution WHERE finding_id=$1 ORDER BY reviewer',
          [canonical.id],
        )
    ).rows;
    expect(credited).toEqual([
      { reviewer: 'first', model: 'sonnet' },
      { reviewer: 'second', model: 'opus' },
    ]);
    expect(
      (
        await p
          .db()
          .query('SELECT count(*)::int AS n FROM pr_review_finding_attribution WHERE finding_id=$1', [
            duplicate.id,
          ])
      ).rows[0].n,
    ).toBe(0);
  });

  it('the finding list is blind until marked; marking the shared finding counts for both reviewers, once', async () => {
    const list = (await ok<any>(p.owner('GET', `/api/pr-reviews/${(await pr('1')).id}/findings`))).findings;
    expect(list).toHaveLength(3);
    expect(list.every((f: any) => f.reviewers === null)).toBe(true);
    const shared = list.find((f: any) => f.title === 'Null check missing on user');
    const marked = await ok<any>(
      p.owner('PUT', `/api/pr-review-findings/${shared.id}/mark`, { mark: 'useful' }),
    );
    expect(marked.reviewers.map((r: any) => r.key).sort()).toEqual(['first', 'second']);
    const prec = await ok<any>(p.owner('GET', `/api/projects/${p.w.projectId}/reviewer-precision`));
    const of = (who: string) => prec.reviewers.find((r: any) => r.reviewer === who);
    expect(of('first')).toMatchObject({ posted: 2, useful: 1 });
    expect(of('second')).toMatchObject({ posted: 2, useful: 1 });
    // the second pair of findings are not counted for the other reviewer: 3 posted findings, 1 shared
    expect(of('first').posted + of('second').posted).toBe(4);
  });

  it('held-back findings of the round are listed once, without the merged duplicate', async () => {
    const held = await ok<any>(p.owner('GET', `/api/pr-reviews/${(await pr('1')).id}/held-back`));
    expect(held.findings).toHaveLength(4);
  });
});

describe('a workstation that cannot cancel a run gets no pair', () => {
  it('without pr-review-pair:1 the pull request is blocked runner_outdated and no run starts', async () => {
    const before = (await commandsOf('pr_review.run')).length;
    await p
      .db()
      .query(
        `UPDATE workstation_capabilities SET capabilities = ARRAY[$1,$2]::text[] WHERE workstation_id=$3`,
        [PR_LIST_CAPABILITY, PR_REVIEW_CAPABILITY, p.w.workstationId],
      );
    expect(await dispatchPrReviews(p.ctx())).toBe(0);
    expect(await commandsOf('pr_review.run')).toHaveLength(before);
    const q = await ok<any>(p.owner('GET', `/api/projects/${p.w.projectId}/pull-requests/queue`));
    expect(q.items[0]).toMatchObject({ slot: 'blocked', blockedReason: 'runner_outdated' });
  });
});
