import { DEFAULT_CEO_POLICY, streamId, TESTER_REWORK_CAP } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectScope, SYSTEM_ACTOR } from '../src/commands/common.ts';
import { CEO_STOP_LOSS_ARBITRATIONS, ceoStopLossArbitrations } from '../src/commands/stop-loss.ts';
import { testerLoopQuestionEvents } from '../src/commands/tester-loop.ts';
import { testFailedEvents } from '../src/commands/testing.ts';
import { withAppendTx } from '../src/db/tx.ts';
import { act, appoint, graduate, startCeoShift, wakeNow } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/** The CEO's way to send a failed test back to the tester (GWP-11: it could only cancel the bug card). */
let w: World;
let r: FakeRunner;
let shiftId: string;
let testerId: string;

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  r = await w.connectRunner({ capabilities: ['ceo:1'] });
  await w.hire('Bea', 'builder', 'junior', { model: 'sonnet' });
  testerId = (await w.hire('Dennis', 'tester', 'senior', { model: 'sonnet' })).id;
  await appoint(w);
  await graduate(w);
  await wakeNow(w);
  shiftId = (await startCeoShift(w, r)).shiftId;
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const ctx = () => w.t.app.ctx;
const result = (resp: any) => {
  expect(resp.ok, JSON.stringify(resp)).toBe(true);
  return resp.result;
};
const cardRow = async (id: string) => (await q('SELECT * FROM cards WHERE id=$1', [id]))[0]!;
const deskIds = async () =>
  (await ok<any>(w.t.req('GET', '/api/desk?status=open', { cookie: w.owner.cookie }))).items.map(
    (i: any) => i.id as string,
  );
const events = async (type: string, cardId: string) =>
  (
    await q(`SELECT payload FROM events WHERE type=$1 AND payload->>'cardId'=$2 ORDER BY seq`, [type, cardId])
  ).map((e) => e.payload);

const PRODUCT_EVIDENCE = {
  commands: ['pnpm e2e'],
  summary: '1 failed',
  outputExcerpt: 'Error: 500 in apps/server/src/x.ts',
};

/** A card in Test whose failure created a bug card for a builder (through the real function). */
async function failedCard(title: string) {
  const card = await w.card({ title });
  await q(`UPDATE cards SET stage='test', status='queued' WHERE id=$1`, [card.id]);
  await withAppendTx(ctx().pool, async (tx) => {
    const row = (await tx.query('SELECT * FROM cards WHERE id=$1', [card.id])).rows[0];
    const evs = await testFailedEvents(ctx(), tx, row, testerId, 'Docs capture is missing', {
      ...PRODUCT_EVIDENCE,
      title: 'Screenshots missing',
    });
    await ctx().store.append(evs, { tx });
  });
  const bug = (await q(`SELECT * FROM cards WHERE parent_card_id=$1`, [card.id]))[0]!;
  expect(await cardRow(card.id)).toMatchObject({ stage: 'test', status: 'waiting' });
  return { card, bug };
}

/** The tester-loop question through the real function. */
async function raiseLoop(cardId: string) {
  await withAppendTx(ctx().pool, async (tx) => {
    const row = (await tx.query('SELECT * FROM cards WHERE id=$1', [cardId])).rows[0];
    await ctx().store.append(
      await testerLoopQuestionEvents(ctx(), tx, row, {
        reason: 'cancelled_bug',
        summary: 'Still failing',
        testerAgentId: testerId,
        evidence: { ...PRODUCT_EVIDENCE, title: 'Still failing' },
        note: 'Still failing',
        title: 'Still failing',
        cancelledRef: 'TOY-99',
      }),
      { tx },
    );
  });
  return (
    await q(
      `SELECT * FROM desk_items WHERE card_id=$1 AND subkind='tester_loop' ORDER BY created_at DESC LIMIT 1`,
      [cardId],
    )
  )[0]!;
}

describe('the policy and the action', () => {
  it('is a CEO class that is decided, not recommended', () => {
    expect(DEFAULT_CEO_POLICY.classes['card.send_to_tester']?.mode).toBe('decide');
    expect(DEFAULT_CEO_POLICY.desk['question:tester_loop']).toBe('decide');
  });
});

describe('send-to-tester', () => {
  it('given the bug card: cancels it and sends the parent to the tester, without the parent passing through Test first', async () => {
    const { card, bug } = await failedCard('Docs card');
    const res = result(
      await act(
        r,
        shiftId,
        'send-to-tester',
        { card: bug.ref, note: 'Edit guide-screenshots.spec.ts and run the capture yourself' },
        { key: 'stt-1' },
      ),
    );
    expect(res.status).toBe('executed');
    expect(await cardRow(bug.id)).toMatchObject({ status: 'cancelled' });
    expect(await cardRow(card.id)).toMatchObject({ stage: 'test', status: 'queued', claim_id: null });
    // the cancellation did not resolve the child on its own (that would be the path back to Test that re-failed it)
    expect(await events('ChildCardResolved', card.id)).toHaveLength(0);
    const rework = await events('TestReworkRequested', card.id);
    expect(rework).toHaveLength(1);
    expect(rework[0]).toMatchObject({
      instruction: 'Edit guide-screenshots.spec.ts and run the capture yourself',
    });
    const thread = (
      await q(
        `SELECT payload->>'body' AS body FROM events WHERE type='ThreadMessagePosted' AND payload->>'cardId'=$1`,
        [card.id],
      )
    ).map((m) => m.body);
    expect(thread.join('\n')).toMatch(/CEO sent .* back to the tester/);
    expect(
      await q('SELECT 1 FROM cards WHERE parent_card_id=$1 AND status<>$2', [card.id, 'cancelled']),
    ).toHaveLength(0);
  });

  it('given the parent card: cancels every open bug card too', async () => {
    const { card, bug } = await failedCard('Docs card two');
    const res = result(
      await act(
        r,
        shiftId,
        'send-to-tester',
        { card: card.ref, note: 'Run the capture again' },
        { key: 'stt-2' },
      ),
    );
    expect(res.status).toBe('executed');
    expect(await cardRow(bug.id)).toMatchObject({ status: 'cancelled' });
    expect(await cardRow(card.id)).toMatchObject({ stage: 'test', status: 'queued' });
    expect(await events('TestReworkRequested', card.id)).toHaveLength(1);
  });

  it('refuses a card of another organization', async () => {
    const { card, bug } = await failedCard('Foreign');
    const other = await w.t.createOrg(w.owner.id, 'Elsewhere');
    await q(`UPDATE cards SET org_id=$2 WHERE id=ANY($1::uuid[])`, [[card.id, bug.id], other]);
    for (const ref of [card.ref, bug.ref]) {
      const res = result(
        await act(r, shiftId, 'send-to-tester', { card: ref, note: 'nope nope' }, { key: `stt-org-${ref}` }),
      );
      expect(res.status).toBe('refused');
    }
    expect(await cardRow(bug.id)).toMatchObject({ status: expect.not.stringMatching(/cancelled/) });
    expect(await events('TestReworkRequested', card.id)).toHaveLength(0);
  });

  it('refuses a card that is not in Test', async () => {
    const card = await w.card({ title: 'In build' });
    const res = result(
      await act(r, shiftId, 'send-to-tester', { card: card.ref, note: 'back to test' }, { key: 'stt-3' }),
    );
    expect(res.status).toBe('refused');
  });
});

describe('send-to-tester status checks', () => {
  it('refuses a card with a live claim', async () => {
    const { card } = await failedCard('Claimed');
    await q(
      `UPDATE cards SET claim_id=gen_random_uuid(), claimed_by_agent_id=$2, status='claimed' WHERE id=$1`,
      [card.id, testerId],
    );
    const res = result(
      await act(r, shiftId, 'send-to-tester', { card: card.ref, note: 'claimed one' }, { key: 'stt-claim' }),
    );
    expect(res.status).toBe('refused');
    expect(await events('TestReworkRequested', card.id)).toHaveLength(0);
  });

  it('refuses a card in Test with the wrong status', async () => {
    const { card, bug } = await failedCard('Blocked status');
    await q(`UPDATE cards SET status='blocked' WHERE id=$1`, [card.id]);
    const res = result(
      await act(r, shiftId, 'send-to-tester', { card: card.ref, note: 'blocked one' }, { key: 'stt-status' }),
    );
    expect(res.status).toBe('refused');
    expect(await cardRow(bug.id)).toMatchObject({ status: expect.not.stringMatching(/cancelled/) });
  });

  it('refuses a card whose test never failed', async () => {
    const card = await w.card({ title: 'Never failed' });
    await q(`UPDATE cards SET stage='test', status='queued' WHERE id=$1`, [card.id]);
    const res = result(
      await act(
        r,
        shiftId,
        'send-to-tester',
        { card: card.ref, note: 'no failure yet' },
        { key: 'stt-nofail' },
      ),
    );
    expect(res.status).toBe('refused');
  });

  it('refuses a card whose last failure was followed by a pass', async () => {
    const { card } = await failedCard('Failed then passed');
    await withAppendTx(ctx().pool, async (tx) => {
      await ctx().store.append(
        [
          {
            streamId: streamId.card(card.id),
            event: {
              type: 'TestPassed',
              payload: {
                cardId: card.id,
                testerAgentId: testerId,
                evidence: PRODUCT_EVIDENCE,
                toStage: 'docs',
              },
            },
            actor: SYSTEM_ACTOR,
            scope: projectScope(card.org_id, card.project_id),
          } as never,
        ],
        { tx },
      );
    });
    await q(`UPDATE cards SET stage='test', status='waiting' WHERE id=$1`, [card.id]);
    const res = result(
      await act(
        r,
        shiftId,
        'send-to-tester',
        { card: card.ref, note: 'already passed' },
        { key: 'stt-passed' },
      ),
    );
    expect(res.status).toBe('refused');
  });
});

describe('tester_loop answers by the CEO', () => {
  const setCancelMode = (mode: string) =>
    q(
      `UPDATE ceo_settings SET policy = jsonb_set(policy, '{classes,card.cancel,mode}', to_jsonb($2::text)) WHERE org_id=$1`,
      [w.owner.id, mode],
    );
  const inverseOf = async (key: string) =>
    (
      await q(
        `SELECT inverse FROM ceo_actions WHERE idem_key LIKE '%' || $1 ORDER BY created_at DESC LIMIT 1`,
        [key],
      )
    )[0];

  it('option cancel is refused while card.cancel is not decide, and works when it is', async () => {
    const card = await w.card({ title: 'Cancel policy' });
    await q(`UPDATE cards SET stage='test', status='queued' WHERE id=$1`, [card.id]);
    const item = await raiseLoop(card.id);
    await setCancelMode('recommend');
    const refused = result(
      await act(r, shiftId, 'answer', { item: item.id, option: 'cancel' }, { key: 'tlc-1' }),
    );
    expect(refused.status).toBe('refused');
    expect(await cardRow(card.id)).toMatchObject({ status: 'blocked' });
    expect((await q('SELECT status FROM desk_items WHERE id=$1', [item.id]))[0]!.status).toBe('open');
    await setCancelMode('decide');
    try {
      const ok2 = result(
        await act(r, shiftId, 'answer', { item: item.id, option: 'cancel' }, { key: 'tlc-2' }),
      );
      expect(ok2.status).toBe('executed');
      expect(await cardRow(card.id)).toMatchObject({ status: 'cancelled' });
    } finally {
      await setCancelMode('recommend');
    }
  });

  it('an answer has no inverse (no undo)', async () => {
    const card = await w.card({ title: 'No undo' });
    await q(`UPDATE cards SET stage='test', status='queued' WHERE id=$1`, [card.id]);
    const item = await raiseLoop(card.id);
    const res = result(
      await act(r, shiftId, 'answer', { item: item.id, option: 'tester' }, { key: 'tlc-3' }),
    );
    expect(res.status).toBe('executed');
    expect((await inverseOf('tlc-3'))?.inverse ?? null).toBeNull();
  });
});

describe('the tester_loop question goes to the CEO', () => {
  it('is held for the CEO, and its answer performs the option', async () => {
    const card = await w.card({ title: 'Loop question' });
    await q(`UPDATE cards SET stage='test', status='queued' WHERE id=$1`, [card.id]);
    const item = await raiseLoop(card.id);
    expect(item).toMatchObject({ routed_to: 'manager', triage: 'pending', blocking: true, status: 'open' });
    expect(await deskIds()).not.toContain(item.id);
    expect(await cardRow(card.id)).toMatchObject({ status: 'blocked' });

    const res = result(await act(r, shiftId, 'answer', { item: item.id, option: 'tester' }, { key: 'tl-1' }));
    expect(res.status).toBe('executed');
    expect(await cardRow(card.id)).toMatchObject({ stage: 'test', status: 'queued' });
    expect(await events('TestReworkRequested', card.id)).toHaveLength(1);
  });

  it('cap: the CEO arbitrates 3 times, the 4th goes to the owner', async () => {
    const card = await w.card({ title: 'Loop cap' });
    await q(`UPDATE cards SET stage='test', status='queued' WHERE id=$1`, [card.id]);
    for (let i = 0; i < CEO_STOP_LOSS_ARBITRATIONS; i++) {
      const item = await raiseLoop(card.id);
      expect(item.triage, `question ${i + 1} is the CEO's`).toBe('pending');
      result(await act(r, shiftId, 'answer', { item: item.id, option: 'tester' }, { key: `tlcap-${i}` }));
    }
    expect(await ceoStopLossArbitrations(ctx().pool, card.id, 'tester_loop')).toBe(
      CEO_STOP_LOSS_ARBITRATIONS,
    );
    const fourth = await raiseLoop(card.id);
    expect(fourth).toMatchObject({ routed_to: 'manager', triage: 'none', status: 'open' });
    expect(await deskIds()).toContain(fourth.id);
  });

  it('the rework cap constant is 3', () => {
    expect(TESTER_REWORK_CAP).toBe(3);
  });
});
