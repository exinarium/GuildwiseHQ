import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { cardRow, eventsOfType, hireTeam, pipeline, testFail, testPass } from './helpers/pipeline.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
let p: ReturnType<typeof pipeline>;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
  p = pipeline(w, r);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const desk = () => ok<any>(w.t.req('GET', '/api/desk', { cookie: w.owner.cookie }));
const regression = (platform: string, projectId = w.projectId, status = 201, cookie = w.owner.cookie) =>
  ok<any>(w.t.req('POST', `/api/projects/${projectId}/regression`, { cookie, body: { platform } }), status);

/** Finalizes a small card through the real endpoint and returns the spawned suite card. */
async function finalizedWithSuite() {
  await freshState();
  await hireTeam(w);
  const card = await w.card({ title: 'Shipped feature' });
  await p.toTest('Bea', ['Rex']);
  await p.run('Tess', testPass());
  const from = r.received.length;
  await ok(w.t.req('POST', `/api/cards/${card.id}/finalize`, { cookie: w.owner.cookie, body: {} }));
  const cmd = await r.waitFor('command', (f) => f.command === 'finalize.execute', 5000, from);
  r.send('command.result', {
    commandId: cmd.commandId,
    ok: true,
    result: { ok: true, action: 'merge', mergeCommit: 'a1b2c3d' },
  });
  await until(async () => (await cardRow(card.id)).status === 'done', 3000, 'finalized');
  const suite = (
    await q('SELECT * FROM cards WHERE parent_card_id=$1 AND origin=$2', [card.id, 'full_suite'])
  )[0]!;
  return { card, suite: suite! };
}

describe('full suite after finalize', () => {
  it('a tester claims the suite card on the resulting branch; green ends it and removes the throwaway worktree', async () => {
    const { suite } = await finalizedWithSuite();
    const run = await p.run('Tess', testPass('suite green: 40 passed'));
    expect(run.start.brief.card.ref).toBe(suite.ref);
    expect(run.start.worktree).toMatchObject({ mode: 'create', baseBranch: 'main' });
    expect(run.start.prepare.rebase).toBe(true);
    expect(await cardRow(suite.id)).toMatchObject({ stage: 'done', status: 'done' });
    const runs = await q('SELECT kind, result FROM test_runs WHERE card_id=$1', [suite.id]);
    expect(runs).toEqual([{ kind: 'full_suite', result: 'passed' }]);
    const passed = (await eventsOfType('FullSuitePassed')).filter((e) => e.suiteCardId === suite.id);
    expect(passed).toHaveLength(1);
    const wt = await r.waitFor(
      'command',
      (f) =>
        f.command === 'worktree.remove' &&
        f.payload.deleteBranch === true &&
        String(f.payload.path).includes(suite.ref),
    );
    expect(wt).toBeTruthy();
  });

  it('a failure creates a bug card in Spec and a desk notice, without blocking anything', async () => {
    const { card, suite } = await finalizedWithSuite();
    await p.run('Tess', testFail('Checkout total is wrong', '2 failed'));
    // the suite card is simply done; the finalized card is untouched
    expect(await cardRow(suite.id)).toMatchObject({ stage: 'done', status: 'done' });
    expect(await cardRow(card.id)).toMatchObject({ stage: 'done', status: 'done' });
    const bug = (
      await q(`SELECT * FROM cards WHERE card_type='bug' AND origin='full_suite' AND parent_card_id=$1`, [
        suite.id,
      ])
    )[0]!;
    expect(bug).toMatchObject({ stage: 'spec', status: 'draft', title: 'Checkout total is wrong' });
    expect(bug.fields.context).toContain('Expected redirect');
    const failed = (await eventsOfType('FullSuiteFailed')).filter((e) => e.suiteCardId === suite.id);
    expect(failed).toHaveLength(1);
    const reported = (await eventsOfType('BugReported')).filter((e) => e.bugCardId === bug.id);
    expect(reported[0]).toMatchObject({ suiteCardId: suite.id, title: 'Checkout total is wrong' });
    const item = (await desk()).items.find((i: any) => i.subkind === 'bug_reported');
    expect(item).toMatchObject({ kind: 'alert', blocking: false, status: 'open' });
    expect(item.card.ref).toBe(bug.ref);
    // nothing is blocked
    expect(await q(`SELECT 1 FROM cards WHERE status IN ('blocked','waiting')`)).toHaveLength(0);
    expect(await q(`SELECT 1 FROM card_blockers`)).toHaveLength(0);
    const runs = await q('SELECT kind, result FROM test_runs WHERE card_id=$1', [suite.id]);
    expect(runs).toEqual([{ kind: 'full_suite', result: 'failed' }]);
  });
});

describe('regression runs', () => {
  it('web, mobile or both create one regression card per platform, queued for testers', async () => {
    await freshState();
    await hireTeam(w);
    const both = await regression('both');
    expect(both.cards.map((c: any) => c.platform)).toEqual(['web', 'mobile']);
    const rows = await q(`SELECT * FROM cards WHERE origin='regression' ORDER BY number`);
    expect(rows.map((c) => [c.card_type, c.stage, c.status, c.fields.platform])).toEqual([
      ['regression', 'test', 'queued', 'web'],
      ['regression', 'test', 'queued', 'mobile'],
    ]);
    const ev = await eventsOfType('RegressionRequested');
    expect(ev.at(-1)).toMatchObject({ platform: 'both', projectId: w.projectId });
    expect(ev.at(-1).regressionCardIds).toHaveLength(2);

    const run = await p.run('Tess', testPass('web regression green'));
    expect(run.start.brief.card.cardType).toBe('regression');
    expect(run.start.brief.card.fields.platform).toBe('web');
    const done = await q(`SELECT kind, platform, result FROM test_runs`);
    expect(done).toEqual([{ kind: 'regression', platform: 'web', result: 'passed' }]);

    await p.run('Tess', testFail('Mobile menu overlaps'));
    expect(await q(`SELECT 1 FROM cards WHERE card_type='bug' AND origin='regression'`)).toHaveLength(1);
    const item = (await desk()).items.find((i: any) => i.subkind === 'bug_reported');
    expect(item.title).toMatch(/^Regression failure/);
  });

  it('single platform runs and authorization', async () => {
    await freshState();
    const one = await regression('web');
    expect(one.cards).toHaveLength(1);
    const stranger = await w.t.userSession(`s-${Date.now()}@example.test`);
    await regression('web', w.projectId, 404, stranger.cookie);
    const bad = await w.t.req('POST', `/api/projects/${w.projectId}/regression`, {
      cookie: w.owner.cookie,
      body: { platform: 'tv' },
    });
    expect(bad.status).toBe(400);
  });
});
