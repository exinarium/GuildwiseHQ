import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sizeExemptionOf } from '../src/commands/size-exception.ts';
import { closeAdminPool } from './helpers/db.ts';
import { REASON, sizeExceptionWorld } from './helpers/size-exception.ts';
import { ok } from './helpers/world.ts';

/** GWP-210 AC2 and AC3: the owner approves or rejects; requirement 4: the history. Needs the test database. */
let s: Awaited<ReturnType<typeof sizeExceptionWorld>>;
beforeAll(async () => {
  s = await sizeExceptionWorld();
});
afterAll(async () => {
  s.m.w.t.clock.setOffset(0);
  s.m.r.close();
  await s.m.w.t.close();
  await closeAdminPool();
});
beforeEach(() => s.clean());
afterEach(() => {
  s.unpin();
  s.m.w.t.clock.setOffset(0);
});

const q = () => s.m.db();

describe('AC2: approved, the PR is an approved exception and is not sent to needs-split', () => {
  it('goes back to not reviewed, and the next poll does not send it back', async () => {
    const prId = await s.overBudgetPr(401, 900);
    const r = await s.request(prId);
    await ok(s.resolve(r.deskItemId, 'approved', 'fine for the generated code'));
    expect(await s.row(r.sizeExceptionId)).toMatchObject({
      state: 'approved',
      decided_by: s.m.w.owner.id,
      note: 'fine for the generated code',
    });
    expect((await s.prOf(401)).review_state).toBe('not_reviewed');
    expect((await s.deskItem(r.deskItemId)).status).not.toBe('open');
    const needsSplit = (await s.events('PrReviewNeedsSplit')).length;
    // the poll runs the size check again: the PR is still over budget, but covered
    await s.poll([{ n: 401, head: 'big/401', base: 'main', lines: 900 }]);
    expect((await s.prOf(401)).review_state).toBe('not_reviewed');
    expect((await s.events('PrReviewNeedsSplit')).length).toBe(needsSplit);
    expect(await sizeExemptionOf(q(), prId, 900)).toMatchObject({ id: r.sizeExceptionId, size: 900 });
    const dto = ((await s.m.list()) as any[]).find((p) => p.id === prId);
    expect(dto.sizeException).toMatchObject({ state: 'approved', size: 900 });
  });

  it('a timeout of the approved PR does not send it back either (the second exemption hook)', async () => {
    const prId = await s.overBudgetPr(411, 900);
    const r = await s.request(prId);
    await ok(s.resolve(r.deskItemId, 'approved'));
    const { onPrReviewTimedOut } = await import('../src/commands/pr-size-check.ts');
    const { withAppendTx } = await import('../src/db/tx.ts');
    const run = await s.m.addRun(prId, { state: 'timed_out', code: 'timeout' });
    await q().query(`UPDATE pr_review_runs SET state='timed_out' WHERE id=$1`, [run]);
    const before = (await s.events('PrReviewNeedsSplit')).length;
    await withAppendTx(s.m.ctx().pool, async (tx) => {
      const row = (await tx.query('SELECT * FROM pr_review_runs WHERE id=$1', [run])).rows[0];
      await onPrReviewTimedOut(s.m.ctx(), tx, row);
    });
    expect((await s.prOf(411)).review_state).toBe('not_reviewed');
    expect((await s.events('PrReviewNeedsSplit')).length).toBe(before);
  });

  it('holds only up to the approved size: a bigger PR is sent back and the exception is superseded', async () => {
    const prId = await s.overBudgetPr(421, 900);
    const r = await s.request(prId);
    await ok(s.resolve(r.deskItemId, 'approved'));
    await s.poll([{ n: 421, head: 'big/421', base: 'main', lines: 950 }]);
    expect((await s.prOf(421)).review_state).toBe('needs_split');
    expect((await s.row(r.sizeExceptionId)).state).toBe('superseded');
    expect(await sizeExemptionOf(q(), prId)).toBeNull();
  });

  it('a smaller PR stays covered', async () => {
    const prId = await s.overBudgetPr(431, 900);
    const r = await s.request(prId);
    await ok(s.resolve(r.deskItemId, 'approved'));
    await s.poll([{ n: 431, head: 'big/431', base: 'main', lines: 700 }]);
    expect((await s.prOf(431)).review_state).toBe('not_reviewed');
    expect((await s.row(r.sizeExceptionId)).state).toBe('approved');
  });
});

describe('AC3: rejected, the PR is needs-split and its author is notified', () => {
  it('marks it needs-split with the new reason and creates the author notice', async () => {
    const prId = await s.overBudgetPr(441, 900);
    const r = await s.request(prId);
    const oldNotices = (await s.notices()).length;
    await ok(s.resolve(r.deskItemId, 'rejected', 'please split it'));
    expect(await s.row(r.sizeExceptionId)).toMatchObject({ state: 'rejected', note: 'please split it' });
    expect(await s.prOf(441)).toMatchObject({
      review_state: 'needs_split',
      split_reason: 'size_exception_rejected',
    });
    const notices = await s.notices();
    expect(notices.length).toBe(oldNotices + 1);
    expect(notices.at(-1)).toMatchObject({ state: 'pending', pr_review_id: prId });
    // the notice body says why
    const { splitNoticeBody } = await import('@aom/shared');
    expect(
      splitNoticeBody({
        unit: 'changed_lines',
        budget: 600,
        total: 900,
        members: [],
        self: '441',
        noticeId: 'n',
        reason: 'size_exception_rejected',
      }),
    ).toContain('size exception');
    // and it cannot be answered twice
    expect((await s.resolve(r.deskItemId, 'approved')).status).toBe(409);
  });

  it('a PR split meanwhile gets no notice and is cleared by the next poll', async () => {
    const prId = await s.overBudgetPr(451, 900);
    const r = await s.request(prId);
    // the author split the PR while the request was open: the stored list is within budget now
    await q().query(`UPDATE pr_open_changes SET changed_lines=300 WHERE project_repo_id=$1`, [s.m.w.repoId]);
    const oldNotices = (await s.notices()).length;
    await ok(s.resolve(r.deskItemId, 'rejected'));
    expect((await s.notices()).length).toBe(oldNotices);
    expect((await s.prOf(451)).review_state).toBe('needs_split');
    await s.poll([{ n: 451, head: 'big/451', base: 'main', lines: 300 }]);
    expect((await s.prOf(451)).review_state).toBe('not_reviewed');
  });

  it('refuses a new request at the same size, and accepts it when the PR grew', async () => {
    const prId = await s.overBudgetPr(461, 900);
    const r = await s.request(prId);
    await ok(s.resolve(r.deskItemId, 'rejected'));
    await expect(s.request(prId)).rejects.toMatchObject({ status: 409, code: 'already_decided' });
    await s.poll([{ n: 461, head: 'big/461', base: 'main', lines: 1000 }]);
    expect((await s.request(prId)).sizeExceptionId).toBeTruthy();
  });

  it('acknowledge and dismiss are refused: it is approved or rejected', async () => {
    const prId = await s.overBudgetPr(471, 900);
    const r = await s.request(prId);
    expect((await s.resolve(r.deskItemId, 'acknowledged')).status).toBe(400);
    expect(
      (
        await s.m.w.t.req('POST', `/api/desk/${r.deskItemId}/dismiss`, {
          cookie: s.m.w.owner.cookie,
          body: {},
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect((await s.row(r.sizeExceptionId)).state).toBe('pending');
  });
});

describe('closing the PR, and the history', () => {
  it('closing the PR while the request waits withdraws it and closes the owner item', async () => {
    const prId = await s.overBudgetPr(481, 900);
    const r = await s.request(prId);
    await s.poll([]);
    expect((await s.row(r.sizeExceptionId)).state).toBe('withdrawn');
    expect((await s.deskItem(r.deskItemId)).status).not.toBe('open');
  });

  it('lists approved, rejected requests with their reasons, newest first', async () => {
    const a = await s.request(await s.overBudgetPr(491, 900));
    await ok(s.resolve(a.deskItemId, 'approved'));
    const b = await s.request(await s.overBudgetPr(492, 900));
    await ok(s.resolve(b.deskItemId, 'rejected'));
    const all = (
      await ok<any>(
        s.m.w.t.req('GET', `/api/projects/${s.m.w.projectId}/size-exceptions`, {
          cookie: s.m.w.owner.cookie,
        }),
      )
    ).sizeExceptions;
    expect(all.map((e: any) => e.state)).toEqual(['rejected', 'approved']);
    expect(all.every((e: any) => e.reason === REASON)).toBe(true);
    const only = (
      await ok<any>(
        s.m.w.t.req('GET', `/api/projects/${s.m.w.projectId}/size-exceptions?state=approved`, {
          cookie: s.m.w.owner.cookie,
        }),
      )
    ).sizeExceptions;
    expect(only).toHaveLength(1);
  });
});
