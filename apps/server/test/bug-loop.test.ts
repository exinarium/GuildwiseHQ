import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import {
  approve,
  cardRow,
  DIFF_SMALL,
  eventsOfType,
  handoff,
  hireTeam,
  pipeline,
  testFail,
  testPass,
} from './helpers/pipeline.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

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

const detail = (id: string) => ok<any>(w.t.req('GET', `/api/cards/${id}`, { cookie: w.owner.cookie }));
const board = async () =>
  (await ok<any>(w.t.req('GET', `/api/board?projectId=${w.projectId}`, { cookie: w.owner.cookie }))).columns;

describe('tester fail -> bug child -> resume', () => {
  it('creates a linked bug card on the parent branch, routed to the original builder; the parent waits', async () => {
    await freshState();
    await hireTeam(w, { builders: ['Bea', 'Cy'] });
    const card = await w.card({ title: 'Login page', docsNeeded: true });
    await p.toTest('Bea', ['Rex']);
    expect((await cardRow(card.id)).stage).toBe('test');

    const { start: tstart } = await p.run('Tess', testFail());
    expect(tstart.brief.shift.stage).toBe('test');
    expect(tstart.prepare.rebase).toBe(true);

    const parent = await cardRow(card.id);
    expect(parent).toMatchObject({ stage: 'test', status: 'waiting', claim_id: null });
    const child = (await q('SELECT * FROM cards WHERE parent_card_id=$1', [card.id]))[0]!;
    expect(child).toMatchObject({
      card_type: 'bug',
      origin: 'test_failure',
      stage: 'build',
      status: 'queued',
      worktree_card_id: card.id,
      repo_id: parent.repo_id,
      title: 'Login is broken',
    });
    expect(child.fields.context).toContain('Expected redirect, got 500');
    expect(child.original_builder_agent_id).toBe(parent.original_builder_agent_id);
    const wf = await q('SELECT key FROM workflow_versions WHERE id=$1', [child.workflow_version_id]);
    expect(wf[0]?.key).toBe('code-bugfix');

    // the board shows the waiting state with the child link
    const cols = await board();
    const waiting = cols.find((c: any) => c.name === 'Test (waiting on bug)');
    expect(waiting.cards[0]).toMatchObject({ ref: card.ref, waitingOn: { ref: child.ref } });
    expect(cols.find((c: any) => c.name === 'Rework').cards.map((c: any) => c.ref)).toContain(child.ref);

    // the detail has evidence and the child link
    const d = await detail(card.id);
    expect(d.testing.waitingOn.ref).toBe(child.ref);
    expect(d.testing.children.map((c: any) => c.ref)).toEqual([child.ref]);
    expect(d.testing.testRuns).toHaveLength(1);
    expect(d.testing.testRuns[0]).toMatchObject({ result: 'failed', kind: 'feature' });
    expect((await detail(child.id)).testing.parent.ref).toBe(card.ref);

    // original builder (Bea) gets the bug card first, in the parent's worktree
    const fix = await p.run('Bea', handoff('fixed'), DIFF_SMALL);
    expect(fix.start.brief.card.ref).toBe(child.ref);
    expect(fix.start.brief.card.parent?.ref).toBe(card.ref);
    expect(fix.start.worktree).toMatchObject({ mode: 'reuse', branchName: tstart.worktree?.branchName });
    expect(fix.start.worktree?.path).toBe(`/work/${card.ref}`);

    // the parent still waits while the fix is in review
    expect((await cardRow(card.id)).status).toBe('waiting');
    await p.run('Rex', approve());
    const after = await cardRow(card.id);
    expect(after).toMatchObject({ stage: 'test', status: 'queued' });
    expect(await cardRow(child.id)).toMatchObject({ stage: 'done', status: 'done' });
    const resolved = (await eventsOfType('ChildCardResolved')).filter((e) => e.cardId === card.id);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ cardId: card.id, childCardId: child.id });

    // back in the Test queue: pass moves to Docs (docsNeeded) with evidence attached
    await p.run('Tess', testPass('all green'));
    expect((await cardRow(card.id)).stage).toBe('docs');
    const runs = (await detail(card.id)).testing.testRuns;
    expect(runs.map((x: any) => x.result)).toEqual(['failed', 'passed']);
    expect(runs[1].evidence).toMatchObject({ summary: 'all green', commands: ['pnpm e2e'] });
  });

  it('pass goes straight to Finalize when no docs are needed', async () => {
    await freshState();
    await hireTeam(w);
    const card = await w.card({ title: 'No docs' });
    await p.toTest('Bea', ['Rex']);
    await p.run('Tess', testPass());
    expect((await cardRow(card.id)).stage).toBe('finalize');
    expect((await cardRow(card.id)).status).toBe('queued');
    const d = await detail(card.id);
    expect(d.testing.finalize).toMatchObject({ available: true, action: 'merge', state: 'idle' });
  });

  it('a bug child that needs changes goes back to its builder and keeps the parent waiting', async () => {
    await freshState();
    await hireTeam(w);
    const card = await w.card({ title: 'Second' });
    await p.toTest('Bea', ['Rex']);
    await p.run('Tess', testFail('Crash'));
    await p.run('Bea', handoff('try'), DIFF_SMALL);
    await p.run('Rex', {
      kind: 'outcome',
      outcomeId: 'changes',
      note: 'no',
      data: { score: 2, reasons: ['weak_tests'], criteriaMissed: [] },
    });
    expect((await cardRow(card.id)).status).toBe('waiting');
    const child = (await q('SELECT * FROM cards WHERE parent_card_id=$1', [card.id]))[0]!;
    expect(child).toMatchObject({ stage: 'build', status: 'queued', rework_round: 1 });
    expect((await eventsOfType('ChildCardResolved')).filter((e) => e.cardId === card.id)).toHaveLength(0);
  });

  it('cancelling the bug child returns the waiting parent to the Test queue', async () => {
    await freshState();
    await hireTeam(w);
    const card = await w.card({ title: 'Third' });
    await p.toTest('Bea', ['Rex']);
    await p.run('Tess', testFail('Cancelled bug'));
    expect(await cardRow(card.id)).toMatchObject({ stage: 'test', status: 'waiting' });
    const child = (await q('SELECT * FROM cards WHERE parent_card_id=$1', [card.id]))[0]!;
    await ok(
      w.t.req('POST', `/api/cards/${child.id}/cancel`, {
        cookie: w.owner.cookie,
        body: { reason: 'not a real bug' },
      }),
    );
    expect(await cardRow(child.id)).toMatchObject({ status: 'cancelled' });
    expect(await cardRow(card.id)).toMatchObject({ stage: 'test', status: 'queued', claim_id: null });
    expect((await eventsOfType('ChildCardResolved')).filter((e) => e.cardId === card.id)).toHaveLength(1);
    const cols = await board();
    expect(cols.find((c: any) => c.name === 'Test').cards.map((c: any) => c.ref)).toContain(card.ref);
    // a tester can claim the parent again
    const { start } = await p.run('Tess', testPass());
    expect(start.brief.card.ref).toBe(card.ref);
  });

  it('a failure in the E2E spec goes back to the tester on the same card: no bug card', async () => {
    await freshState();
    await hireTeam(w);
    const card = await w.card({ title: 'Spec rework' });
    await p.toTest('Bea', ['Rex']);
    const fail = testFail('Selector is stale');
    await p.run('Tess', { ...fail, data: { ...fail.data, failureScope: 'e2e_spec' } });
    expect(await q('SELECT 1 FROM cards WHERE parent_card_id=$1', [card.id])).toHaveLength(0);
    expect(await cardRow(card.id)).toMatchObject({ stage: 'test', status: 'queued', claim_id: null });
    const mine = (rows: any[]) => rows.filter((e) => e.cardId === card.id);
    expect(mine(await eventsOfType('TestReworkRequested'))).toHaveLength(1);
    expect(mine(await eventsOfType('TestFailed'))).toHaveLength(0);
    const { start } = await p.run('Tess', testPass('fixed the spec'));
    expect(start.brief.card.ref).toBe(card.ref);
    expect((await cardRow(card.id)).stage).toBe('finalize');
    expect((await detail(card.id)).testing.testRuns.map((x: any) => x.result)).toEqual(['failed', 'passed']);
  });

  it('a second failure while the bug child is open adds to it instead of creating another bug card', async () => {
    await freshState();
    await hireTeam(w);
    const card = await w.card({ title: 'Dup' });
    await p.toTest('Bea', ['Rex']);
    await p.run('Tess', testFail('First'));
    // the parent is put back in the Test queue while its bug child is still open (for example by a manual move)
    await q(`UPDATE cards SET status='queued' WHERE id=$1`, [card.id]);
    await p.run('Tess', testFail('Second'));
    const children = await q('SELECT * FROM cards WHERE parent_card_id=$1', [card.id]);
    expect(children).toHaveLength(1);
    expect(await cardRow(card.id)).toMatchObject({ stage: 'test', status: 'waiting' });
    const posted = (await eventsOfType('ThreadMessagePosted')).filter((e) => e.cardId === children[0]!.id);
    expect(posted.map((m: any) => m.body).join('\n')).toContain('No second bug card');
  });
});
