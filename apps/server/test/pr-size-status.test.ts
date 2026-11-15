import { randomUUID } from 'node:crypto';
import { COMMIT_STATUS_CAPABILITY, SIZE_STATUS_CONTEXT } from '@aom/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyPrListResult, requestPrList } from '../src/commands/pr-only.ts';
import {
  applyCommitStatusResult,
  deliverSizeStatuses,
  refreshSizeStatuses,
  sizeStatusDtoOf,
} from '../src/commands/pr-size-status.ts';
import { closeAdminPool } from './helpers/db.ts';
import { sizeExceptionWorld } from './helpers/size-exception.ts';

const push = vi.hoisted(() => vi.fn());
vi.mock('web-push', () => ({ default: { sendNotification: push, generateVAPIDKeys: () => ({}) } }));

/**
 * GWP-211: the hard size check, end to end on the server with a fake runner and a fake git host list (the poll's own
 * path). Needs the test database (Postgres 5433): left for the testers when it is not up.
 */
let s: Awaited<ReturnType<typeof sizeExceptionWorld>>;
beforeAll(async () => {
  s = await sizeExceptionWorld();
  await s.m
    .db()
    .query(
      `UPDATE workstation_capabilities SET capabilities = capabilities || $2::text[] WHERE workstation_id=$1`,
      [s.m.w.workstationId, [COMMIT_STATUS_CAPABILITY]],
    );
});
afterAll(async () => {
  s.m.w.t.clock.setOffset(0);
  s.m.r.close();
  await s.m.w.t.close();
  await closeAdminPool();
});
beforeEach(async () => {
  push.mockReset();
  await s.clean();
  const q = s.m.db();
  await q.query('DELETE FROM pr_size_statuses');
  await q.query('DELETE FROM pr_size_status_repos');
  await q.query(`DELETE FROM runner_commands WHERE type='repo.commit_status'`);
  await q.query(`UPDATE workstations SET status_tokens='["github@github.com"]'::jsonb WHERE id=$1`, [
    s.m.w.workstationId,
  ]);
  await q.query(`UPDATE project_repos SET pr_only=true, pr_only_since='2030-01-01T00:00:00Z' WHERE id=$1`, [
    s.m.w.repoId,
  ]);
});
afterEach(() => s.unpin());

const q = () => s.m.db();
const sha = (n: number) => n.toString(16).padStart(40, '0');

interface P {
  n: number;
  head: string;
  base: string;
  lines: number | null;
}
/** The git host's open pull request list, with head commits, through the poll's own path. */
async function poll(list: P[]) {
  const requestId = randomUUID();
  await q().query(
    `INSERT INTO pr_review_polls (project_repo_id, request_id, workstation_id, state, requested_at)
     VALUES ($1,$2,$3,'pending',now())
     ON CONFLICT (project_repo_id) DO UPDATE SET request_id=EXCLUDED.request_id, state='pending'`,
    [s.m.w.repoId, requestId, s.m.w.workstationId],
  );
  await applyPrListResult(
    s.m.ctx(),
    { requestId, repoId: s.m.w.repoId },
    true,
    {
      ok: true,
      complete: true,
      changes: list.map((c) => ({
        id: String(c.n),
        url: `https://github.com/acme/toy/pull/${c.n}`,
        title: `Change ${c.n}`,
        author: 'dev',
        head: c.head,
        base: c.base,
        createdAt: '2030-02-01T00:00:00.000Z',
        changedLines: c.lines,
        changedFiles: 3,
        crossRepo: false,
        headSha: sha(c.n),
      })),
    },
    undefined,
  );
}
const statuses = async () =>
  (await q().query('SELECT * FROM pr_size_statuses ORDER BY change_id')).rows as Array<Record<string, any>>;
const statusOf = async (n: number) => (await statuses()).find((r) => r.change_id === String(n));
const commands = async () =>
  (
    await q().query(
      `SELECT payload, status FROM runner_commands WHERE type='repo.commit_status' ORDER BY created_at`,
    )
  ).rows as Array<{ payload: Record<string, any>; status: string }>;
/** An over-budget PR the size check already sent back, with its head commit. */
async function overBudgetPr(n: number, lines: number) {
  await poll([{ n, head: `big/${n}`, base: 'main', lines }]);
  const pr = await s.prOf(n);
  expect(pr.review_state).toBe('needs_split');
  return pr.id;
}
const deliver = () => deliverSizeStatuses(s.m.ctx());

describe('AC1: an over-budget PR fails with size, budget and unit', () => {
  it('stores a failing status, posts it through the runner command and records the answer', async () => {
    await poll([{ n: 12, head: 'feature/a', base: 'main', lines: 700 }]);
    expect(await statusOf(12)).toMatchObject({
      state: 'failure',
      reason: 'over',
      description: 'Over budget: 700 changed lines, budget 600 changed lines',
      head_sha: sha(12),
      post_state: 'pending',
    });
    expect(await deliver()).toBe(1);
    const cmds = await commands();
    expect(cmds).toHaveLength(1);
    expect(cmds[0]?.payload).toMatchObject({
      sha: sha(12),
      state: 'failure',
      context: SIZE_STATUS_CONTEXT,
      description: 'Over budget: 700 changed lines, budget 600 changed lines',
      forge: 'github',
    });
    expect((await statusOf(12))?.post_state).toBe('queued');
    await applyCommitStatusResult(s.m.ctx(), cmds[0]?.payload ?? {}, true, { ok: true }, undefined);
    expect((await statusOf(12))?.post_state).toBe('posted');
    expect((await q().query('SELECT 1 FROM pr_size_status_repos')).rowCount).toBe(1);
    // nothing changed: the next poll posts nothing again
    await poll([{ n: 12, head: 'feature/a', base: 'main', lines: 700 }]);
    expect(await deliver()).toBe(0);
    expect(await commands()).toHaveLength(1);
  });

  it('a new commit on the PR posts a new status', async () => {
    await poll([{ n: 12, head: 'feature/a', base: 'main', lines: 700 }]);
    const first = (await statusOf(12))?.status_id;
    await poll([{ n: 12, head: 'feature/a', base: 'main', lines: 650 }]);
    expect((await statusOf(12))?.description).toBe(
      'Over budget: 650 changed lines, budget 600 changed lines',
    );
    expect((await statusOf(12))?.status_id).not.toBe(first);
  });

  it('a failed post is kept with its reason; a stale answer is ignored', async () => {
    await poll([{ n: 12, head: 'feature/a', base: 'main', lines: 700 }]);
    await deliver();
    const payload = (await commands())[0]?.payload ?? {};
    await applyCommitStatusResult(
      s.m.ctx(),
      payload,
      true,
      { ok: false, code: 'forbidden', error: 'no' },
      undefined,
    );
    expect(await statusOf(12)).toMatchObject({ post_state: 'failed', error_code: 'forbidden' });
    await applyCommitStatusResult(s.m.ctx(), { statusId: randomUUID() }, true, { ok: true }, undefined);
    expect((await statusOf(12))?.post_state).toBe('failed');
  });

  it('without a workstation holding a status token nothing is queued and the settings say so', async () => {
    await q().query(`UPDATE workstations SET status_tokens='[]'::jsonb`);
    await poll([{ n: 12, head: 'feature/a', base: 'main', lines: 700 }]);
    expect(await deliver()).toBe(0);
    expect(await commands()).toHaveLength(0);
    expect((await statusOf(12))?.post_state).toBe('pending');
    const dto = await sizeStatusDtoOf(q(), s.m.w.projectId);
    expect(dto).toMatchObject({ context: 'size-budget', failing: 1 });
    expect(['no_token', 'no_runner']).toContain(dto.state);
  });
});

describe('AC2: an approved owner exception passes the check', () => {
  it('passes with "owner exception", and fails again when the PR grows past the approved size', async () => {
    const prId = await overBudgetPr(301, 900);
    expect((await statusOf(301))?.state).toBe('failure');
    const r = await s.request(prId);
    const res = await s.resolve(r.deskItemId, 'approved');
    expect(res.status).toBe(200);
    await vi.waitFor(async () => expect((await statusOf(301))?.state).toBe('success'));
    expect(await statusOf(301)).toMatchObject({ reason: 'owner_exception', post_state: expect.any(String) });
    expect((await statusOf(301))?.description).toContain('owner exception');
    await poll([{ n: 301, head: 'big/301', base: 'main', lines: 1200 }]);
    expect(await statusOf(301)).toMatchObject({ state: 'failure', reason: 'over' });
  });

  it('a rejected request keeps the status failing', async () => {
    const prId = await overBudgetPr(302, 900);
    const r = await s.request(prId);
    expect((await s.resolve(r.deskItemId, 'rejected')).status).toBe(200);
    await vi.waitFor(async () => expect((await statusOf(302))?.state).toBe('failure'));
  });
});

describe('AC3: a within-budget PR passes', () => {
  it('passes, and exactly the budget is within', async () => {
    await poll([
      { n: 20, head: 'feature/b', base: 'main', lines: 420 },
      { n: 21, head: 'feature/c', base: 'main', lines: 600 },
    ]);
    expect(await statusOf(20)).toMatchObject({
      state: 'success',
      description: 'Within budget: 420 changed lines, budget 600 changed lines',
    });
    expect((await statusOf(21))?.state).toBe('success');
  });
});

describe('AC4: a stacked chain over budget in total fails for each PR', () => {
  it('fails both members with the chain total', async () => {
    await poll([
      { n: 12, head: 'stack/a', base: 'main', lines: 300 },
      { n: 13, head: 'stack/b', base: 'stack/a', lines: 400 },
    ]);
    for (const n of [12, 13])
      expect(await statusOf(n)).toMatchObject({
        state: 'failure',
        description: 'Over budget: 700 changed lines, budget 600 changed lines (stack #12 #13)',
      });
  });

  it('checks every open PR of a repository that is not PR-only, and records no review for it', async () => {
    await q().query(`UPDATE project_repos SET pr_only=false WHERE id=$1`, [s.m.w.repoId]);
    await q().query('DELETE FROM pr_reviews');
    await poll([{ n: 40, head: 'aom/gwp-9-card', base: 'main', lines: 800 }]);
    expect(await statusOf(40)).toMatchObject({ state: 'failure', reason: 'over' });
    expect((await q().query('SELECT 1 FROM pr_reviews')).rowCount).toBe(0);
    expect((await q().query('SELECT 1 FROM pr_open_changes')).rowCount).toBe(1);
  });
});

describe('AC5: a project without a budget reports no failing check', () => {
  it('posts nothing and does not poll a repository that is not PR-only', async () => {
    await q().query(`UPDATE projects SET size_budget=NULL, size_unit=NULL WHERE id=$1`, [s.m.w.projectId]);
    await q().query(`UPDATE project_repos SET pr_only=false WHERE id=$1`, [s.m.w.repoId]);
    expect(await requestPrList(s.m.ctx(), s.m.w.repoId, { force: true })).toEqual({
      queued: false,
      reason: 'skipped',
    });
    await poll([{ n: 12, head: 'feature/a', base: 'main', lines: 9000 }]);
    expect(await statuses()).toHaveLength(0);
    expect(await deliver()).toBe(0);
    expect(await commands()).toHaveLength(0);
    expect((await sizeStatusDtoOf(q(), s.m.w.projectId)).state).toBe('inactive');
  });

  it('after a budget is removed, a repository that had the check gets a passing inactive status', async () => {
    await poll([{ n: 12, head: 'feature/a', base: 'main', lines: 700 }]);
    await deliver();
    await applyCommitStatusResult(
      s.m.ctx(),
      (await commands())[0]?.payload ?? {},
      true,
      { ok: true },
      undefined,
    );
    await q().query(`UPDATE projects SET size_budget=NULL, size_unit=NULL WHERE id=$1`, [s.m.w.projectId]);
    await refreshSizeStatuses(s.m.ctx(), { projectId: s.m.w.projectId });
    expect(await statusOf(12)).toMatchObject({
      state: 'success',
      reason: 'inactive',
      description: 'Size check inactive: no size budget set',
    });
    await vi.waitFor(async () => expect((await commands()).length).toBe(2));
    expect((await commands())[1]?.payload).toMatchObject({ state: 'success', sha: sha(12) });
  });
});

describe('delivery: statuses nobody can post never hold up the others (AC1/AC2 stay reliable)', () => {
  /**
   * A repository on another git host that the workstation has cloned, but it holds no status token for that host: its
   * statuses can never be posted. Removed again after each test.
   */
  async function stuckRepo(count: number): Promise<string> {
    const id = randomUUID();
    await q().query(
      `INSERT INTO project_repos (id, project_id, name, remote_url, remote_url_normalized, forge_kind)
       VALUES ($1,$2,'stuck','https://ghe.example.com/acme/stuck.git','ghe.example.com/acme/stuck','github')`,
      [id, s.m.w.projectId],
    );
    await q().query(
      `INSERT INTO workstation_repos (workstation_id, project_repo_id, local_path, reported_at)
       VALUES ($1,$2,'/tmp/stuck',now())`,
      [s.m.w.workstationId, id],
    );
    await q().query(
      `INSERT INTO pr_size_statuses (project_repo_id, change_id, head_sha, state, reason, description, post_state,
                                     status_id, updated_at)
       SELECT $1, g::text, $3, 'failure', 'over', 'Over budget', 'pending', gen_random_uuid(),
              timestamptz '2000-01-01' + g * interval '1 second'
         FROM generate_series(1, $2::int) g`,
      [id, count, sha(1)],
    );
    return id;
  }
  async function dropRepo(id: string) {
    await q().query('DELETE FROM pr_size_statuses WHERE project_repo_id=$1', [id]);
    await q().query('DELETE FROM workstation_repos WHERE project_repo_id=$1', [id]);
    await q().query('DELETE FROM project_repos WHERE id=$1', [id]);
  }

  it('more undeliverable pending statuses than one pass takes still let a deliverable one through', async () => {
    const stuck = await stuckRepo(205);
    try {
      await poll([{ n: 12, head: 'feature/a', base: 'main', lines: 700 }]);
      expect(await deliver()).toBe(1);
      const cmds = await commands();
      expect(cmds).toHaveLength(1);
      expect(cmds[0]?.payload).toMatchObject({ repoId: s.m.w.repoId, sha: sha(12), state: 'failure' });
      // the stuck statuses stay pending, untouched, for when a token for their host is saved
      const left = await q().query(
        `SELECT count(*)::int AS n FROM pr_size_statuses WHERE project_repo_id=$1 AND post_state='pending' AND attempts=0`,
        [stuck],
      );
      expect(left.rows[0]?.n).toBe(205);
      // once the workstation holds a token for that host, they are delivered too
      await q().query(
        `UPDATE workstations SET status_tokens='["github@github.com","github@ghe.example.com"]'::jsonb WHERE id=$1`,
        [s.m.w.workstationId],
      );
      expect(await deliver()).toBe(200);
    } finally {
      await dropRepo(stuck);
    }
  });

  it('two passes at once queue a status only once', async () => {
    await poll([{ n: 12, head: 'feature/a', base: 'main', lines: 700 }]);
    const sent = await Promise.all([deliver(), deliver(), deliver()]);
    expect(sent.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await commands()).toHaveLength(1);
    expect(await statusOf(12)).toMatchObject({ post_state: 'queued', attempts: 1 });
    // a later pass while the post is still in flight sends nothing again
    expect(await deliver()).toBe(0);
    expect(await commands()).toHaveLength(1);
  });

  it('a pass limited to another project sends nothing for this one', async () => {
    await poll([{ n: 12, head: 'feature/a', base: 'main', lines: 700 }]);
    expect(await deliverSizeStatuses(s.m.ctx(), { projectId: randomUUID() })).toBe(0);
    expect(await deliverSizeStatuses(s.m.ctx(), { projectId: s.m.w.projectId })).toBe(1);
  });
});

describe('the poll is widened to repositories with a size check', () => {
  it('lists a repository that is not PR-only when the project has a budget', async () => {
    await q().query(`UPDATE project_repos SET pr_only=false WHERE id=$1`, [s.m.w.repoId]);
    await q().query(`DELETE FROM pr_review_polls`);
    const r = await requestPrList(s.m.ctx(), s.m.w.repoId, { force: true });
    expect(r.queued).toBe(true);
  });
});
