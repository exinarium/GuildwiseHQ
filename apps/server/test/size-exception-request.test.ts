import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ACTIONS } from '../src/ceo/registry.ts';
import { closeAdminPool } from './helpers/db.ts';
import { REASON, sizeExceptionWorld } from './helpers/size-exception.ts';

/** GWP-210 AC1 and AC5: raising a size exception request, and refusing one without a reason. Needs the test database. */
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

describe('AC1: the owner sees a desk item with the reason and the size against the budget', () => {
  it('creates an approval item for the project owner and marks the PR as waiting', async () => {
    const prId = await s.overBudgetPr(301, 900);
    const r = await s.request(prId);
    const item = await s.deskItem(r.deskItemId);
    expect(item).toMatchObject({ kind: 'approval', subkind: 'size_exception', status: 'open' });
    expect(item.addressee_user_id).toBe(s.m.w.owner.id);
    expect(item.body).toContain(REASON);
    expect(item.data).toMatchObject({ reason: REASON, size: 900, budget: 600, unit: 'changed_lines' });
    expect((await s.prOf(301)).review_state).toBe('size_exception_pending');
    expect(await s.row(r.sizeExceptionId)).toMatchObject({
      state: 'pending',
      size: 900,
      budget: 600,
      reason: REASON,
    });
    // a poll leaves a pending request alone
    await s.poll([{ n: 301, head: 'big/301', base: 'main', lines: 900 }]);
    expect((await s.prOf(301)).review_state).toBe('size_exception_pending');
  });

  it('covers the whole chain of stacked PRs', async () => {
    await s.poll([
      { n: 311, head: 'st/a', base: 'main', lines: 300 },
      { n: 312, head: 'st/b', base: 'st/a', lines: 400 },
    ]);
    const r = await s.request((await s.prOf(311)).id);
    expect((await s.prOf(311)).review_state).toBe('size_exception_pending');
    expect((await s.prOf(312)).review_state).toBe('size_exception_pending');
    expect((await s.row(r.sizeExceptionId)).chain_pr_review_ids).toHaveLength(2);
  });

  it('is shown on the Pull requests list and in the history route', async () => {
    const prId = await s.overBudgetPr(321, 700);
    const r = await s.request(prId);
    const list = (await s.m.list()) as any[];
    expect(list.find((p) => p.id === prId)).toMatchObject({
      state: 'size_exception_pending',
      sizeException: { id: r.sizeExceptionId, state: 'pending', size: 700 },
    });
    const res = await s.m.w.t.req('GET', `/api/projects/${s.m.w.projectId}/size-exceptions`, {
      cookie: s.m.w.owner.cookie,
    });
    expect(res.status).toBe(200);
    expect((res.body as any).sizeExceptions[0]).toMatchObject({
      id: r.sizeExceptionId,
      reason: REASON,
      state: 'pending',
    });
  });

  it('the request can be found by the PR address', async () => {
    await s.overBudgetPr(331, 800);
    const r = await s.request('https://github.com/acme/toy/pull/331');
    expect(await s.row(r.sizeExceptionId)).toMatchObject({ state: 'pending' });
  });
});

describe('AC5: a request without a reason is refused', () => {
  it.each([
    ['empty', ''],
    ['blank', '                      '],
    ['too short', 'too big, sorry'],
  ])('refuses a reason that is %s: nothing is written', async (_n, reason) => {
    const prId = await s.overBudgetPr(341, 900);
    const events = (await s.events('SizeExceptionRequested')).length;
    await expect(s.request(prId, reason)).rejects.toMatchObject({ status: 400 });
    expect((await s.prOf(341)).review_state).toBe('needs_split');
    expect((await s.events('SizeExceptionRequested')).length).toBe(events);
    expect((await q().query(`SELECT 1 FROM desk_items WHERE subkind='size_exception'`)).rowCount).toBe(0);
  });

  it('the CEO action refuses it in its schema', () => {
    const def = ACTIONS['size-exception'];
    expect(def?.schema.safeParse({ pr: 'x' }).success).toBe(false);
    expect(def?.schema.safeParse({ pr: 'x', text: 'short' }).success).toBe(false);
    expect(def?.schema.safeParse({ pr: 'x', text: REASON }).success).toBe(true);
  });
});

describe('what may be asked for', () => {
  it('refuses a PR that is not sent back for its size, a second open request and an unknown PR', async () => {
    await s.poll([{ n: 351, head: 'small', base: 'main', lines: 100 }]);
    await expect(s.request((await s.prOf(351)).id)).rejects.toMatchObject({
      status: 409,
      code: 'not_over_budget',
    });
    const prId = await s.overBudgetPr(352, 900);
    await s.request(prId);
    await expect(s.request(prId)).rejects.toMatchObject({ status: 409, code: 'already_pending' });
    await expect(s.request('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ status: 404 });
  });

  it('a member who is not the owner cannot decide it', async () => {
    const prId = await s.overBudgetPr(361, 900);
    const r = await s.request(prId);
    const member = await s.m.addMember('manager');
    const res = await s.resolve(r.deskItemId, 'approved', undefined, member.cookie);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await s.row(r.sizeExceptionId)).state).toBe('pending');
  });

  it('the CEO action asks the owner, and refuses a PR that is not sent back', async () => {
    const def = ACTIONS['size-exception'];
    const prId = await s.overBudgetPr(371, 900);
    const env = { ctx: s.m.ctx(), orgId: s.orgId, agentId: undefined } as never;
    const prep = await def?.prepare(env, { pr: prId, text: REASON });
    expect(prep?.refuse).toBeUndefined();
    const done = await def?.execute(env, { pr: prId, text: REASON }, prep as never);
    expect(done?.message).toContain('Asked the owner');
    expect((await s.prOf(371)).review_state).toBe('size_exception_pending');
    const again = await def?.prepare(env, { pr: prId, text: REASON });
    expect(again?.refuse).toContain('already open');
  });
});
