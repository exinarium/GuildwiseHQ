import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchPrReviews } from '../src/commands/pr-review-runs.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool } from './helpers/db.ts';
import { createPairWorld, type PairWorld, seedRecordedReplay } from './helpers/pr-review-pair.ts';

/**
 * GWP-204 AC1: the second reviewer (Opus) cannot be switched on for live pull requests without a recorded replay.
 * Needs the test database (127.0.0.1:5433). Fake workstation; no model runs.
 */

let p: PairWorld;
let managerCookie = '';
let strangerCookie = '';
const put = (enabled: unknown, cookie?: string) =>
  p.w.t.req('PUT', `/api/projects/${p.w.projectId}/second-reviewer`, {
    cookie: cookie ?? p.w.owner.cookie,
    body: { enabled },
  });
const events = async () =>
  (await p.db().query(`SELECT payload FROM events WHERE type='ProjectSecondReviewerSet' ORDER BY seq`)).rows.map(
    (x) => x.payload as any,
  );
const detail = async () => (await p.owner('GET', `/api/projects/${p.w.projectId}`)).body.project;

beforeAll(async () => {
  p = await createPairWorld(3);
  const manager = await p.w.t.userSession(uniqueEmail('manager'));
  managerCookie = manager.cookie;
  await p.db().query(
    `INSERT INTO project_members (project_id, user_id, role, status, joined_at) VALUES ($1,$2,'manager','active',now())`,
    [p.w.projectId, manager.id],
  );
  strangerCookie = (await p.w.t.userSession(uniqueEmail('stranger'))).cookie;
});
afterAll(async () => {
  await p.close();
  await closeAdminPool();
});

describe('AC1: no recorded replay, no second reviewer', () => {
  it('a switch-on without a replay is 409 replay_required, appends no event and the DTO stays off', async () => {
    const res = await put(true);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('replay_required');
    expect(await events()).toEqual([]);
    expect((await detail()).secondReviewer).toMatchObject({ enabled: false, replayId: null, replayRecordedAt: null });
  });

  it('a finished replay in which the second reviewer reviewed no pull request still does not count', async () => {
    await seedRecordedReplay(p, { first: 20, second: 0 });
    expect((await put(true)).status).toBe(409);
    expect(await events()).toEqual([]);
  });

  it('a flag set in the database without a replay starts a round of the first reviewer only', async () => {
    await p.db().query('UPDATE projects SET pr_review_second_reviewer=true WHERE id=$1', [p.w.projectId]);
    expect(await dispatchPrReviews(p.ctx())).toBeGreaterThan(0);
    const rounds = (await p.db().query('SELECT reviewers FROM pr_review_rounds')).rows;
    expect(rounds.length).toBeGreaterThan(0);
    expect(rounds.every((r) => r.reviewers.join() === 'first')).toBe(true);
    expect((await p.db().query(`SELECT count(*)::int AS n FROM pr_review_runs WHERE reviewer='second'`)).rows[0].n).toBe(0);
    await p.db().query('UPDATE projects SET pr_review_second_reviewer=false WHERE id=$1', [p.w.projectId]);
  });

  it('with a recorded replay the owner switches it on; the event names the replay and the DTO shows it', async () => {
    const replayId = await seedRecordedReplay(p);
    const res = await put(true);
    expect(res.status).toBe(200);
    expect(await events()).toEqual([expect.objectContaining({ enabled: true, replayId })]);
    expect((await detail()).secondReviewer).toMatchObject({
      enabled: true,
      replayId,
      precision: { first: 0.7, second: 0.7 },
    });
    expect((await put(true)).status).toBe(200); // unchanged: no second event
    expect(await events()).toHaveLength(1);
  });

  it('switching off is always allowed, also when the replay is gone', async () => {
    await p.db().query('DELETE FROM pr_replays');
    expect((await put(false)).status).toBe(200);
    expect((await events()).map((e) => e.enabled)).toEqual([true, false]);
    expect((await detail()).secondReviewer.enabled).toBe(false);
  });

  it('a manager is refused, a non-member does not see the project, a bad body is 400', async () => {
    await seedRecordedReplay(p);
    expect((await put(true, managerCookie)).status).toBe(403);
    expect((await put(true, strangerCookie)).status).toBe(404);
    expect((await put('yes')).status).toBe(400);
  });
});
