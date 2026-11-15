import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/**
 * GWP-199: the owner's useful/noise mark, blind to the reviewer, and precision per reviewer. Needs the test database
 * (127.0.0.1:5433). The pull request, run and findings are written straight into the projection tables.
 */

let w: World;
const db = () => w.t.app.ctx.pool;
const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });

const PR = randomUUID();
const RUN = randomUUID();
const ids = Array.from({ length: 6 }, () => randomUUID()); // 0-3 posted, 4 held back, 5 selected but not posted
let managerCookie = '';
let strangerCookie = '';

beforeAll(async () => {
  w = await createWorld();
  await db().query(
    `INSERT INTO pr_reviews (id, project_id, project_repo_id, change_id, url, title, author, head_branch, base_branch, opened_at, recorded_at, review_state, reviewed_by, reviewed_at)
     VALUES ($1,$2,$3,'7','https://github.com/acme/toy/pull/7','Change 7','dev','f','main',now(),now(),'reviewed','first',now())`,
    [PR, w.projectId, w.repoId],
  );
  await db().query(
    `INSERT INTO pr_review_runs (id, pr_review_id, project_id, reviewer, runtime, model, state, timeout_ms, started_at, head_sha, posted_at, review_url)
     VALUES ($1,$2,$3,'first','claude-code','sonnet','posted',600000,now(),$4,now(),'https://github.com/acme/toy/pull/7#r')`,
    [RUN, PR, w.projectId, 'a'.repeat(40)],
  );
  for (const [i, id] of ids.entries()) {
    await db().query(
      `INSERT INTO pr_review_findings (id, run_id, pr_review_id, idx, path, line, anchored, severity, title, body, rank, disposition, posted)
       VALUES ($1,$2,$3,$4,'a.ts',$5,true,'high',$6,'b',$7,$8,$9)`,
      [id, RUN, PR, i, i + 1, `t${i}`, i + 1, i === 4 ? 'held_back' : 'posted', i < 4],
    );
  }
  const manager = await w.t.userSession(uniqueEmail('manager'));
  managerCookie = manager.cookie;
  await db().query(
    `INSERT INTO project_members (project_id, user_id, role, status, joined_at) VALUES ($1,$2,'manager','active',now())`,
    [w.projectId, manager.id],
  );
  strangerCookie = (await w.t.userSession(uniqueEmail('stranger'))).cookie;
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const findings = async () => (await ok<any>(owner('GET', `/api/pr-reviews/${PR}/findings`))).findings;
const mark = (id: string, m: string, cookie = w.owner.cookie) =>
  w.t.req('PUT', `/api/pr-review-findings/${id}/mark`, { cookie, body: { mark: m } });
const markEvents = async () =>
  (await db().query(`SELECT count(*)::int AS n FROM events WHERE type='PrReviewFindingMarked'`)).rows[0].n;

describe('AC2: blind until marked', () => {
  it('unmarked posted findings carry no reviewer, and held-back or unposted ones are not listed', async () => {
    const list = await findings();
    expect(list).toHaveLength(4);
    expect(JSON.stringify(list).toLowerCase()).not.toMatch(/sonnet|"first"/);
    expect(list.every((f: any) => f.reviewers === null && f.mark === null)).toBe(true);
  });
  it('the pull request row hides the reviewer while a posted finding is unmarked', async () => {
    const res = await ok<any>(owner('GET', `/api/projects/${w.projectId}/pull-requests`));
    const p = res.pullRequests.find((x: any) => x.id === PR);
    expect(p).toMatchObject({ reviewer: null, reviewersHidden: true, unmarkedCount: 4 });
    expect(JSON.stringify(p).toLowerCase()).not.toContain('sonnet');
  });
});

describe('AC1: mark saved and changeable, owner only', () => {
  it('owner marks useful; the mark is shown with the reviewer; marking again with the same mark appends no event', async () => {
    const before = await markEvents();
    const res = await ok<any>(mark(ids[0] as string, 'useful'));
    expect(res).toMatchObject({ mark: 'useful', reviewers: [{ key: 'first', model: 'sonnet' }] });
    expect(await markEvents()).toBe(before + 1);
    await ok(mark(ids[0] as string, 'useful'));
    expect(await markEvents()).toBe(before + 1);
  });
  it('a change keeps the first (blind) mark', async () => {
    await ok(mark(ids[0] as string, 'noise'));
    const r = (
      await db().query('SELECT mark, blind_mark FROM pr_review_finding_marks WHERE finding_id=$1', [ids[0]])
    ).rows[0];
    expect(r).toEqual({ mark: 'noise', blind_mark: 'useful' });
    await ok(mark(ids[0] as string, 'useful'));
  });
  it('a manager gets 403, a non-member 404, a held-back or unposted finding 409, valid/invalid 400', async () => {
    expect((await mark(ids[1] as string, 'useful', managerCookie)).status).toBe(403);
    expect((await mark(ids[1] as string, 'useful', strangerCookie)).status).toBe(404);
    expect((await mark(ids[4] as string, 'useful')).status).toBe(409);
    expect((await mark(ids[5] as string, 'useful')).status).toBe(409);
    expect((await mark(ids[1] as string, 'valid')).status).toBe(400);
  });
  it('a manager sees the findings but cannot mark them', async () => {
    const res: any = await w.t.req('GET', `/api/pr-reviews/${PR}/findings`, { cookie: managerCookie });
    expect(res.status).toBe(200);
    expect(res.body.findings.every((f: any) => f.canMark === false)).toBe(true);
  });
});

describe('AC3 and AC4: replay input and precision', () => {
  it('marking 3 of 4 posted findings useful and 1 noise gives precision 0.75, held-back not counted', async () => {
    await ok(mark(ids[1] as string, 'useful'));
    await ok(mark(ids[2] as string, 'useful'));
    await ok(mark(ids[3] as string, 'noise'));
    const p = await ok<any>(owner('GET', `/api/projects/${w.projectId}/reviewer-precision`));
    expect(p.reviewers).toEqual([
      expect.objectContaining({
        reviewer: 'first',
        posted: 4,
        useful: 3,
        noise: 1,
        unmarked: 0,
        precision: 0.75,
      }),
    ]);
  });
  it('the row reveals the reviewer once every posted finding is marked', async () => {
    const res = await ok<any>(owner('GET', `/api/projects/${w.projectId}/pull-requests`));
    expect(res.pullRequests.find((x: any) => x.id === PR)).toMatchObject({
      reviewer: 'first',
      reviewersHidden: false,
    });
  });
  it('the replay query returns the marks with reviewer, PR and mark, and filters by reviewer', async () => {
    const res = await ok<any>(owner('GET', `/api/projects/${w.projectId}/pr-review-marks`));
    expect(res.marks).toHaveLength(4);
    expect(res.marks[0]).toMatchObject({
      reviewer: 'first',
      model: 'sonnet',
      changeId: '7',
      prUrl: 'https://github.com/acme/toy/pull/7',
      repoName: expect.any(String),
    });
    expect(res.marks.map((m: any) => m.mark).sort()).toEqual(['noise', 'useful', 'useful', 'useful']);
    expect(res.marks.every((m: any) => m.blindMark && m.markedAt && m.postedAt)).toBe(true);
    const none = await ok<any>(owner('GET', `/api/projects/${w.projectId}/pr-review-marks?reviewer=second`));
    expect(none.marks).toEqual([]);
  });
});
