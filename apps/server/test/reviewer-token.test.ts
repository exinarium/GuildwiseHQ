import { PR_LIST_CAPABILITY } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listReviewEligiblePrs } from '../src/commands/pr-only.ts';
import { listReviewablePrs, reviewerGate, reviewerTokenStates } from '../src/review/reviewer-gate.ts';
import { closeAdminPool } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, REPO_SSH, type World } from './helpers/world.ts';

/**
 * GWP-196: the server holds only whether a workstation has a reviewer token (AC3), and a PR-only repository without one
 * starts no review and shows "missing" (AC4). Needs the test database (127.0.0.1:5433).
 */

const SENTINEL = 'github_pat_SENTINEL_0123456789';
const logLines: string[] = [];
const logStream = { write: (line: string) => void logLines.push(line) };

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', LOG_LEVEL: 'trace' }, logStream });
  r = await w.connectRunner({ capabilities: [PR_LIST_CAPABILITY] });
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const db = () => w.t.app.ctx.pool;
const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const repoDto = async () =>
  (await ok<any>(owner('GET', `/api/projects/${w.projectId}`))).repos.find((x: any) => x.id === w.repoId);
const reportRepos = async (reviewerToken?: unknown) => {
  r.send('repos.report', {
    repos: [
      {
        remoteUrl: REPO_SSH,
        localPath: '/tmp/toy',
        headBranch: 'main',
        ...(reviewerToken !== undefined ? { reviewerToken } : {}),
      },
    ],
  });
  await r.barrier();
};
const flag = async () =>
  (
    await db().query(
      'SELECT reviewer_token, reviewer_token_problem FROM workstation_repos WHERE project_repo_id=$1',
      [w.repoId],
    )
  ).rows[0];

describe('reviewer token gate on a PR-only repository', () => {
  it('AC4: no token, no reviewable PR, "missing" on the repository and no run command', async () => {
    // not PR-only yet
    expect(await reviewerGate(db(), w.repoId)).toEqual({ state: 'not_pr_only' });
    expect((await repoDto()).reviewerToken).toBeNull();

    const from = r.received.length;
    await ok(owner('PATCH', `/api/projects/${w.projectId}/repos/${w.repoId}`, { prOnly: true }));
    const cmd: any = await r.waitFor('command', (f: any) => f.command === 'repo.list_prs', 5000, from);
    await r.barrier();
    const t0 = (await db().query('SELECT pr_only_since FROM project_repos WHERE id=$1', [w.repoId])).rows[0]
      .pr_only_since as Date;
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: {
        ok: true,
        complete: true,
        changes: [
          {
            id: '7',
            url: 'https://github.com/acme/toy/pull/7',
            title: 'Change 7',
            author: 'dev',
            head: 'feature/7',
            base: 'main',
            createdAt: new Date(t0.getTime() + 60_000).toISOString(),
          },
        ],
      },
    });
    await r.barrier();
    await w.t.app.ctx.notifier.flush();

    // the PR is recorded and eligible as before (GWP-195 is unchanged) ...
    expect((await listReviewEligiblePrs(db(), w.projectId)).map((p) => p.changeId)).toEqual(['7']);
    // ... but the runner did not report a token: nothing is reviewable and the owner sees why
    expect(await listReviewablePrs(db(), w.projectId)).toEqual([]);
    expect(await reviewerGate(db(), w.repoId)).toEqual({ state: 'reviewer_token_missing', problem: null });
    expect((await repoDto()).reviewerToken).toBe('missing');
    // no runner command other than the PR listing was queued for this repository
    const types = (await db().query('SELECT DISTINCT type FROM runner_commands')).rows.map(
      (x) => x.type as string,
    );
    expect(types.filter((t) => /review/.test(t) && t !== 'repo.list_prs')).toEqual([]);

    // an explicit "no token" report gives the same answer
    await reportRepos({ present: false });
    expect(await flag()).toMatchObject({ reviewer_token: false });
    expect(await listReviewablePrs(db(), w.projectId)).toEqual([]);
    expect((await repoDto()).reviewerToken).toBe('missing');
  });

  it('a problem with the saved token still blocks, and says why', async () => {
    await reportRepos({ present: false, problem: 'unreadable' });
    expect(await reviewerGate(db(), w.repoId)).toEqual({
      state: 'reviewer_token_missing',
      problem: 'unreadable',
    });
    expect(await listReviewablePrs(db(), w.projectId)).toEqual([]);
  });

  it('AC4: once the workstation reports a token, the PR is reviewable on that workstation', async () => {
    await reportRepos({ present: true });
    const gate = await reviewerGate(db(), w.repoId);
    expect(gate).toEqual({ state: 'ready', workstationIds: [w.workstationId] });
    const reviewable = await listReviewablePrs(db(), w.projectId);
    expect(reviewable.map((p) => [p.changeId, p.workstationIds])).toEqual([['7', [w.workstationId]]]);
    expect((await repoDto()).reviewerToken).toBe('present');
    expect((await reviewerTokenStates(db(), [w.repoId])).get(w.repoId)).toBe('present');
  });

  it('an unlinked workstation does not count', async () => {
    await db().query(`UPDATE workstations SET status='unlinked' WHERE id=$1`, [w.workstationId]);
    try {
      expect((await reviewerGate(db(), w.repoId)).state).toBe('reviewer_token_missing');
      expect(await listReviewablePrs(db(), w.projectId)).toEqual([]);
    } finally {
      await db().query(`UPDATE workstations SET status='active' WHERE id=$1`, [w.workstationId]);
    }
    expect((await reviewerGate(db(), w.repoId)).state).toBe('ready');
  });

  it('a repository switched off is not PR-only and is not reviewable', async () => {
    await ok(owner('PATCH', `/api/projects/${w.projectId}/repos/${w.repoId}`, { prOnly: false }));
    expect(await reviewerGate(db(), w.repoId)).toEqual({ state: 'not_pr_only' });
    expect(await listReviewablePrs(db(), w.projectId)).toEqual([]);
    expect((await repoDto()).reviewerToken).toBeNull();
    await ok(owner('PATCH', `/api/projects/${w.projectId}/repos/${w.repoId}`, { prOnly: true }));
  });
});

describe('AC3: the token is not on the server', () => {
  it('a report that carries a token is refused whole; the server stores only the flag', async () => {
    await reportRepos({ present: true });
    expect((await flag()).reviewer_token).toBe(true);
    // a runner that put the token in the report: the strict schema drops the message, nothing is stored
    await reportRepos({ present: false, token: SENTINEL });
    expect((await flag()).reviewer_token).toBe(true);
    await reportRepos({ present: true });
    await w.t.app.ctx.notifier.flush();

    const text = async (sql: string) => JSON.stringify((await db().query(sql)).rows);
    expect(await text('SELECT payload::text FROM events')).not.toContain(SENTINEL);
    expect(await text('SELECT row_to_json(wr)::text FROM workstation_repos wr')).not.toContain(SENTINEL);
    expect(await text('SELECT row_to_json(x)::text FROM workstations x')).not.toContain(SENTINEL);
    expect(await text('SELECT row_to_json(c)::text FROM runner_commands c')).not.toContain(SENTINEL);
    expect(logLines.join('\n')).not.toContain(SENTINEL);
    // the only column the feature adds holds a boolean and a short enum
    const cols = (
      await db().query(
        `SELECT column_name, data_type FROM information_schema.columns
          WHERE table_name='workstation_repos' AND column_name LIKE 'reviewer_token%' ORDER BY column_name`,
      )
    ).rows;
    expect(cols).toEqual([
      { column_name: 'reviewer_token', data_type: 'boolean' },
      { column_name: 'reviewer_token_problem', data_type: 'text' },
    ]);
  });
});
