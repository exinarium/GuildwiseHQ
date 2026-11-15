import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { followUpSweep } from '../src/commands/follow-up.ts';
import { ownerPendingSweep } from '../src/commands/owner-pending.ts';
import { sizeExceptionSweep } from '../src/commands/size-exception.ts';
import { closeAdminPool } from './helpers/db.ts';
import { sizeExceptionWorld } from './helpers/size-exception.ts';
import { ok } from './helpers/world.ts';

const push = vi.hoisted(() => vi.fn());
vi.mock('web-push', () => ({ default: { sendNotification: push, generateVAPIDKeys: () => ({}) } }));

/** GWP-210 AC4: no owner answer within 2 working days. The fake clock is pinned to fixed instants. Needs the test database. */
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
beforeEach(async () => {
  push.mockReset();
  await s.clean();
});
afterEach(() => {
  s.unpin();
  s.m.w.t.clock.setOffset(0);
});

const q = () => s.m.db();
const sweep = () => sizeExceptionSweep(s.m.ctx());

// 2030-03-01 is a Friday
describe('AC4: lapses after 2 working days, the author is told, the owner is not reminded', () => {
  it('Friday 15:00 lapses on Tuesday 15:00, not before (the weekend does not count)', async () => {
    s.pin('2030-03-01T15:00:00Z');
    const r = await s.request(await s.overBudgetPr(501, 900));
    expect(r.dueAt.toISOString()).toBe('2030-03-05T15:00:00.000Z');
    expect((await s.row(r.sizeExceptionId)).due_at.toISOString()).toBe('2030-03-05T15:00:00.000Z');
    for (const t of ['2030-03-04T15:00:00Z', '2030-03-05T14:59:00Z']) {
      s.pin(t);
      expect(await sweep()).toEqual({ lapsed: 0, withdrawn: 0 });
      expect((await s.row(r.sizeExceptionId)).state).toBe('pending');
    }
    s.pin('2030-03-05T15:00:00Z');
    expect(await sweep()).toEqual({ lapsed: 1, withdrawn: 0 });
    expect((await s.row(r.sizeExceptionId)).state).toBe('lapsed');
    expect(await s.prOf(501)).toMatchObject({ review_state: 'needs_split', split_reason: 'size_exception_lapsed' });
    expect((await s.notices()).at(-1)).toMatchObject({ state: 'pending' });
    expect((await s.deskItem(r.deskItemId)).status).not.toBe('open');
    // a second pass does nothing, and an answer after the lapse is refused
    expect(await sweep()).toEqual({ lapsed: 0, withdrawn: 0 });
    s.unpin();
    expect((await s.resolve(r.deskItemId, 'approved')).status).toBe(409);
  });

  it('Wednesday 10:00 lapses on Friday 10:00', async () => {
    s.pin('2030-03-06T10:00:00Z');
    const r = await s.request(await s.overBudgetPr(511, 900));
    s.pin('2030-03-08T09:59:00Z');
    expect((await sweep()).lapsed).toBe(0);
    s.pin('2030-03-08T10:00:00Z');
    expect((await sweep()).lapsed).toBe(1);
    expect((await s.row(r.sizeExceptionId)).state).toBe('lapsed');
  });

  it('a request on a Saturday counts from Monday 00:00', async () => {
    s.pin('2030-03-02T12:00:00Z');
    const r = await s.request(await s.overBudgetPr(521, 900));
    expect(r.dueAt.toISOString()).toBe('2030-03-06T00:00:00.000Z');
  });

  it("is counted on the owner's own calendar day: a time zone moves the due time", async () => {
    await q().query(`UPDATE users SET timezone='Pacific/Auckland' WHERE id=$1`, [s.m.w.owner.id]);
    s.pin('2030-03-06T10:00:00Z');
    const r = await s.request(await s.overBudgetPr(531, 900));
    expect(r.dueAt.toISOString()).toBe('2030-03-08T10:00:00.000Z');
    // Wednesday 23:00 UTC is already Thursday 12:00 in Auckland: due Monday 12:00 Auckland = Sunday 23:00 UTC
    const prId2 = await s.overBudgetPr(532, 900);
    s.pin('2030-03-06T23:00:00Z');
    const r2 = await s.request(prId2);
    expect(r2.dueAt.toISOString()).toBe('2030-03-10T23:00:00.000Z');
  });

  it('the owner gets no reminder of any kind, even with a 1-day follow-up window', async () => {
    await q().query(
      `INSERT INTO org_follow_up (org_id, days, changed_at) VALUES ($1, 1, now()) ON CONFLICT (org_id) DO UPDATE SET days=1`,
      [s.orgId],
    );
    s.pin('2030-03-01T15:00:00Z');
    const r = await s.request(await s.overBudgetPr(541, 900));
    for (const t of ['2030-03-02T16:00:00Z', '2030-03-04T15:00:00Z', '2030-03-05T14:00:00Z']) {
      s.pin(t);
      await followUpSweep(s.m.ctx());
      await ownerPendingSweep(s.m.ctx());
      await sweep();
    }
    s.pin('2030-03-05T15:00:00Z');
    await followUpSweep(s.m.ctx());
    await ownerPendingSweep(s.m.ctx());
    await sweep();
    await s.m.ctx().notifier.flush();
    expect(await s.events('DeskItemNudged')).toHaveLength(0);
    expect(await s.events('OwnerPendingReminded')).toHaveLength(0);
    expect((await q().query('SELECT 1 FROM owner_pending_timers')).rowCount).toBe(0);
    expect((await q().query(`SELECT 1 FROM desk_items WHERE subkind='owner_pending_reminder'`)).rowCount).toBe(0);
    expect((await q().query('SELECT 1 FROM desk_follow_ups WHERE desk_item_id=$1', [r.deskItemId])).rowCount).toBe(0);
    expect(push).not.toHaveBeenCalled();
    expect((await s.row(r.sizeExceptionId)).state).toBe('lapsed');
  });

  it('the author notice is delivered on the PR like any needs-split notice', async () => {
    s.pin('2030-03-01T15:00:00Z');
    await s.request(await s.overBudgetPr(551, 900));
    s.pin('2030-03-05T15:00:00Z');
    await sweep();
    const { deliverSplitNotices } = await import('../src/commands/pr-size-check.ts');
    // the notice of the first send-back is still waiting too: both are posted
    expect(await deliverSplitNotices(s.m.ctx())).toBeGreaterThanOrEqual(1);
    expect((await s.notices()).filter((n) => n.state === 'queued').length).toBeGreaterThanOrEqual(1);
  });

  it('a lapsed request where the PR was split meanwhile gives no notice', async () => {
    s.pin('2030-03-01T15:00:00Z');
    const r = await s.request(await s.overBudgetPr(561, 900));
    await q().query(`UPDATE pr_open_changes SET changed_lines=100 WHERE project_repo_id=$1`, [s.m.w.repoId]);
    const before = (await s.notices()).length;
    s.pin('2030-03-05T15:00:00Z');
    await sweep();
    expect((await s.row(r.sizeExceptionId)).state).toBe('lapsed');
    expect((await s.notices()).length).toBe(before);
  });

  it('the sweep also withdraws a request whose PR closed', async () => {
    s.pin('2030-03-01T15:00:00Z');
    const prId = await s.overBudgetPr(571, 900);
    const r = await s.request(prId);
    await q().query(`UPDATE pr_reviews SET closed_at=now() WHERE id=$1`, [prId]);
    expect(await sweep()).toEqual({ lapsed: 0, withdrawn: 1 });
    expect((await s.row(r.sizeExceptionId)).state).toBe('withdrawn');
    void ok;
  });
});
