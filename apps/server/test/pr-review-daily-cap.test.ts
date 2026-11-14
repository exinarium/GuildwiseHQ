import { randomUUID } from 'node:crypto';
import { PR_LIST_CAPABILITY, PR_REVIEW_CAPABILITY } from '@aom/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prReviewQueue } from '../src/commands/pr-review-cap.ts';
import { dispatchPrReviews } from '../src/commands/pr-review-runs.ts';
import { closeAdminPool } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, REPO_SSH, type World } from './helpers/world.ts';

/**
 * GWP-200: the daily cap on automatic PR reviews. Needs the test database (127.0.0.1:5433). Time is the test clock, set to
 * a fixed instant in Africa/Johannesburg (UTC+2) so the day boundary is not the UTC one. Pull requests and used runs are
 * seeded straight into the read model; the dispatcher and the routes are the real ones.
 */

const TZ = 'Africa/Johannesburg';
/** The instant `d` (local `YYYY-MM-DD`) at local `hh:mm` in Johannesburg. */
const local = (d: string, hhmm: string) => new Date(`${d}T${hhmm}:00+02:00`);
/** Near the real now (sessions expire against the test clock), so the days are computed from it. */
const D = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const dayShift = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

let w: World;
let r: FakeRunner;
const db = () => w.t.app.ctx.pool;
const ctx = () => w.t.app.ctx;
const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const at = (d: Date) => w.t.clock.setOffset(d.getTime() - Date.now());

let seq = 0;
async function addPr(
  n: number,
  over: { openedAt?: Date; lines?: number | null; state?: string; id?: string } = {},
): Promise<string> {
  const id = over.id ?? randomUUID();
  await db().query(
    `INSERT INTO pr_reviews (id, project_id, project_repo_id, change_id, url, title, author, head_branch, base_branch,
                             opened_at, recorded_at, review_state, changed_lines)
     VALUES ($1,$2,$3,$4,$5,$6,'dev',$7,'main',$8,$8,$9,$10)`,
    [
      id,
      w.projectId,
      w.repoId,
      String(n),
      `https://github.com/acme/toy/pull/${n}`,
      `Change ${n}`,
      `feature/${n}`,
      over.openedAt ?? local(D, '08:00'),
      over.state ?? 'not_reviewed',
      over.lines === undefined ? 100 : over.lines,
    ],
  );
  return id;
}
/** A run already started (and finished) at `startedAt`. */
async function addRun(
  prId: string,
  over: { startedAt: Date; trigger?: 'auto' | 'manual'; state?: string; code?: string },
) {
  await db().query(
    `INSERT INTO pr_review_runs (id, pr_review_id, project_id, reviewer, runtime, model, workstation_id, state, timeout_ms,
                                 started_at, trigger, error_code)
     VALUES ($1,$2,$3,'first','claude-code','sonnet',$4,$5,600000,$6,$7,$8)`,
    [
      randomUUID(),
      prId,
      w.projectId,
      w.workstationId,
      over.state ?? 'posted',
      over.startedAt,
      over.trigger ?? 'auto',
      over.code ?? null,
    ],
  );
}
/** `n` pull requests that were reviewed automatically at `startedAt`. */
async function useUp(n: number, startedAt: Date) {
  for (let i = 0; i < n; i++)
    await addRun(await addPr(1000 + seq++, { state: 'reviewed' }), { startedAt, state: 'posted' });
}
const setCap = (cap: number) => owner('PUT', `/api/projects/${w.projectId}/pr-review-cap`, { cap });
const queue = async () => ok<any>(owner('GET', `/api/projects/${w.projectId}/pull-requests/queue`));
const runsStarted = async () =>
  (
    await db().query(
      `SELECT p.change_id, x.trigger, x.state FROM pr_review_runs x JOIN pr_reviews p ON p.id = x.pr_review_id
        WHERE x.state='running' ORDER BY x.started_at, p.change_id`,
    )
  ).rows;
/** Finishes every running run (as if the post had succeeded) and marks its pull request reviewed. */
async function finishRunning() {
  await db().query(
    `UPDATE pr_reviews SET review_state='reviewed' WHERE id IN (SELECT pr_review_id FROM pr_review_runs WHERE state='running')`,
  );
  await db().query(`UPDATE pr_review_runs SET state='posted' WHERE state='running'`);
}

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ capabilities: [PR_LIST_CAPABILITY, PR_REVIEW_CAPABILITY] });
  await db().query(
    `UPDATE project_repos SET pr_only=true, pr_only_since='2030-01-01T00:00:00Z' WHERE id=$1`,
    [w.repoId],
  );
  r.send('repos.report', {
    repos: [
      { remoteUrl: REPO_SSH, localPath: '/tmp/toy', headBranch: 'main', reviewerToken: { present: true } },
    ],
  });
  await r.barrier();
  await db().query(
    `UPDATE users SET timezone=$2 WHERE id = COALESCE((SELECT owner_user_id FROM organizations WHERE id=$1), $1)`,
    [(await db().query('SELECT org_id FROM projects WHERE id=$1', [w.projectId])).rows[0].org_id, TZ],
  );
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});
beforeEach(async () => {
  await db().query('DELETE FROM pr_review_runs');
  await db().query('DELETE FROM pr_reviews');
  await db().query(`DELETE FROM runner_commands WHERE type LIKE 'pr_review.%'`);
  await db().query('UPDATE projects SET pr_review_daily_cap=20 WHERE id=$1', [w.projectId]);
  await db().query(`UPDATE workstations SET connected=true WHERE id=$1`, [w.workstationId]);
  at(local(D, '09:00'));
});

describe('AC1: the 21st pull request of a day is not reviewed and waits in the queue', () => {
  it('with 19 used, one more starts; the rest stay not reviewed in the queue and nothing more starts today', async () => {
    await useUp(19, local(D, '07:00'));
    await addPr(1, { openedAt: local(D, '08:00') });
    await addPr(2, { openedAt: local(D, '08:30') });
    await addPr(3, { openedAt: local(D, '08:45') });
    expect(await dispatchPrReviews(ctx())).toBe(1);
    expect((await runsStarted()).map((x) => x.change_id)).toEqual(['1']);
    await finishRunning();
    expect(await dispatchPrReviews(ctx())).toBe(0);
    expect(await dispatchPrReviews(ctx())).toBe(0);

    const q = await queue();
    expect(q).toMatchObject({ used: 20, cap: 20, timeZone: TZ });
    expect(q.items.map((i: any) => [i.changeId, i.slot])).toEqual([
      ['2', 'later'],
      ['3', 'later'],
    ]);
    const list = (await ok<any>(owner('GET', `/api/projects/${w.projectId}/pull-requests`))).pullRequests;
    const p2 = list.find((p: any) => p.changeId === '2');
    expect(p2).toMatchObject({ state: 'not_reviewed', queueSlot: 'later', queuePosition: 1 });
  });

  it('fewer pull requests than the cap all start as before (one per repository at a time)', async () => {
    await addPr(1);
    await addPr(2);
    expect(await dispatchPrReviews(ctx())).toBe(1);
    await finishRunning();
    expect(await dispatchPrReviews(ctx())).toBe(1);
  });

  it('counts distinct pull requests: a second run of the same one and a timed-out run use one slot each', async () => {
    const a = await addPr(1, { state: 'reviewed' });
    await addRun(a, { startedAt: local(D, '07:00'), code: 'no_token', state: 'failed' });
    await addRun(a, { startedAt: local(D, '07:10') });
    const b = await addPr(2);
    await addRun(b, { startedAt: local(D, '07:20'), state: 'timed_out' });
    expect((await queue()).used).toBe(2);
    // a manual run is shown, never counted
    await addRun(await addPr(3, { state: 'reviewed' }), { startedAt: local(D, '07:30'), trigger: 'manual' });
    expect(await queue()).toMatchObject({ used: 2, manualToday: 1 });
  });

  it('a pull request on a repository without a capable workstation is blocked and holds no slot', async () => {
    await setCap(1);
    await addPr(1, { openedAt: local(D, '08:00') });
    await addPr(2, { openedAt: local(D, '08:10') });
    const saved = (
      await db().query('SELECT capabilities FROM workstation_capabilities WHERE workstation_id=$1', [
        w.workstationId,
      ])
    ).rows[0].capabilities;
    await db().query(`UPDATE workstation_capabilities SET capabilities='{}' WHERE workstation_id=$1`, [
      w.workstationId,
    ]);
    try {
      const q = await queue();
      expect(q.items.map((i: any) => [i.changeId, i.slot, i.blockedReason])).toEqual([
        ['1', 'blocked', 'runner_outdated'],
        ['2', 'blocked', 'runner_outdated'],
      ]);
      expect(await dispatchPrReviews(ctx())).toBe(0);
    } finally {
      await db().query('UPDATE workstation_capabilities SET capabilities=$2 WHERE workstation_id=$1', [
        w.workstationId,
        saved,
      ]);
    }
    expect((await queue()).items.map((i: any) => [i.changeId, i.slot])).toEqual([
      ['1', 'today'],
      ['2', 'later'],
    ]);
  });
});

describe('AC2: a new day drains the queue oldest first, the smaller pull request first on the same day', () => {
  it('orders by the local day opened, then fewer changed lines, and never lets a younger pull request take a slot', async () => {
    await setCap(3);
    await useUp(3, local(D, '07:00')); // today's three are used
    await addPr(1, { openedAt: local(dayShift(D, -2), '08:00'), lines: 300 }); // A: D-2, big
    await addPr(2, { openedAt: local(dayShift(D, -2), '15:00'), lines: 40 }); // B: D-2, small
    await addPr(3, { openedAt: local(dayShift(D, -1), '12:00'), lines: 10 }); // C: D-1
    await addPr(4, { openedAt: local(D, '08:00'), lines: 1 }); // E: today
    expect(await dispatchPrReviews(ctx())).toBe(0); // used up today

    // 00:01 local on D+1 is still D in UTC (22:01Z): the day changed in the organization's zone
    at(local(dayShift(D, 1), '00:01'));
    expect(w.t.clock.now().toISOString().slice(0, 10)).toBe(D);
    const q = await queue();
    expect(q).toMatchObject({ used: 0, cap: 3 });
    expect(q.items.map((i: any) => [i.changeId, i.slot])).toEqual([
      ['2', 'today'],
      ['1', 'today'],
      ['3', 'today'],
      ['4', 'later'],
    ]);

    expect(await dispatchPrReviews(ctx())).toBe(1); // one per repository at a time: the head of the queue
    expect((await runsStarted()).map((x) => x.change_id)).toEqual(['2']);
    // the head runs; the next two cannot start yet, and the younger one outside the window must not take their slot
    expect(await dispatchPrReviews(ctx())).toBe(0);
    expect((await runsStarted()).map((x) => x.change_id)).toEqual(['2']);
    await finishRunning();
    expect(await dispatchPrReviews(ctx())).toBe(1);
    await finishRunning();
    expect(await dispatchPrReviews(ctx())).toBe(1);
    await finishRunning();
    expect(await dispatchPrReviews(ctx())).toBe(0); // the cap of 3 is used: pull request 4 waits
    const order = (
      await db().query(
        `SELECT p.change_id FROM pr_review_runs x JOIN pr_reviews p ON p.id = x.pr_review_id
          WHERE x.started_at >= $1 ORDER BY x.started_at, p.change_id`,
        [local(dayShift(D, 1), '00:00')],
      )
    ).rows.map((x) => x.change_id);
    expect(order).toEqual(['2', '1', '3']);
    expect((await queue()).items.map((i: any) => [i.changeId, i.slot])).toEqual([['4', 'later']]);
  });

  it('the read model and the dispatcher use the same order (AC4)', async () => {
    await addPr(1, { openedAt: local(D, '08:00'), lines: 50 });
    await addPr(2, { openedAt: local(D, '08:30'), lines: 5 });
    const q = await prReviewQueue(db(), ctx(), w.projectId);
    expect(q.items.map((i) => i.changeId)).toEqual(['2', '1']);
    expect(q.items.map((i) => i.position)).toEqual([1, 2]);
    expect(await dispatchPrReviews(ctx())).toBe(1);
    expect((await runsStarted()).map((x) => x.change_id)).toEqual(['2']);
  });
});

describe('AC3: the owner triggers a review by hand when the cap is used up', () => {
  const trigger = (prId: string, cookie = w.owner.cookie) =>
    w.t.req('POST', `/api/projects/${w.projectId}/pull-requests/${prId}/review`, { cookie });

  it('runs past the cap, is marked manual and is not counted', async () => {
    await setCap(1);
    await useUp(1, local(D, '07:00'));
    const p = await addPr(1);
    expect(await dispatchPrReviews(ctx())).toBe(0);
    const res = await trigger(p);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: p, lastRun: { state: 'running', trigger: 'manual' } });
    const run = (
      await db().query(`SELECT trigger, requested_by FROM pr_review_runs WHERE pr_review_id=$1`, [p])
    ).rows[0];
    expect(run).toMatchObject({ trigger: 'manual', requested_by: w.owner.id });
    expect(
      (await db().query(`SELECT count(*)::int AS n FROM runner_commands WHERE type='pr_review.run'`)).rows[0]
        .n,
    ).toBe(1);
    expect(await queue()).toMatchObject({ used: 1, cap: 1, manualToday: 1, items: [] });
  });

  it('refuses a running, a closed and an unready pull request, and a member', async () => {
    const running = await addPr(1);
    await addRun(running, { startedAt: local(D, '08:00'), state: 'running' });
    expect((await trigger(running)).body.error?.code ?? (await trigger(running)).status).toMatch(
      /review_running|409/,
    );
    const closed = await addPr(2);
    await db().query('UPDATE pr_reviews SET closed_at=now() WHERE id=$1', [closed]);
    expect((await trigger(closed)).status).toBe(409);
    const idle = await addPr(3);
    const member = await w.t.userSession(`member-${randomUUID().slice(0, 6)}@example.test`);
    await db().query(
      `INSERT INTO project_members (project_id, user_id, role, status, joined_at, direct, org_grant)
       VALUES ($1,$2,'manager','active',now(),true,false)`,
      [w.projectId, member.id],
    );
    expect((await trigger(idle, member.cookie)).status).toBe(403);
    await db().query(`UPDATE workstations SET connected=false WHERE id=$1`, [w.workstationId]);
    const res = await trigger(idle);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/reviewer_not_ready/);
  });
});

describe('the cap setting', () => {
  it('defaults to 20; the owner sets it; 0 and 101 are refused; a member cannot', async () => {
    expect((await ok<any>(owner('GET', `/api/projects/${w.projectId}`))).project.prReviewDailyCap).toBe(20);
    const set = await setCap(5);
    expect(set.status).toBe(200);
    expect(set.body.project.prReviewDailyCap).toBe(5);
    expect((await queue()).cap).toBe(5);
    expect((await setCap(0)).status).toBe(400);
    expect((await setCap(101)).status).toBe(400);
    const member = await w.t.userSession(`member-${randomUUID().slice(0, 6)}@example.test`);
    await db().query(
      `INSERT INTO project_members (project_id, user_id, role, status, joined_at, direct, org_grant)
       VALUES ($1,$2,'manager','active',now(),true,false)`,
      [w.projectId, member.id],
    );
    const denied = await w.t.req('PUT', `/api/projects/${w.projectId}/pr-review-cap`, {
      cookie: member.cookie,
      body: { cap: 3 },
    });
    expect(denied.status).toBe(403);
  });
});
