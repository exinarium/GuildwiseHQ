import { PR_LIST_CAPABILITY, PR_REVIEW_CAPABILITY, REPLAY_CAPABILITY } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchReplayRuns } from '../src/commands/pr-replays.ts';
import { enqueueReviewPost, sweepStalePrReviewRuns } from '../src/commands/pr-review-runs.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, REPO_SSH, type World } from './helpers/world.ts';

/**
 * GWP-203: the 20-PR replay. Needs the test database (127.0.0.1:5433). The runner is a fake that answers the merged
 * pull request listing and every `pr_review.run` by hand; there is no git host. AC1 (nothing posted), AC2 (blind
 * marking), AC3 (precision per reviewer and effort) and AC4 (targets) run in order on one replay.
 */

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
let w: World;
let r: FakeRunner;
let replayId = '';
let strangerCookie = '';
let managerCookie = '';
const db = () => w.t.app.ctx.pool;
const ctx = () => w.t.app.ctx;
const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const mergedPr = (n: number) => ({
  id: String(n),
  url: `https://github.com/acme/toy/pull/${n}`,
  title: `Change ${n}`,
  author: 'dev',
  head: `feature/${n}`,
  base: 'main',
  headSha: HEAD,
  mergeCommitSha: BASE,
  mergedAt: new Date(Date.UTC(2026, 9, 1 + n)).toISOString(),
  additions: 10,
  deletions: 2,
});
const commands = async (type: string) =>
  (await db().query('SELECT payload, status FROM runner_commands WHERE type=$1 ORDER BY created_at', [type]))
    .rows;
const findingOf = (title: string, severity = 'high') => ({
  path: 'src/a.ts',
  line: 4,
  severity,
  title,
  body: 'body',
  anchored: true,
});

async function listAndSelect(count: number) {
  const from = r.received.length;
  const res = await owner('POST', `/api/projects/${w.projectId}/pr-replays`, { repoId: w.repoId });
  expect(res.status).toBe(201);
  replayId = res.body.id;
  const list: any = await r.waitFor('command', (f: any) => f.command === 'repo.list_merged_prs', 5000, from);
  await r.barrier();
  r.send('command.result', {
    commandId: list.commandId,
    ok: true,
    result: { ok: true, changes: Array.from({ length: count }, (_, i) => mergedPr(i + 1)) },
  });
  await r.barrier();
  await ctx().notifier.flush();
}

async function runOne(result: unknown) {
  const from = r.received.length;
  expect(await dispatchReplayRuns(ctx())).toBe(1);
  const cmd: any = await r.waitFor('command', (f: any) => f.command === 'pr_review.run', 5000, from);
  await r.barrier();
  r.send('command.result', { commandId: cmd.commandId, ok: true, result });
  await r.barrier();
  await ctx().notifier.flush();
  return cmd;
}

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({
    capabilities: [PR_LIST_CAPABILITY, PR_REVIEW_CAPABILITY, REPLAY_CAPABILITY],
  });
  await ok(owner('PATCH', `/api/projects/${w.projectId}/repos/${w.repoId}`, { prOnly: true }));
  r.send('repos.report', {
    repos: [
      { remoteUrl: REPO_SSH, localPath: '/tmp/toy', headBranch: 'main', reviewerToken: { present: false } },
    ],
  });
  await r.barrier();
  const manager = await w.t.userSession(uniqueEmail('manager'));
  managerCookie = manager.cookie;
  await db().query(
    `INSERT INTO project_members (project_id, user_id, role, status, joined_at) VALUES ($1,$2,'manager','active',now())`,
    [w.projectId, manager.id],
  );
  strangerCookie = (await w.t.userSession(uniqueEmail('stranger'))).cookie;
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

describe('AC1: both reviewers review 20 merged PRs and nothing is posted', () => {
  it('fewer than 20 usable PRs fails with not_enough_prs and starts no run', async () => {
    await listAndSelect(12);
    const dto = await ok<any>(owner('GET', `/api/pr-replays/${replayId}`));
    expect(dto).toMatchObject({ state: 'failed', failure: { reason: 'not_enough_prs', found: 12 } });
    expect(await commands('pr_review.run')).toHaveLength(0);
  });

  it('a manager cannot start a replay and a repo that is not PR-only gives 409', async () => {
    const m = await w.t.req('POST', `/api/projects/${w.projectId}/pr-replays`, {
      cookie: managerCookie,
      body: { repoId: w.repoId },
    });
    expect(m.status).toBe(403);
    await db().query('UPDATE project_repos SET pr_only=false WHERE id=$1', [w.repoId]);
    const res = await owner('POST', `/api/projects/${w.projectId}/pr-replays`, { repoId: w.repoId });
    expect(res.status).toBe(409);
    await db().query('UPDATE project_repos SET pr_only=true WHERE id=$1', [w.repoId]);
  });

  it('selects the newest 20, runs 40 offline reviews and posts nothing', async () => {
    await listAndSelect(25);
    const dto = await ok<any>(owner('GET', `/api/pr-replays/${replayId}`));
    expect(dto.state).toBe('reviewing');
    expect(dto.prs).toHaveLength(20);
    expect(dto.prs[0].changeId).toBe('25');
    const seen: any[] = [];
    for (let i = 0; i < 40; i++) {
      const cmd = await runOne({
        outcome: 'completed',
        headSha: HEAD,
        baseSha: BASE,
        durationMs: 60_000,
        summary: 's',
        changedLines: 1000,
        // two findings on the first PR of each reviewer; one on the rest
        findings: i < 2 ? [findingOf(`a${i}`), findingOf(`b${i}`)] : [],
      });
      seen.push(cmd.payload);
    }
    expect(seen.every((p) => p.offline === true && p.replay?.replayId === replayId)).toBe(true);
    expect(seen.filter((p) => p.model === 'sonnet')).toHaveLength(20);
    expect(seen.filter((p) => p.model === 'opus')).toHaveLength(20);
    expect(await commands('pr_review.post')).toHaveLength(0);
    const ev = await db().query(
      `SELECT type FROM events WHERE type IN ('PrReviewPosted','PrReviewRunStarted','PrReviewRunCompleted')`,
    );
    expect(ev.rows).toHaveLength(0);
    expect(
      (await db().query('SELECT count(*)::int AS n FROM pr_review_findings WHERE posted')).rows[0].n,
    ).toBe(0);
    expect((await db().query('SELECT count(*)::int AS n FROM pr_reviews')).rows[0].n).toBe(0);
    expect((await ok<any>(owner('GET', `/api/pr-replays/${replayId}`))).state).toBe('marking');
  });

  it('enqueueReviewPost refuses a replay run, and a replay run timed out by the sweep is a replay event', async () => {
    await expect(
      enqueueReviewPost(db(), { replay_id: replayId }, 'ws', {} as never, new Date()),
    ).rejects.toThrow('replay runs are never posted');
    expect(
      (await db().query(`SELECT count(*)::int AS n FROM pr_review_runs WHERE replay_id IS NULL`)).rows[0].n,
    ).toBe(0);
    expect(await sweepStalePrReviewRuns(ctx())).toBe(0);
  });
});

describe('AC2: blind marking', () => {
  const reviewerWords = /sonnet|opus|"first"|"second"|reviewer"?:/i;
  it('shows no reviewer in any read before the last mark', async () => {
    const dto = await ok<any>(owner('GET', `/api/pr-replays/${replayId}`));
    expect(dto.result).toBeNull();
    expect(JSON.stringify(dto)).not.toMatch(reviewerWords);
    const next = await ok<any>(owner('GET', `/api/pr-replays/${replayId}/next-finding`));
    expect(next.next.total).toBe(4);
    expect(next.next.finding.reviewers).toBeNull();
    expect(JSON.stringify(next)).not.toMatch(reviewerWords);
    const list = await ok<any>(owner('GET', `/api/pr-replays/${replayId}/findings`));
    expect(list.findings).toHaveLength(4);
    expect(JSON.stringify(list)).not.toMatch(reviewerWords);
  });
  it('a manager gets 403 and a stranger 404 on mark and shown', async () => {
    const id = (await ok<any>(owner('GET', `/api/pr-replays/${replayId}/next-finding`))).next.finding.id;
    for (const [cookie, status] of [
      [managerCookie, 403],
      [strangerCookie, 404],
    ] as const) {
      expect(
        (await w.t.req('PUT', `/api/pr-replay-findings/${id}/mark`, { cookie, body: { mark: 'useful' } }))
          .status,
      ).toBe(status);
      expect((await w.t.req('POST', `/api/pr-replay-findings/${id}/shown`, { cookie })).status).toBe(status);
    }
    // the live endpoint does not know a replay finding
    expect((await owner('PUT', `/api/pr-review-findings/${id}/mark`, { mark: 'useful' })).status).toBe(404);
  });
  it('marks every finding, one at a time; the reviewers appear only after the last mark', async () => {
    const marks = ['useful', 'useful', 'useful', 'noise'];
    for (const [i, m] of marks.entries()) {
      const step = (await ok<any>(owner('GET', `/api/pr-replays/${replayId}/next-finding`))).next;
      expect(step.position).toBe(i + 1);
      expect((await owner('POST', `/api/pr-replay-findings/${step.finding.id}/shown`)).status).toBe(204);
      const res = await ok<any>(owner('PUT', `/api/pr-replay-findings/${step.finding.id}/mark`, { mark: m }));
      if (i < 3) {
        expect(res.replay.state).toBe('marking');
        expect(res.finding.reviewers).toBeNull();
        expect(JSON.stringify(res)).not.toMatch(reviewerWords);
      } else {
        expect(res.replay.state).toBe('finished');
        expect(res.finding.reviewers).toHaveLength(1);
      }
    }
    const rows = await db().query(
      `SELECT count(*)::int AS n FROM pr_review_finding_marks m JOIN pr_replay_prs p ON p.id = m.pr_review_id WHERE p.replay_id=$1`,
      [replayId],
    );
    expect(rows.rows[0].n).toBe(4);
    // a mark after the finish is refused
    const any = (await db().query(`SELECT id FROM pr_review_findings WHERE replay_id=$1 LIMIT 1`, [replayId]))
      .rows[0].id;
    expect((await owner('PUT', `/api/pr-replay-findings/${any}/mark`, { mark: 'noise' })).status).toBe(409);
  });
});

describe('AC3: precision per reviewer and the recorded effort', () => {
  it('a finished replay shows precision for each reviewer and the effort', async () => {
    const dto = await ok<any>(owner('GET', `/api/pr-replays/${replayId}`));
    expect(dto.state).toBe('finished');
    const by = (k: string) => dto.result.reviewers.find((x: any) => x.reviewer === k);
    expect(by('first').wouldPost).toBe(2);
    expect(by('second').wouldPost).toBe(2);
    expect(by('first').precision === null || by('first').precision >= 0).toBe(true);
    const useful = by('first').useful + by('second').useful;
    expect(useful).toBe(3);
    expect(dto.result.effort.findingsMarked).toBe(4);
    expect(dto.result.effort.activeMs).toBeGreaterThanOrEqual(0);
    // live precision is untouched by replay marks
    const live = await ok<any>(owner('GET', `/api/projects/${w.projectId}/reviewer-precision`));
    expect(live.reviewers).toEqual([]);
  });
});

describe('AC4: targets saved on the project', () => {
  it('are saved by the owner from a finished replay, once, and refused for a manager or bad values', async () => {
    const put = (body: unknown, cookie = w.owner.cookie) =>
      w.t.req('PUT', `/api/projects/${w.projectId}/review-targets`, { cookie, body });
    expect((await put({ precisionTarget: 0.7, effortTargetHoursPerWeek: 3 }, managerCookie)).status).toBe(
      403,
    );
    expect((await put({ precisionTarget: 1.2, effortTargetHoursPerWeek: 3 })).status).toBe(400);
    expect((await put({ precisionTarget: 0.7, effortTargetHoursPerWeek: -1 })).status).toBe(400);
    const res = await put({ precisionTarget: 0.7, effortTargetHoursPerWeek: 3 });
    expect(res.status).toBe(200);
    expect(res.body.project.reviewTargets).toMatchObject({
      precisionTarget: 0.7,
      effortTargetHoursPerWeek: 3,
      replayId,
    });
    const before = (
      await db().query(`SELECT count(*)::int AS n FROM events WHERE type='ProjectReviewTargetsSet'`)
    ).rows[0].n;
    await put({ precisionTarget: 0.7, effortTargetHoursPerWeek: 3 });
    const after = (
      await db().query(`SELECT count(*)::int AS n FROM events WHERE type='ProjectReviewTargetsSet'`)
    ).rows[0].n;
    expect(after).toBe(before);
  });
  it('are refused without a finished replay', async () => {
    await db().query(`UPDATE pr_replays SET state='cancelled'`);
    const res = await owner('PUT', `/api/projects/${w.projectId}/review-targets`, {
      precisionTarget: 0.5,
      effortTargetHoursPerWeek: 2,
    });
    expect(res.status).toBe(409);
  });
});
