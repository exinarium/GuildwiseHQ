import { randomUUID } from 'node:crypto';
import { PR_NOTICE_CAPABILITY } from '@aom/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ownerPendingSweep } from '../src/commands/owner-pending.ts';
import { applyPrListResult } from '../src/commands/pr-only.ts';
import { sweepStalePrReviewRuns } from '../src/commands/pr-review-runs.ts';
import { deliverSplitNotices } from '../src/commands/pr-size-check.ts';
import { closeAdminPool } from './helpers/db.ts';
import { manualWorld } from './helpers/pr-review-manual.ts';

/**
 * GWP-209: the PR size check. AC1 chain sum, AC2 single PR over budget, AC3 first timeout within budget, AC4 second
 * timeout over budget, AC5 second timeout within budget. Needs the test database (127.0.0.1:5433).
 */

let m: Awaited<ReturnType<typeof manualWorld>>;
beforeAll(async () => {
  m = await manualWorld();
  await m
    .db()
    .query(
      `UPDATE workstation_capabilities SET capabilities = capabilities || $2::text[] WHERE workstation_id=$1`,
      [m.w.workstationId, [PR_NOTICE_CAPABILITY]],
    );
});
afterAll(async () => {
  m.w.t.clock.setOffset(0);
  m.r.close();
  await m.w.t.close();
  await closeAdminPool();
});
beforeEach(async () => {
  await m.clean();
  const q = m.db();
  await q.query('DELETE FROM pr_split_notices');
  await q.query('DELETE FROM pr_open_changes');
  await q.query('DELETE FROM owner_pending_timers');
  await q.query(
    `DELETE FROM desk_items WHERE subkind IN ('pr_review_timed_out_twice','owner_pending_reminder')`,
  );
  await q.query(`DELETE FROM runner_commands WHERE type='pr_review.notice'`);
  await setBudget(600);
});
afterEach(() => m.w.t.clock.setOffset(0));

const q = () => m.db();
const setBudget = (budget: number | null) =>
  q().query(`UPDATE projects SET size_budget=$2, size_unit=$3 WHERE id=$1`, [
    m.w.projectId,
    budget,
    budget === null ? null : 'changed_lines',
  ]);
const deskCount = async () =>
  Number(
    (await q().query(`SELECT count(*)::int AS n FROM desk_items WHERE project_id=$1`, [m.w.projectId]))
      .rows[0].n,
  );
const stateOf = async (id: string) =>
  (await q().query('SELECT review_state, attention, split_reason FROM pr_reviews WHERE id=$1', [id])).rows[0];

/** The git host's answer to `repo.list_prs`, fed through the same path the runner's answer takes. */
async function poll(
  list: Array<{ n: number; head: string; base: string; lines: number | null }>,
  complete = true,
) {
  const requestId = randomUUID();
  await q().query(
    `INSERT INTO pr_review_polls (project_repo_id, request_id, workstation_id, state, requested_at)
     VALUES ($1,$2,$3,'pending',now())
     ON CONFLICT (project_repo_id) DO UPDATE SET request_id=EXCLUDED.request_id, state='pending'`,
    [m.w.repoId, requestId, m.w.workstationId],
  );
  await applyPrListResult(
    m.ctx(),
    { requestId, repoId: m.w.repoId },
    true,
    {
      ok: true,
      complete,
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
      })),
    },
    undefined,
  );
}
const byChange = async () =>
  new Map(
    (
      await q().query(`SELECT id, change_id, review_state FROM pr_reviews WHERE project_repo_id=$1`, [
        m.w.repoId,
      ])
    ).rows.map((r) => [r.change_id as string, r as { id: string; review_state: string }]),
  );

/** Delivers the pending notices and answers each one as the runner would. */
async function deliverAndAnswer(result: unknown = undefined) {
  const count = async () =>
    Number(
      (await q().query(`SELECT count(*)::int AS n FROM runner_commands WHERE type='pr_review.notice'`))
        .rows[0].n,
    );
  const from = m.r.received.length;
  const had = await count();
  await deliverSplitNotices(m.ctx());
  const sent = (await count()) - had;
  const notices = () =>
    m.r.received.slice(from).filter((f: any) => f.command === 'pr_review.notice') as any[];
  for (let i = 0; i < 100 && notices().length < sent; i++) await new Promise((r) => setTimeout(r, 30));
  const cmds = notices();
  for (const cmd of cmds) {
    m.r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: result ?? {
        ok: true,
        reviewUrl: `https://github.com/acme/toy/pull/${cmd.payload.prNumber}#review-1`,
        alreadyPosted: false,
      },
    });
  }
  await m.r.barrier();
  await m.ctx().notifier.flush();
  return cmds;
}

/** Seeds the open-list snapshot for a recorded PR (the timeout tests need a size, not a poll). */
async function sizeOf(prId: string, lines: number | null) {
  const n = Number(
    (await q().query('SELECT change_id FROM pr_reviews WHERE id=$1', [prId])).rows[0].change_id,
  );
  await snapshot([{ n, head: `feature/${n}`, base: 'main', lines }]);
}

/** Seeds the open-list snapshot directly. */
async function snapshot(rows: Array<{ n: number; head: string; base: string; lines: number | null }>) {
  for (const c of rows)
    await q().query(
      `INSERT INTO pr_open_changes (project_repo_id, change_id, head_branch, base_branch, cross_repo, changed_lines, changed_files, seen_at)
       VALUES ($1,$2,$3,$4,false,$5,2,now())`,
      [m.w.repoId, String(c.n), c.head, c.base, c.lines],
    );
}

describe('AC1: stacked PRs are summed', () => {
  it('300 + 400 against a budget of 600: both are needs-split and each author is notified', async () => {
    const before = await deskCount();
    await poll([
      { n: 201, head: 'stack/a', base: 'main', lines: 300 },
      { n: 202, head: 'stack/b', base: 'stack/a', lines: 400 },
    ]);
    const prs = await byChange();
    expect(prs.get('201')?.review_state).toBe('needs_split');
    expect(prs.get('202')?.review_state).toBe('needs_split');
    expect((await stateOf(prs.get('201')?.id as string)).split_reason).toBe('over_budget');

    const cmds = await deliverAndAnswer();
    expect(cmds.map((c) => c.payload.prNumber).sort()).toEqual([201, 202]);
    expect(cmds[0].payload.body).toContain('700');
    expect(cmds[0].payload.body).toContain('<!-- size-check:');
    const notices = (await q().query('SELECT state FROM pr_split_notices')).rows;
    expect(notices.map((n) => n.state)).toEqual(['posted', 'posted']);
    const dto = await m.prOf(prs.get('201')?.id as string);
    expect(dto).toMatchObject({
      state: 'needs_split',
      split: { total: 700, budget: 600, notice: { state: 'posted' } },
    });
    expect(dto.manualAction).toBeNull();
    expect(await deskCount()).toBe(before);
  });

  it('two unrelated PRs of 300 and 400 are not a chain', async () => {
    await poll([
      { n: 211, head: 'x/a', base: 'main', lines: 300 },
      { n: 212, head: 'x/b', base: 'main', lines: 400 },
    ]);
    const prs = await byChange();
    expect([...prs.values()].map((p) => p.review_state)).toEqual(['not_reviewed', 'not_reviewed']);
  });
});

describe('AC2: a single PR over budget goes back to its author, no owner item', () => {
  it('is needs-split, notified once, never starts a run, and is reviewable again when it shrinks', async () => {
    const before = await deskCount();
    await poll([{ n: 221, head: 'big', base: 'main', lines: 650 }]);
    const pr = (await byChange()).get('221') as { id: string };
    expect((await stateOf(pr.id)).review_state).toBe('needs_split');
    expect((await m.trigger(pr.id)).status).toBe(409);
    await deliverAndAnswer();
    // a second pass sends nothing more
    expect(await deliverAndAnswer()).toHaveLength(0);
    expect(
      (await q().query(`SELECT count(*)::int AS n FROM pr_split_notices WHERE state='posted'`)).rows[0].n,
    ).toBe(1);
    expect(await deskCount()).toBe(before);

    await poll([{ n: 221, head: 'big', base: 'main', lines: 600 }]);
    expect((await stateOf(pr.id)).review_state).toBe('not_reviewed');
  });

  it('is inactive without a size budget', async () => {
    await setBudget(null);
    await poll([{ n: 231, head: 'big', base: 'main', lines: 5000 }]);
    expect((await byChange()).get('231')?.review_state).toBe('not_reviewed');
  });

  it('a notice that fails is kept with its error and tried again later, at most 3 times', async () => {
    await poll([{ n: 241, head: 'big', base: 'main', lines: 650 }]);
    await deliverAndAnswer({ ok: false, code: 'unreachable', error: 'offline' });
    expect(
      (await q().query('SELECT state, error_code, attempts FROM pr_split_notices')).rows[0],
    ).toMatchObject({
      state: 'failed',
      error_code: 'unreachable',
      attempts: 1,
    });
    // not before 15 minutes
    expect(await deliverAndAnswer()).toHaveLength(0);
    m.w.t.clock.setOffset(16 * 60_000);
    expect(await deliverAndAnswer()).toHaveLength(1);
    expect((await q().query('SELECT state FROM pr_split_notices')).rows[0].state).toBe('posted');
  });
});

/** Starts a run for the PR, runs it to a timeout through the runner's answer, and returns the run id. */
async function timeOut(prId: string, by: 'trigger' | 'auto' = 'trigger') {
  const from = m.r.received.length;
  if (by === 'trigger') expect((await m.trigger(prId)).status).toBe(200);
  const cmd: any = await m.r.waitFor('command', (f: any) => f.command === 'pr_review.run', 5000, from);
  await m.r.barrier();
  m.r.send('command.result', {
    commandId: cmd.commandId,
    ok: true,
    result: { outcome: 'timeout', durationMs: 600_000, phase: 'review' },
  });
  await m.r.barrier();
  await m.ctx().notifier.flush();
  return cmd.payload.runId as string;
}

describe('AC3: a first timeout within budget leaves the PR not reviewed', () => {
  it('is not sent back and nobody is told', async () => {
    const pr = await m.addPr();
    await sizeOf(pr, 100);
    const before = await deskCount();
    await m.addRun(pr, { state: 'timed_out', code: 'timeout' }); // the earlier run (an automatic one)
    await q().query(`UPDATE pr_review_runs SET state='failed' WHERE pr_review_id=$1`, [pr]);
    await timeOut(pr);
    // the owner's "Review now" after a failure is a first timeout here
    expect(await stateOf(pr)).toMatchObject({ review_state: 'not_reviewed', attention: null });
    expect(await deskCount()).toBe(before);
    expect((await q().query('SELECT count(*)::int AS n FROM pr_split_notices')).rows[0].n).toBe(0);
  });

  it('over budget, even the first timeout sends it back (the size check decides)', async () => {
    const pr = await m.addPr();
    await sizeOf(pr, 900);
    await timeOut(pr);
    expect(await stateOf(pr)).toMatchObject({
      review_state: 'needs_split',
      split_reason: 'timeout_over_budget',
    });
  });
});

describe('AC4: a second timeout over budget goes to needs-split at once', () => {
  it('after an owner re-run, with no poll in between', async () => {
    const pr = await m.addPr();
    await m.addRun(pr, { state: 'timed_out', code: 'timeout', agoMin: 60 });
    await sizeOf(pr, 900);
    const before = await deskCount();
    await timeOut(pr);
    expect(await stateOf(pr)).toMatchObject({
      review_state: 'needs_split',
      split_reason: 'second_timeout_over_budget',
    });
    expect(await deskCount()).toBe(before);
    await deliverAndAnswer();
    expect((await q().query('SELECT state FROM pr_split_notices')).rows[0].state).toBe('posted');
  });

  it('the server backstop times out a lost re-run the same way', async () => {
    const pr = await m.addPr();
    await m.addRun(pr, { state: 'timed_out', code: 'timeout', agoMin: 120 });
    const second = await m.addRun(pr, { state: 'running', trigger: 'manual', agoMin: 90 });
    await q().query(
      'UPDATE pr_review_runs SET rerun_of_run_id=(SELECT id FROM pr_review_runs WHERE pr_review_id=$1 AND state=$2) WHERE id=$3',
      [pr, 'timed_out', second],
    );
    await sizeOf(pr, 900);
    expect(await sweepStalePrReviewRuns(m.ctx())).toBe(1);
    expect(await stateOf(pr)).toMatchObject({
      review_state: 'needs_split',
      split_reason: 'second_timeout_over_budget',
    });
  });
});

describe('AC5: a second timeout within budget tells the owner', () => {
  it('stays not reviewed, raises one item with the 2-working-day reminder, and acting on it resolves the timer', async () => {
    const pr = await m.addPr();
    await m.addRun(pr, { state: 'timed_out', code: 'timeout', agoMin: 60 });
    await sizeOf(pr, 100);
    await timeOut(pr);

    expect(await stateOf(pr)).toMatchObject({ review_state: 'not_reviewed', attention: 'timed_out_twice' });
    const items = (
      await q().query(`SELECT id, status, kind FROM desk_items WHERE subkind='pr_review_timed_out_twice'`)
    ).rows;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ status: 'open', kind: 'alert' });
    const dto = await m.prOf(pr);
    expect(dto).toMatchObject({ state: 'not_reviewed', attention: 'timed_out_twice' });
    expect(dto.reminder.remindedAt).toBeNull();
    const timer = (await q().query(`SELECT status, due_at, started_at, kind FROM owner_pending_timers`)).rows;
    expect(timer).toHaveLength(1);
    expect(timer[0]).toMatchObject({ kind: 'second_timeout', status: 'open' });

    // not reminded yet; after 2 working days the reminder comes and the state is unchanged
    expect(await ownerPendingSweep(m.ctx())).toEqual({ reminded: 0 });
    m.w.t.clock.setOffset(5 * 24 * 3_600_000);
    expect((await ownerPendingSweep(m.ctx())).reminded).toBe(1);
    expect(await stateOf(pr)).toMatchObject({ review_state: 'not_reviewed', attention: 'timed_out_twice' });
    m.w.t.clock.setOffset(0);

    // the owner leaves it: the item closes and the timer resolves
    const res = await m.w.t.req('POST', `/api/desk/${items[0].id}/resolve`, {
      cookie: m.w.owner.cookie,
      body: { resolution: 'acknowledged' },
    });
    expect(res.status).toBe(200);
    expect((await q().query(`SELECT status FROM owner_pending_timers`)).rows[0].status).toBe('resolved');
    expect((await stateOf(pr)).attention).toBeNull();
  });

  it('without a size check the owner still gets the item, and the reason says so', async () => {
    await setBudget(null);
    const pr = await m.addPr();
    await m.addRun(pr, { state: 'timed_out', code: 'timeout', agoMin: 60 });
    await timeOut(pr);
    expect(await stateOf(pr)).toMatchObject({ review_state: 'not_reviewed', attention: 'timed_out_twice' });
    const body = (await q().query(`SELECT body FROM desk_items WHERE subkind='pr_review_timed_out_twice'`))
      .rows[0].body as string;
    expect(body).toMatch(/inactive/);
  });

  it('a new re-run by the owner resolves the item, and a first timeout raises none', async () => {
    const pr = await m.addPr();
    await m.addRun(pr, { state: 'timed_out', code: 'timeout', agoMin: 60 });
    await sizeOf(pr, 100);
    await timeOut(pr);
    expect(
      (await q().query(`SELECT count(*)::int AS n FROM owner_pending_timers WHERE status='open'`)).rows[0].n,
    ).toBe(1);
    expect((await m.trigger(pr)).status).toBe(200);
    expect(
      (await q().query(`SELECT count(*)::int AS n FROM owner_pending_timers WHERE status='open'`)).rows[0].n,
    ).toBe(0);
    expect(
      (await q().query(`SELECT status FROM desk_items WHERE subkind='pr_review_timed_out_twice'`)).rows[0]
        .status,
    ).not.toBe('open');
    expect((await stateOf(pr)).attention).toBeNull();
  });
});
