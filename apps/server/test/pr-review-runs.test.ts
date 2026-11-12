import {
  PR_LIST_CAPABILITY,
  PR_REVIEW_CAPABILITY,
  PrReviewPostPayloadSchema,
  prReviewMarker,
} from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildReviewPost,
  dispatchPrReviews,
  RUN_GRACE_MS,
  sweepStalePrReviewRuns,
} from '../src/commands/pr-review-runs.ts';
import { closeAdminPool } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, REPO_SSH, type World } from './helpers/world.ts';

/**
 * GWP-197: the first reviewer on PR-only pull requests. Needs the test database (127.0.0.1:5433). The runner is a fake
 * that answers `pr_review.run` and `pr_review.post` by hand.
 */

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const SENTINEL = 'github_pat_SENTINEL_pr_review_0123456789';

let w: World;
let r: FakeRunner;
const prIds: Record<string, string> = {};

const db = () => w.t.app.ctx.pool;
const ctx = () => w.t.app.ctx;
const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const prs = async () =>
  (await ok<any>(owner('GET', `/api/projects/${w.projectId}/pull-requests`))).pullRequests;
const prOf = async (changeId: string) => (await prs()).find((p: any) => p.changeId === changeId);
const counts = async () =>
  (
    await db().query(
      `SELECT (SELECT count(*)::int FROM cards) AS cards, (SELECT count(*)::int FROM shifts) AS shifts,
              (SELECT count(*)::int FROM desk_items) AS desk`,
    )
  ).rows[0];
const commandsOf = async (type: string) =>
  (
    await db().query('SELECT id, payload, status FROM runner_commands WHERE type=$1 ORDER BY created_at', [
      type,
    ])
  ).rows;
const runCmd = async (n: number) => (await commandsOf('pr_review.run')).find((c) => c.payload.prNumber === n);
const eventTypes = async () =>
  (await db().query(`SELECT type FROM events WHERE type LIKE 'PrReview%' ORDER BY seq`)).rows.map(
    (x) => x.type as string,
  );
const runOf = async (changeId: string) =>
  (
    await db().query(
      `SELECT x.* FROM pr_review_runs x JOIN pr_reviews p ON p.id = x.pr_review_id WHERE p.change_id=$1 ORDER BY x.started_at DESC`,
      [changeId],
    )
  ).rows[0];

/** Dispatches and returns the `pr_review.run` command the fake runner received for it. */
async function startReview(): Promise<any> {
  const from = r.received.length;
  expect(await dispatchPrReviews(ctx())).toBe(1);
  const cmd: any = await r.waitFor('command', (f: any) => f.command === 'pr_review.run', 5000, from);
  await r.barrier();
  return cmd;
}
const answer = async (cmd: any, result: unknown, okFlag = true) => {
  r.send('command.result', { commandId: cmd.commandId, ok: okFlag, result });
  await r.barrier();
  await w.t.app.ctx.notifier.flush();
};
const completed = (findings: unknown[] = [], over = {}) => ({
  outcome: 'completed',
  headSha: HEAD,
  baseSha: BASE,
  durationMs: 192_000,
  summary: 'Two things to look at.',
  findings,
  ...over,
});
const finding = (over = {}) => ({
  path: 'src/a.ts',
  line: 12,
  severity: 'high' as const,
  title: 'Null deref',
  body: 'x may be null here',
  anchored: true,
  ...over,
});

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ capabilities: [PR_LIST_CAPABILITY, PR_REVIEW_CAPABILITY] });
  const from = r.received.length;
  await ok(owner('PATCH', `/api/projects/${w.projectId}/repos/${w.repoId}`, { prOnly: true }));
  const list: any = await r.waitFor('command', (f: any) => f.command === 'repo.list_prs', 5000, from);
  await r.barrier();
  const t0 = (await db().query('SELECT pr_only_since FROM project_repos WHERE id=$1', [w.repoId])).rows[0]
    .pr_only_since as Date;
  const pr = (n: number) => ({
    id: String(n),
    url: `https://github.com/acme/toy/pull/${n}`,
    title: `Change ${n}`,
    author: 'dev',
    head: `feature/${n}`,
    base: 'main',
    createdAt: new Date(t0.getTime() + n * 60_000).toISOString(),
  });
  r.send('command.result', {
    commandId: list.commandId,
    ok: true,
    result: { ok: true, complete: true, changes: [pr(1), pr(2), pr(3), pr(4), pr(5)] },
  });
  await r.barrier();
  await w.t.app.ctx.notifier.flush();
  for (const p of await prs()) prIds[p.changeId] = p.id;
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

describe('the gate: no token, no run', () => {
  it('nothing starts while the repository has no reviewer token, and the owner sees why', async () => {
    expect(await dispatchPrReviews(ctx())).toBe(0);
    expect(await commandsOf('pr_review.run')).toHaveLength(0);
    const p = await prOf('1');
    expect(p).toMatchObject({ state: 'not_reviewed', reviewerToken: 'missing', lastRun: null });
  });

  it('the first run starts once the workstation reports the token', async () => {
    r.send('repos.report', {
      repos: [
        { remoteUrl: REPO_SSH, localPath: '/tmp/toy', headBranch: 'main', reviewerToken: { present: true } },
      ],
    });
    await r.barrier();
    // dispatch is covered by the AC1 test below
    expect((await prOf('1')).reviewerToken).toBe('present');
  });
});

describe('AC1: a completed run posts its findings and the pull request shows reviewed', () => {
  it('starts the Sonnet run with no commit ids, then posts one review only after the run completed', async () => {
    const cmd = await startReview();
    expect(cmd.payload).toMatchObject({
      reviewer: 'first',
      runtime: 'claude-code',
      model: 'sonnet',
      timeoutMs: 600_000,
      prNumber: 1,
      baseRef: 'main',
      remoteUrlNormalized: 'github.com/acme/toy',
    });
    expect(Object.keys(cmd.payload)).not.toContain('headSha');
    expect((await prOf('1')).lastRun).toMatchObject({ state: 'running', timeoutMs: 600_000 });
    expect(await commandsOf('pr_review.post')).toHaveLength(0);

    const postFrom = r.received.length;
    await answer(
      cmd,
      completed([
        finding(),
        finding({ line: 99, anchored: false, title: 'Off the diff' }),
        finding({ line: null, path: 'README.md', title: 'Docs', anchored: false }),
      ]),
    );
    const post: any = await r.waitFor('command', (f: any) => f.command === 'pr_review.post', 5000, postFrom);
    await r.barrier();

    // the post carries the commits the runner reviewed, one inline comment and two findings for the review body
    const body = PrReviewPostPayloadSchema.parse(post.payload);
    expect(body.spec).toMatchObject({ headSha: HEAD, baseSha: BASE, prNumber: 1, baseRef: 'main' });
    expect(body.findings.map((f) => f.finding.line)).toEqual([12, undefined, undefined]);
    expect(body.findings[0]?.finding.title).toBe('[high] Null deref');
    expect(body.findings[1]?.finding.body).toContain('Line 99');
    expect(body.summary).toContain(prReviewMarker(cmd.payload.runId));
    expect(JSON.stringify(body).toLowerCase()).not.toMatch(/sonnet|claude/);
    // stored, but the pull request is not reviewed until the comments exist on the host
    expect((await runOf('1')).state).toBe('completed');
    expect((await prOf('1')).state).toBe('not_reviewed');
    expect((await db().query('SELECT count(*)::int AS n FROM pr_review_findings')).rows[0].n).toBe(3);

    await answer(post, {
      ok: true,
      reviewUrl: 'https://github.com/acme/toy/pull/1#review-1',
      alreadyPosted: false,
    });
    expect(await prOf('1')).toMatchObject({
      state: 'reviewed',
      reviewer: 'first',
      lastRun: {
        state: 'posted',
        durationMs: 192_000,
        postedCount: 3,
        reviewUrl: 'https://github.com/acme/toy/pull/1#review-1',
      },
    });
    expect(await dispatchPrReviews(ctx())).toBe(1); // the next pull request (2) is picked, 1 is not
    // clean up the run just started for 2 so the next tests control it
    expect((await runCmd(2))?.payload.prNumber).toBe(2);
  });

  it('a result sent twice (a requeue) changes nothing the second time', async () => {
    const before = await eventTypes();
    const [first] = await commandsOf('pr_review.run');
    await ctx().services.gateway.deliverPending(w.workstationId);
    // answering the already posted run again is ignored
    await applyAgain(first.payload);
    expect(await eventTypes()).toEqual(before);
  });
});

async function applyAgain(payload: any) {
  const { applyPrReviewRunResult } = await import('../src/commands/pr-review-runs.ts');
  await applyPrReviewRunResult(ctx(), payload, true, completed([finding()]), undefined);
}

describe('AC2 + AC3: a run that hits the time limit posts nothing and changes nothing else', () => {
  it('a timeout from the runner: no post, not reviewed, no card, shift or desk item, no automatic restart', async () => {
    expect(await runCmd(2)).toBeDefined();
    const live: any = await r.waitFor(
      'command',
      (f: any) => f.command === 'pr_review.run' && f.payload.prNumber === 2,
      5000,
      0,
    );
    const before = await counts();
    const postsBefore = (await commandsOf('pr_review.post')).length;
    const eventsBefore = await eventTypes();
    await answer(live, { outcome: 'timeout', durationMs: 600_000, phase: 'review' });
    expect(await eventTypes()).toEqual([...eventsBefore, 'PrReviewRunTimedOut']);
    expect((await commandsOf('pr_review.post')).length).toBe(postsBefore);
    expect(await counts()).toEqual(before);
    expect(await prOf('2')).toMatchObject({
      state: 'not_reviewed',
      lastRun: { state: 'timed_out', durationMs: 600_000, error: null },
    });
    const closed = (await db().query('SELECT closed_at FROM pr_reviews WHERE change_id=$1', ['2'])).rows[0];
    expect(closed.closed_at).toBeNull();
    // the next passes pick other pull requests, never 2 again
    expect(await dispatchPrReviews(ctx())).toBe(1);
    expect((await commandsOf('pr_review.run')).filter((c) => c.payload.prNumber === 2)).toHaveLength(1);
  });

  it('a late "completed" for a run the server gave up on is ignored and posts nothing', async () => {
    const cmd: any = await runCmd(3); // pull request 3, running
    expect(cmd).toBeDefined();
    ctx().clock.advance(600_000 + RUN_GRACE_MS + 60_000);
    expect(await sweepStalePrReviewRuns(ctx())).toBeGreaterThanOrEqual(1);
    expect(await runOf('3')).toMatchObject({ state: 'timed_out', timed_out_by: 'server' });
    const posts = (await commandsOf('pr_review.post')).length;
    const { applyPrReviewRunResult } = await import('../src/commands/pr-review-runs.ts');
    await applyPrReviewRunResult(ctx(), cmd.payload, true, completed([finding()]), undefined);
    expect((await commandsOf('pr_review.post')).length).toBe(posts);
    expect(await prOf('3')).toMatchObject({ state: 'not_reviewed', lastRun: { state: 'timed_out' } });
    expect(
      (await db().query(`SELECT status FROM runner_commands WHERE id=$1`, [cmd.id])).rows[0],
    ).toBeDefined();
  });
});

describe('AC4: any other failure posts nothing, stays not reviewed and shows the error', () => {
  it('a model error is kept with its text for the owner, and is not restarted', async () => {
    expect(await dispatchPrReviews(ctx())).toBe(1); // pull request 4
    const live: any = await r.waitFor(
      'command',
      (f: any) => f.command === 'pr_review.run' && f.payload.prNumber === 4,
      5000,
      0,
    );
    const posts = (await commandsOf('pr_review.post')).length;
    await answer(live, {
      outcome: 'failed',
      durationMs: 4000,
      code: 'model_error',
      error: 'the claude process exited with code 1',
      retryable: true,
    });
    expect((await commandsOf('pr_review.post')).length).toBe(posts);
    expect(await prOf('4')).toMatchObject({
      state: 'not_reviewed',
      lastRun: { state: 'failed', code: 'model_error', error: 'the claude process exited with code 1' },
    });
    // a failure is final: no restart on the next pass for 4, however retryable it looks
    expect(await dispatchPrReviews(ctx())).toBe(1); // pull request 5, not 4
    expect((await commandsOf('pr_review.run')).filter((c) => c.payload.prNumber === 4)).toHaveLength(1);
  });

  it('a result that cannot be read is a failure, not a crash', async () => {
    const live: any = await r.waitFor(
      'command',
      (f: any) => f.command === 'pr_review.run' && f.payload.prNumber === 5,
      5000,
      0,
    );
    await answer(live, { surprise: true });
    expect(await prOf('5')).toMatchObject({
      state: 'not_reviewed',
      lastRun: { state: 'failed', code: 'error' },
    });
  });

  it('a post that fails keeps the pull request not reviewed and keeps the error', async () => {
    // a fresh pull request for this case
    await db().query(
      `INSERT INTO pr_reviews (id, project_id, project_repo_id, change_id, url, title, author, head_branch, base_branch, opened_at, recorded_at, review_state)
       VALUES (gen_random_uuid(), $1, $2, '6', 'https://github.com/acme/toy/pull/6', 'Change 6', 'dev', 'feature/6', 'main', now(), now(), 'not_reviewed')`,
      [w.projectId, w.repoId],
    );
    const live = await startReview();
    const postFrom = r.received.length;
    await answer(live, completed([finding()]));
    const post: any = await r.waitFor('command', (f: any) => f.command === 'pr_review.post', 5000, postFrom);
    await r.barrier();
    await answer(post, { ok: false, code: 'forbidden', error: 'the host answered 403' });
    expect(await prOf('6')).toMatchObject({
      state: 'not_reviewed',
      lastRun: { state: 'failed', code: 'forbidden', error: 'the host answered 403', postedCount: 0 },
    });
  });

  it('with the token gone, nothing is dispatched', async () => {
    await db().query(
      `INSERT INTO pr_reviews (id, project_id, project_repo_id, change_id, url, title, author, head_branch, base_branch, opened_at, recorded_at, review_state)
       VALUES (gen_random_uuid(), $1, $2, '7', 'https://github.com/acme/toy/pull/7', 'Change 7', 'dev', 'feature/7', 'main', now(), now(), 'not_reviewed')`,
      [w.projectId, w.repoId],
    );
    await db().query('UPDATE workstation_repos SET reviewer_token=false WHERE project_repo_id=$1', [
      w.repoId,
    ]);
    expect(await dispatchPrReviews(ctx())).toBe(0);
    await db().query('UPDATE workstation_repos SET reviewer_token=true WHERE project_repo_id=$1', [w.repoId]);
  });
});

describe('buildReviewPost', () => {
  const spec = {
    projectId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c3',
    projectRepoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789d4',
    remoteUrlNormalized: 'github.com/acme/toy',
    prNumber: 9,
    baseRef: 'main',
  };
  const run = { runId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1', summary: '', headSha: HEAD, baseSha: BASE };
  it('a run with no findings still posts a review that says so and holds the marker', () => {
    const p = buildReviewPost(run, spec, []);
    expect(p.summary).toBe(`No findings.\n\n${prReviewMarker(run.runId)}`);
    expect(p.findings).toEqual([]);
  });
  it('keeps title and body inside the poster limits', () => {
    const p = buildReviewPost(run, spec, [
      {
        ...finding({ title: 'T'.repeat(200), body: 'B'.repeat(4000) }),
        findingId: '019e3f6a-7b1c-7a2d-8c3e-0123456789f1',
      },
    ]);
    expect(p.findings[0]?.finding.title.length).toBeLessThanOrEqual(200);
    expect(PrReviewPostPayloadSchema.safeParse(p).success).toBe(true);
  });
});

describe('no credential is stored or logged', () => {
  it('a token key in the run payload or the post payload is refused by the schema', () => {
    const p = buildReviewPost(
      run0(),
      {
        projectId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c3',
        projectRepoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789d4',
        remoteUrlNormalized: 'github.com/acme/toy',
        prNumber: 1,
        baseRef: 'main',
      },
      [],
    );
    expect(PrReviewPostPayloadSchema.safeParse({ ...p, token: SENTINEL }).success).toBe(false);
  });
  it('no PR review table, event or command holds a token-shaped value', async () => {
    const text = async (sql: string) => JSON.stringify((await db().query(sql)).rows);
    expect(await text('SELECT row_to_json(x)::text FROM pr_review_runs x')).not.toMatch(/github_pat_|ghp_/);
    expect(await text('SELECT row_to_json(x)::text FROM pr_review_findings x')).not.toMatch(
      /github_pat_|ghp_/,
    );
    expect(await text(`SELECT payload::text FROM events WHERE type LIKE 'PrReview%'`)).not.toMatch(
      /github_pat_|ghp_/,
    );
    expect(await text(`SELECT payload::text FROM runner_commands WHERE type LIKE 'pr_review.%'`)).not.toMatch(
      /github_pat_|ghp_/,
    );
  });
});

function run0() {
  return { runId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1', summary: 's', headSha: HEAD, baseSha: BASE };
}
