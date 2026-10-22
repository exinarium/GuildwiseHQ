import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { cardRow, eventsOfType, hireTeam, pipeline, testFail } from './helpers/pipeline.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/**
 * GWP-11: a card whose remaining work is in the E2E spec went tester -> bug card for a builder (who may not change E2E
 * paths) -> cancelled -> tester -> a new bug card, every 20 seconds.
 */
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

/** A product-scope failure whose report names `paths` and says `what`. */
const failing = (
  title: string,
  over: { note?: string; output?: string; scope?: 'product' | 'e2e_spec' } = {},
) => {
  const base = testFail(title);
  return {
    ...base,
    note: over.note ?? base.note,
    data: {
      ...base.data,
      ...(over.output !== undefined ? { outputExcerpt: over.output } : {}),
      ...(over.scope ? { failureScope: over.scope } : {}),
    },
  };
};
const E2E_ONLY = {
  note: 'The capture run did not produce the 9 jpgs. e2e/tests/guide-screenshots.spec.ts still has the old selectors.',
  output: 'Error: ENOENT: no such file or directory, open e2e/screenshots/guide-01.jpg',
};
const PRODUCT = {
  note: 'Open login, submit. apps/server/src/auth/login.ts returns 500.',
  output: 'Error: 500 at apps/server/src/auth/login.ts:42',
};
const children = (parentId: string) =>
  q('SELECT * FROM cards WHERE parent_card_id=$1 ORDER BY created_at', [parentId]);
const mine = (rows: any[], id: string) => rows.filter((e) => e.cardId === id);
const cancel = (id: string) =>
  ok(
    w.t.req('POST', `/api/cards/${id}/cancel`, {
      cookie: w.owner.cookie,
      body: { reason: 'no builder can fix it' },
    }),
  );
const openItem = async (cardId: string) =>
  (
    await q(`SELECT * FROM desk_items WHERE card_id=$1 AND subkind='tester_loop' ORDER BY created_at DESC`, [
      cardId,
    ])
  )[0];
const answerItem = (id: string, optionId: string | undefined, answer: string) =>
  ok(
    w.t.req('POST', `/api/desk/${id}/answer`, {
      cookie: w.owner.cookie,
      body: { answer, ...(optionId ? { optionId } : {}), ledger: { scope: 'feature' } },
    }),
  );

/** A card in Test whose first failure created a bug card, which the owner then cancelled. */
async function cancelledBugCard(title: string) {
  await freshState();
  await hireTeam(w);
  const card = await w.card({ title });
  await p.toTest('Bea', ['Rex']);
  await p.run('Tess', failing('Capture missing', PRODUCT));
  const [bug] = await children(card.id);
  await cancel(bug!.id);
  expect(await cardRow(card.id)).toMatchObject({ stage: 'test', status: 'queued' });
  return { card, bug: bug! };
}

describe('the first failure', () => {
  it('with product evidence still creates a bug card for a builder', async () => {
    await freshState();
    await hireTeam(w);
    const card = await w.card({ title: 'Normal bug' });
    await p.toTest('Bea', ['Rex']);
    await p.run('Tess', failing('Login is broken', PRODUCT));
    const kids = await children(card.id);
    expect(kids).toHaveLength(1);
    expect(kids[0]).toMatchObject({ origin: 'test_failure', stage: 'build' });
    expect(await cardRow(card.id)).toMatchObject({ stage: 'test', status: 'waiting' });
    expect(mine(await eventsOfType('TestReworkRequested'), card.id)).toHaveLength(0);
    expect(await openItem(card.id)).toBeUndefined();
  });

  it("naming only E2E paths in the note or the command still creates a bug card: the scope is the tester's", async () => {
    await freshState();
    await hireTeam(w);
    const card = await w.card({ title: 'Docs card' });
    await p.toTest('Bea', ['Rex']);
    const f = failing('Spec path failure', { note: 'e2e/x.spec.ts:12 fails', output: '' });
    f.data.commands = ['pnpm exec playwright test e2e/x.spec.ts:12'];
    await p.run('Tess', f);
    expect(await children(card.id)).toHaveLength(1);
    expect(mine(await eventsOfType('TestReworkRequested'), card.id)).toHaveLength(0);
    expect(await cardRow(card.id)).toMatchObject({ stage: 'test', status: 'waiting' });
  });

  it('"image missing" in a product failure creates a bug card', async () => {
    await freshState();
    await hireTeam(w);
    const card = await w.card({ title: 'Image card' });
    await p.toTest('Bea', ['Rex']);
    await p.run(
      'Tess',
      failing('Hero image missing', { note: 'The hero image is missing on the landing page', output: '' }),
    );
    expect(await children(card.id)).toHaveLength(1);
    expect(mine(await eventsOfType('TestReworkRequested'), card.id)).toHaveLength(0);
  });

  it('a path outside the E2E paths keeps it a product failure', async () => {
    await freshState();
    await hireTeam(w);
    const card = await w.card({ title: 'Mixed' });
    await p.toTest('Bea', ['Rex']);
    await p.run(
      'Tess',
      failing('Mixed', {
        note: 'e2e/tests/login.spec.ts fails because apps/web/src/Login.tsx throws',
        output: '',
      }),
    );
    expect(await children(card.id)).toHaveLength(1);
  });
});

describe('a failure after the bug card was cancelled', () => {
  it('with E2E-only evidence still asks the question (never reroutes), with a hint', async () => {
    const { card, bug } = await cancelledBugCard('Cancelled then e2e');
    await p.run('Tess', failing('Screenshots still missing', E2E_ONLY));
    expect((await children(card.id)).map((k) => k.id)).toEqual([bug.id]);
    expect(mine(await eventsOfType('TestReworkRequested'), card.id)).toHaveLength(0);
    expect(await cardRow(card.id)).toMatchObject({ stage: 'test', status: 'blocked' });
    expect((await openItem(card.id))!.title).toContain('the evidence only names E2E paths');
  });

  it('without E2E evidence asks one blocking question and creates no bug card', async () => {
    const { card, bug } = await cancelledBugCard('Cancelled then unclear');
    await p.run('Tess', failing('Still failing', PRODUCT));
    expect((await children(card.id)).map((k) => k.id)).toEqual([bug.id]);
    expect(await cardRow(card.id)).toMatchObject({ stage: 'test', status: 'blocked', claim_id: null });
    const item = (await openItem(card.id))!;
    expect(item).toMatchObject({ kind: 'question', blocking: true, status: 'open', routed_to: 'manager' });
    expect(item.title).toContain(
      `he tester reports the failure again after bug card ${bug.ref} was cancelled`,
    );
    expect(item.options.map((o: any) => o.id)).toEqual(['builder', 'tester', 'cancel']);
    // a second failure report while the question is open does not raise another one
    expect(
      await q(`SELECT 1 FROM desk_items WHERE card_id=$1 AND subkind='tester_loop'`, [card.id]),
    ).toHaveLength(1);
  });

  it('option builder: a new bug card is created', async () => {
    const { card } = await cancelledBugCard('Option builder');
    await p.run('Tess', failing('Still failing', PRODUCT));
    await answerItem((await openItem(card.id))!.id, 'builder', 'The product is wrong');
    const kids = await children(card.id);
    expect(kids).toHaveLength(2);
    expect(kids[1]).toMatchObject({ origin: 'test_failure', stage: 'build', status: 'queued' });
    expect(await cardRow(card.id)).toMatchObject({ stage: 'test', status: 'waiting' });
  });

  it('option tester: the card goes back to the tester with the decision as instruction', async () => {
    const { card } = await cancelledBugCard('Option tester');
    await p.run('Tess', failing('Still failing', PRODUCT));
    await answerItem((await openItem(card.id))!.id, 'tester', 'Edit the spec and run the capture yourself');
    expect(await children(card.id)).toHaveLength(1);
    expect(await cardRow(card.id)).toMatchObject({ stage: 'test', status: 'queued' });
    const rework = mine(await eventsOfType('TestReworkRequested'), card.id);
    expect(rework).toHaveLength(1);
    expect(rework[0].instruction).toContain('run the capture yourself');
    // a rework ordered by an answer is not a failed run of the tester: only the TestFailed of the first report counts
    expect(await q(`SELECT 1 FROM test_runs WHERE card_id=$1 AND result='failed'`, [card.id])).toHaveLength(
      1,
    );
    const { start } = await p.run('Tess', {
      kind: 'outcome',
      outcomeId: 'pass',
      note: 'ok',
      data: { summary: 'ok', commands: [], outputExcerpt: '' },
    });
    expect(start.brief.card.ref).toBe(card.ref);
  });

  it('option cancel: the card is cancelled', async () => {
    const { card } = await cancelledBugCard('Option cancel');
    await p.run('Tess', failing('Still failing', PRODUCT));
    await answerItem((await openItem(card.id))!.id, 'cancel', 'Give up on it');
    expect(await cardRow(card.id)).toMatchObject({ status: 'cancelled' });
  });
});

describe('the rework cap', () => {
  it('asks the CEO route after 3 reworks with no new commit; a new commit counts afresh', async () => {
    await freshState();
    await hireTeam(w);
    const card = await w.card({ title: 'Never converges' });
    await p.toTest('Bea', ['Rex']);
    const specFail = () => failing('Spec still wrong', { scope: 'e2e_spec' });
    for (let i = 0; i < 3; i++) {
      await p.run('Tess', specFail());
      expect(await cardRow(card.id)).toMatchObject({ stage: 'test', status: 'queued' });
    }
    expect(mine(await eventsOfType('TestReworkRequested'), card.id)).toHaveLength(3);
    // the 4th request would be a rework with the branch unchanged: it becomes a question instead
    await p.run('Tess', specFail());
    expect(mine(await eventsOfType('TestReworkRequested'), card.id)).toHaveLength(3);
    expect(await cardRow(card.id)).toMatchObject({ stage: 'test', status: 'blocked' });
    const item = (await openItem(card.id))!;
    expect(item.title).toMatch(/E2E rework 3 times in a row with no new commit/);
    expect(item.data.reason).toBe('rework_cap');

    // answered "back to the tester": the count starts again
    await answerItem(item.id, 'tester', 'Try once more');
    expect(await cardRow(card.id)).toMatchObject({ stage: 'test', status: 'queued' });
    await p.run('Tess', specFail());
    expect(await cardRow(card.id)).toMatchObject({ status: 'queued' });
    expect(
      await q(`SELECT 1 FROM desk_items WHERE card_id=$1 AND subkind='tester_loop'`, [card.id]),
    ).toHaveLength(1);
  });

  it('a tester that commits every shift is still capped at 6 reworks in all', async () => {
    await freshState();
    await hireTeam(w);
    const card = await w.card({ title: 'Commits every shift' });
    await p.toTest('Bea', ['Rex']);
    for (let i = 0; i < 7; i++) {
      const start = await p.next('Tess');
      await p.startShift(r, start, `csha${i}`);
      await p.report(r, start.shiftId, failing('Spec churn', { scope: 'e2e_spec' }));
      r.ended(start.shiftId, 'reported');
      await until(
        async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'ended']))[0],
        3000,
        'shift ended',
      );
    }
    expect(mine(await eventsOfType('TestReworkRequested'), card.id)).toHaveLength(6);
    const item = (await openItem(card.id))!;
    expect(item.data).toMatchObject({ reason: 'rework_cap', cap: 'total' });
    expect(item.title).toMatch(/rework 6 times since the last test result/);
    expect(await cardRow(card.id)).toMatchObject({ status: 'blocked' });
  }, 90_000);

  it('progress on the branch (a new head commit) resets the count', async () => {
    await freshState();
    await hireTeam(w);
    const card = await w.card({ title: 'Progressing' });
    await p.toTest('Bea', ['Rex']);
    const specFail = () => failing('Spec better', { scope: 'e2e_spec' });
    for (let i = 0; i < 4; i++) {
      // the tester committed in its previous shift: every shift starts at a new commit
      const start = await p.next('Tess');
      await p.startShift(r, start, `sha${i}`);
      await p.report(r, start.shiftId, specFail());
      r.ended(start.shiftId, 'reported');
      await until(
        async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'ended']))[0],
        3000,
        'shift ended',
      );
    }
    expect(mine(await eventsOfType('TestReworkRequested'), card.id)).toHaveLength(4);
    expect(await openItem(card.id)).toBeUndefined();
  }, 60_000);
});
