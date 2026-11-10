import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { cardRow, eventsOfType, hireTeam, pipeline, testFail, testPass } from './helpers/pipeline.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, fullFields, ok, until, type World } from './helpers/world.ts';

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

  it('a bug card spawned by a regression run goes Test -> Finalize -> merge like any card', async () => {
    await freshState();
    await hireTeam(w);
    const { cards } = await regression('web');
    const run = cards[0];
    await p.run('Tess', testFail('Search returns nothing'));
    const bug = (
      await q(`SELECT * FROM cards WHERE card_type='bug' AND origin='regression' AND parent_card_id=$1`, [
        run.id,
      ])
    )[0]!;
    expect(bug).toMatchObject({ stage: 'spec', status: 'draft' });
    const fields = fullFields({ context: bug.fields.context });
    await ok(w.t.req('PATCH', `/api/cards/${bug.id}`, { cookie: w.owner.cookie, body: { fields } }));
    await ok(w.t.req('POST', `/api/cards/${bug.id}/specify`, { cookie: w.owner.cookie }));
    await p.toTest('Bea', ['Rex']);
    await p.run('Tess', testPass());
    // the normal path: Finalize, no suite outcome, the worktree and branch stay for the merge
    expect(await cardRow(bug.id)).toMatchObject({ stage: 'finalize', origin: 'regression' });
    expect((await eventsOfType('FullSuitePassed')).filter((e) => e.suiteCardId === bug.id)).toHaveLength(0);
    const removed = r
      .of('command')
      .filter((f) => f.command === 'worktree.remove' && String(f.payload.path).includes(bug.ref));
    expect(removed).toHaveLength(0);
    // a feature test run, not a suite run
    const runs = await q('SELECT kind, result FROM test_runs WHERE card_id=$1', [bug.id]);
    expect(runs).toEqual([{ kind: 'feature', result: 'passed' }]);

    const fin = r.received.length;
    await ok(w.t.req('POST', `/api/cards/${bug.id}/finalize`, { cookie: w.owner.cookie, body: {} }));
    const cmd = await r.waitFor('command', (f) => f.command === 'finalize.execute', 5000, fin);
    expect(cmd.payload.cardId).toBe(bug.id);
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: { ok: true, action: 'merge', mergeCommit: 'b2c3d4e' },
    });
    await until(async () => (await cardRow(bug.id)).status === 'done', 3000, 'bug finalized');
    expect((await cardRow(bug.id)).merged_into_working_at).not.toBeNull();
    // the run card itself still ended as a suite card
    expect(await cardRow(run.id)).toMatchObject({ card_type: 'regression', stage: 'done', status: 'done' });
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

describe('a failing run files every bug (P2)', () => {
  const multiFail = (title: string, note: string, summary = '2 failed') => ({
    kind: 'outcome',
    outcomeId: 'fail',
    note,
    data: { summary, commands: ['pnpm e2e'], outputExcerpt: 'Error', title },
  });
  const bugsOf = (runId: string) =>
    q(`SELECT * FROM cards WHERE card_type='bug' AND parent_card_id=$1 ORDER BY number`, [runId]);

  it('one bug card, BugReported and desk notice per Bug: section, after one FullSuiteFailed', async () => {
    await freshState();
    await q('TRUNCATE suite_run_bugs');
    await hireTeam(w);
    const run = (await regression('web')).cards[0];
    const note = [
      'Ran 40 specs.',
      'Bug: Search returns nothing',
      'Test: search.spec.ts > finds a product',
      'Typed "shoe", expected results, got none.',
      '',
      'Bug: Cart badge stays at 0',
      'Added one item, badge still shows 0.',
    ].join('\n');
    await p.run('Tess', multiFail('2 failures in the web run', note));
    const bugs = await bugsOf(run.id);
    const [b1, b2] = bugs as [any, any];
    expect(bugs.map((b) => b.title)).toEqual(['Search returns nothing', 'Cart badge stays at 0']);
    expect(b2.number).toBe(b1.number + 1);
    expect(bugs.every((b) => b.origin === 'regression' && b.stage === 'spec' && b.status === 'draft')).toBe(
      true,
    );
    expect(b1.fields.context).toContain('Typed "shoe"');
    expect(b1.fields.context).not.toContain('Cart badge');
    expect(b1.fields.context).toContain('Run notes:\nRan 40 specs.');
    const reported = (await eventsOfType('BugReported')).filter((e) => e.regressionCardId === run.id);
    expect(reported.map((e) => e.failureKey)).toEqual([
      'test:search.spec.ts > finds a product',
      'title:cart badge stays at 0',
    ]);
    expect((await eventsOfType('FullSuiteFailed')).filter((e) => e.suiteCardId === run.id)).toHaveLength(1);
    const items = (await desk()).items.filter((i: any) => i.subkind === 'bug_reported');
    expect(items.map((i: any) => i.card.ref).sort()).toEqual(bugs.map((b) => b.ref).sort());
    const links = await q(
      'SELECT bug_card_id, failure_key, seen_again FROM suite_run_bugs WHERE run_card_id=$1',
      [run.id],
    );
    expect(links).toHaveLength(2);
    expect(await cardRow(run.id)).toMatchObject({ stage: 'done', status: 'done' });
  });

  it('a second run files only the new bug; an open one is seen again with a message', async () => {
    await freshState();
    await q('TRUNCATE suite_run_bugs');
    await hireTeam(w);
    const first = (await regression('web')).cards[0];
    await p.run(
      'Tess',
      multiFail(
        '2 failures',
        'Bug: Search returns nothing\nTest: search.spec.ts > finds a product\nnone\nBug: Cart badge\nzero',
      ),
    );
    const open = (await bugsOf(first.id)).find((b) => b.title === 'Search returns nothing')!;
    const second = (await regression('web')).cards[0];
    await p.run(
      'Tess',
      multiFail(
        '2 failures',
        'Bug: Search is empty\nTest: search.spec.ts > finds a product\nstill none\nBug: Footer link 404\nbroken',
      ),
    );
    const fresh = await bugsOf(second.id);
    expect(fresh.map((b) => b.title)).toEqual(['Footer link 404']);
    const again = (await eventsOfType('RegressionBugSeenAgain')).filter((e) => e.runCardId === second.id);
    expect(again).toEqual([
      {
        runCardId: second.id,
        bugCardId: open.id,
        failureKey: 'test:search.spec.ts > finds a product',
        titleKey: 'title:search is empty',
        title: 'Search is empty',
      },
    ]);
    const msgs = await q('SELECT body FROM thread_messages WHERE thread_id=$1', [open.id]);
    expect(msgs.map((m) => m.body).join('\n')).toContain(`${second.ref} hit this bug again`);
    const link = await q('SELECT seen_again FROM suite_run_bugs WHERE run_card_id=$1 AND bug_card_id=$2', [
      second.id,
      open.id,
    ]);
    expect(link).toEqual([{ seen_again: true }]);
    const evidence = await q(`SELECT body FROM thread_messages WHERE thread_id=$1 AND kind='evidence'`, [
      second.id,
    ]);
    expect(evidence.map((m) => m.body).join('\n')).toContain(`Already open: ${open.ref}.`);
  });

  it('a note without sections files one bug; its generic title only matches a bug filed from a section', async () => {
    await freshState();
    await q('TRUNCATE suite_run_bugs');
    await hireTeam(w);
    // two unrelated failures reported without sections under the same generic title: two cards
    const first = (await regression('web')).cards[0];
    await p.run('Tess', testFail('2 failures in the web run'));
    expect(await bugsOf(first.id)).toHaveLength(1);
    const second = (await regression('web')).cards[0];
    await p.run('Tess', testFail('2 failures in the web run'));
    expect(await bugsOf(second.id)).toHaveLength(1);
    expect(
      (await eventsOfType('RegressionBugSeenAgain')).filter((e) => e.runCardId === second.id),
    ).toHaveLength(0);
    // a bug filed from a section is still found by a later note without sections that names it
    const third = (await regression('web')).cards[0];
    await p.run('Tess', {
      ...testFail('1 failure in the web run'),
      note: 'Bug: Mobile menu overlaps\nThe menu covers the page.',
    });
    expect(await bugsOf(third.id)).toHaveLength(1);
    const fourth = (await regression('web')).cards[0];
    await p.run('Tess', testFail('Mobile menu overlaps'));
    expect(await bugsOf(fourth.id)).toHaveLength(0);
    expect(
      (await eventsOfType('RegressionBugSeenAgain')).filter((e) => e.runCardId === fourth.id),
    ).toHaveLength(1);
  });
});

describe('the run checks the target commit before filing bugs (P3)', () => {
  const failWith = (note: string) => ({
    kind: 'outcome',
    outcomeId: 'fail',
    note,
    data: {
      summary: '1 failed',
      commands: ['pnpm e2e'],
      outputExcerpt: 'Error',
      title: '1 failure in the web run',
    },
  });
  const CAVEAT = 'The deployed commit of the target was not confirmed';

  it('a mismatch files no bug card and raises one alert for the run', async () => {
    await freshState();
    await q('TRUNCATE suite_run_bugs');
    await hireTeam(w);
    // an open bug for the same failure: a mismatch run does not count it as seen again either
    const earlier = (await regression('web')).cards[0];
    await p.run('Tess', failWith('Bug: Search returns nothing\nnone'));
    expect(
      await q(`SELECT 1 FROM cards WHERE card_type='bug' AND parent_card_id=$1`, [earlier.id]),
    ).toHaveLength(1);
    const run = (await regression('web')).cards[0];
    await p.run(
      'Tess',
      failWith('Target mismatch: 9f8e7d6 (tests abc123)\nBug: Search returns nothing\nnone'),
    );
    expect(await q(`SELECT 1 FROM cards WHERE card_type='bug' AND parent_card_id=$1`, [run.id])).toHaveLength(
      0,
    );
    expect((await eventsOfType('BugReported')).filter((e) => e.regressionCardId === run.id)).toHaveLength(0);
    expect((await eventsOfType('RegressionBugSeenAgain')).filter((e) => e.runCardId === run.id)).toHaveLength(
      0,
    );
    const failed = (await eventsOfType('FullSuiteFailed')).filter((e) => e.suiteCardId === run.id);
    expect(failed).toHaveLength(1);
    expect(failed[0].targetMismatch).toEqual({
      deployedCommit: '9f8e7d6',
      testedCommit: 'abc123',
      line: 'Target mismatch: 9f8e7d6 (tests abc123)',
    });
    const items = (await desk()).items.filter((i: any) => i.subkind === 'regression_target_mismatch');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'alert', blocking: false });
    expect(items[0].card.ref).toBe(run.ref);
    expect(items[0].body).toContain('No bug cards were filed');
    expect(await cardRow(run.id)).toMatchObject({ stage: 'done', status: 'done' });
  });

  it('an unknown target files the bugs with a caveat; a confirmed one without', async () => {
    await freshState();
    await q('TRUNCATE suite_run_bugs');
    await hireTeam(w);
    const unknown = (await regression('web')).cards[0];
    await p.run('Tess', failWith('Target commit: unknown\nBug: Search returns nothing\nnone'));
    const [b1] = await q(`SELECT fields FROM cards WHERE card_type='bug' AND parent_card_id=$1`, [
      unknown.id,
    ]);
    expect(b1!.fields.context).toContain(CAVEAT);
    expect(b1!.fields.context).not.toContain('Target commit: unknown');

    const confirmed = (await regression('web')).cards[0];
    await p.run(
      'Tess',
      failWith('Target commit: abc1234 (contains abc123)\nBug: Cart badge stays at 0\nzero'),
    );
    const [b2] = await q(`SELECT fields FROM cards WHERE card_type='bug' AND parent_card_id=$1`, [
      confirmed.id,
    ]);
    expect(b2!.fields.context).not.toContain(CAVEAT);
    const failed = (await eventsOfType('FullSuiteFailed')).filter((e) => e.suiteCardId === confirmed.id);
    expect(failed[0].targetMismatch).toBeUndefined();

    // a note without the target line counts as unknown
    const legacy = (await regression('web')).cards[0];
    await p.run('Tess', failWith('Bug: Footer link 404\nbroken'));
    const [b3] = await q(`SELECT fields FROM cards WHERE card_type='bug' AND parent_card_id=$1`, [legacy.id]);
    expect(b3!.fields.context).toContain(CAVEAT);
  });
});
