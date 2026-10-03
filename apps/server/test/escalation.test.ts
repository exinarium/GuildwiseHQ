import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { freshState, shiftHelpers } from './helpers/shifts.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
let h: ReturnType<typeof shiftHelpers>;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  h = shiftHelpers(w);
});
afterAll(async () => {
  await hangUp();
  await w.t.close();
  await closeAdminPool();
});

const cardRow = async (id: string) => (await q('SELECT * FROM cards WHERE id=$1', [id]))[0]!;
const item = async (id: string) => (await q('SELECT * FROM desk_items WHERE id=$1', [id]))[0]!;
const desk = (qs = '') => ok<any>(w.t.req('GET', `/api/desk${qs}`, { cookie: w.owner.cookie }));
const answerAsManager = (id: string, body: Record<string, unknown>) =>
  ok<any>(w.t.req('POST', `/api/desk/${id}/answer`, { cookie: w.owner.cookie, body }));

const ask = (shiftId: string, over: Record<string, unknown> = {}) =>
  h.report(r, shiftId, {
    kind: 'question',
    text: 'Should source files use tabs or spaces?',
    options: ['tabs', 'spaces'],
    recommend: 0,
    doing: 'writing the formatter',
    blocking: true,
    ...over,
  });

/** Closes the fake runner and waits until the server has noticed (a late close would mark the next runner offline). */
async function hangUp() {
  if (!r) return;
  r.close();
  await until(async () => !w.t.app.ctx.services.runners.isOnline(w.workstationId), 3000, 'runner offline');
  // ... and has recorded the disconnect (a late WorkstationDisconnected would mark the next runner offline)
  await until(
    async () => !(await q('SELECT connected FROM workstations WHERE id=$1', [w.workstationId]))[0]?.connected,
    3000,
    'disconnect recorded',
  );
}

async function fresh(team: Array<[string, string, 'junior' | 'senior']>) {
  await hangUp();
  await freshState();
  await q('TRUNCATE intakes, intake_cards CASCADE');
  r = await w.connectRunner();
  for (const [name, role, seniority] of team) await w.hire(name, role, seniority);
}

/** Bea builds a card and asks; returns the card and the desk item. */
async function asked(over: Record<string, unknown> = {}, who = 'Bea') {
  const card = await w.card({ title: `Card ${randomUUID().slice(0, 4)}` });
  const start = await h.dispatchTo(r, who);
  await h.startShift(r, start);
  const res = await ask(start.shiftId, over);
  expect(res.accepted).toBe(true);
  r.ended(start.shiftId, 'reported');
  const it = (await q('SELECT * FROM desk_items WHERE card_id=$1', [card.id]))[0]!;
  return { card, item: it, res };
}

/** Dispatches the question shift for `name` and starts it. */
const usedShifts = new Set<string>();
async function questionShift(name: string) {
  await h.dispatcher().run();
  // The dispatcher may already have sent it (a QuestionEscalated triggers a pass): take the first one not yet used.
  const start = (await r.waitFor(
    'shift.start',
    (f) => f.agent.name === name && f.kind === 'question' && !usedShifts.has(f.shiftId),
    5000,
  )) as any;
  usedShifts.add(start.shiftId);
  await h.startShift(r, start);
  return start;
}
const answer = (shiftId: string, itemId: string, text = 'Use tabs.', extra: Record<string, unknown> = {}) =>
  h.report(r, shiftId, { kind: 'answer', itemId, text, ...extra });
const escalate = (shiftId: string, itemId: string, note = 'not sure') =>
  h.report(r, shiftId, { kind: 'escalate', itemId, note });
const trail = async (id: string) =>
  ((await item(id)).escalation_trail as Array<Record<string, any>>).map((s) => s.step);

describe('escalation chain: senior peer first', () => {
  it('routes a builder question to a senior builder, who answers it without the desk or a ledger entry', async () => {
    await fresh([
      ['Bea', 'builder', 'junior'],
      ['Sam', 'builder', 'senior'],
      ['Ben', 'ba', 'senior'],
    ]);
    const { card, item: it, res } = await asked();
    expect(res.message).toMatch(/Sam \(builder\) first/);
    expect(it).toMatchObject({ routed_to: 'agent', status: 'open', blocking: true });
    const sam = (await q(`SELECT id FROM agents WHERE name='Sam'`))[0]!;
    expect(it.routed_agent_id).toBe(sam.id);
    expect(await trail(it.id)).toEqual(['asked', 'peer']);
    // not on the manager's desk while the chain works on it
    expect((await desk()).items).toHaveLength(0);
    expect((await cardRow(card.id)).status).toBe('blocked');

    const start = await questionShift('Sam');
    expect(start.question).toMatchObject({
      deskItemId: it.id,
      level: 'peer',
      text: 'Should source files use tabs or spaces?',
      blocking: true,
      askedBy: { name: 'Bea', role: 'builder' },
    });
    expect(start.worktree).toBeNull();
    expect(start.brief.shift).toMatchObject({ kind: 'question', outcomes: [] });
    expect(start.brief.card.ref).toBe(card.ref);
    expect(start.brief.role.key).toBe('builder');

    const done = await answer(start.shiftId, it.id, 'Use tabs.', { optionId: 'o1' });
    expect(done).toMatchObject({ accepted: true });
    r.ended(start.shiftId, 'reported');

    expect(await item(it.id)).toMatchObject({ status: 'answered', answer: 'Use tabs.', answer_option: 'o1' });
    expect((await item(it.id)).answered_by_agent_id).toBe(sam.id);
    expect(await trail(it.id)).toEqual(['asked', 'peer', 'answered']);
    expect(await cardRow(card.id)).toMatchObject({ status: 'queued' });
    // the manager is never bothered, and the answer is not a ledger entry
    expect((await desk()).items).toHaveLength(0);
    expect(await q('SELECT 1 FROM ledger_entries')).toHaveLength(0);
    const msg = (
      await q(
        `SELECT kind, body, author_agent_id FROM thread_messages WHERE thread_id=$1 AND kind='answer'`,
        [card.id],
      )
    )[0]!;
    expect(msg).toMatchObject({ body: 'Use tabs.', author_agent_id: sam.id });
    const closed = await desk('?status=closed');
    expect(closed.items[0]).toMatchObject({
      status: 'answered',
      answeredByAgentName: 'Sam',
      routedTo: 'agent',
      escalationTrail: [
        { step: 'asked' },
        { step: 'peer', agentName: 'Sam' },
        { step: 'answered', agentName: 'Sam' },
      ],
    });
    // the asker's next brief carries the answer
    const next = await h.dispatchTo(r, 'Bea', r.received.length - 1);
    expect(next.brief.thread.some((m) => m.kind === 'answer' && m.body === 'Use tabs.')).toBe(true);
    // the vault decision hook ignores agent answers
    expect(await q(`SELECT 1 FROM runner_commands WHERE type='vault.write'`)).toHaveLength(0);
  });

  it('rejects reports for another item, bad options, a second report and outcomes', async () => {
    await fresh([
      ['Bea', 'builder', 'junior'],
      ['Sam', 'builder', 'senior'],
    ]);
    const { item: it } = await asked();
    const start = await questionShift('Sam');
    const bad = await answer(start.shiftId, randomUUID());
    expect(bad).toMatchObject({ accepted: false });
    expect(bad.error).toMatch(/not given that item/);
    const wrongOption = await answer(start.shiftId, it.id, 'x', { optionId: 'o9' });
    expect(wrongOption.accepted).toBe(false);
    const outcome = await h.report(r, start.shiftId, {
      kind: 'outcome',
      outcomeId: 'handoff',
      note: 'x',
      data: {},
    });
    expect(outcome.accepted).toBe(false);
    expect((await answer(start.shiftId, it.id)).accepted).toBe(true);
    const again = await answer(start.shiftId, it.id, 'twice');
    expect(again.accepted).toBe(false);
    expect(again.error).toMatch(/already answered/);
  });

  it('goes to the previous holder of the card first (a reviewer asks the builder)', async () => {
    await fresh([
      ['Bea', 'builder', 'junior'],
      ['Rex', 'reviewer', 'senior'],
    ]);
    const card = await w.card();
    const b = await h.dispatchTo(r, 'Bea');
    await h.startShift(r, b);
    await h.report(
      r,
      b.shiftId,
      { kind: 'outcome', outcomeId: 'handoff', note: 'done', data: {} },
      { diffStats: { files: 1, added: 1, removed: 0, architecturalPaths: [] }, riskTier: 'small' },
    );
    r.ended(b.shiftId, 'reported');
    const rs = await h.dispatchTo(r, 'Rex', r.received.length - 1);
    await h.startShift(r, rs);
    await ask(rs.shiftId, { text: 'Why did you choose this layout?' });
    const it = (await q('SELECT * FROM desk_items WHERE card_id=$1', [card.id]))[0]!;
    const bea = (await q(`SELECT id FROM agents WHERE name='Bea'`))[0]!;
    // Bea (the previous holder) is asked: Rex is the only senior reviewer and is the asker
    expect(it).toMatchObject({ routed_to: 'agent', routed_agent_id: bea.id });
    expect(await trail(it.id)).toEqual(['asked', 'peer']);
  });
});

describe('escalation chain: peer, then BA, then the desk', () => {
  it('walks peer -> BA -> desk with the trail kept on the item, and the manager answers as before', async () => {
    await fresh([
      ['Bea', 'builder', 'junior'],
      ['Sam', 'builder', 'senior'],
      ['Ben', 'ba', 'senior'],
    ]);
    const { card, item: it } = await asked();
    const sam = await questionShift('Sam');
    const out1 = await escalate(sam.shiftId, it.id, 'I do not know the house style');
    expect(out1.accepted).toBe(true);
    expect(out1.message).toMatch(/Ben \(ba\)/);
    r.ended(sam.shiftId, 'reported');
    expect(await item(it.id)).toMatchObject({ routed_to: 'agent' });
    expect(await trail(it.id)).toEqual(['asked', 'peer', 'ba']);

    const ben = await questionShift('Ben');
    expect(ben.question).toMatchObject({ level: 'ba', trail: ['Sam (builder)'] });
    expect(ben.brief.role.key).toBe('ba');
    const out2 = await escalate(ben.shiftId, it.id, 'only the manager can decide style');
    expect(out2.message).toMatch(/manager's desk/);
    r.ended(ben.shiftId, 'reported');

    expect(await item(it.id)).toMatchObject({ routed_to: 'manager', status: 'open' });
    expect(await trail(it.id)).toEqual(['asked', 'peer', 'ba', 'desk']);
    const { items } = await desk();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: it.id,
      routedTo: 'manager',
      blocking: true,
      escalationTrail: [
        { step: 'asked', agentName: 'Bea' },
        { step: 'peer', agentName: 'Sam', role: 'builder' },
        { step: 'ba', agentName: 'Ben', role: 'ba', note: 'I do not know the house style' },
        { step: 'desk', note: 'only the manager can decide style' },
      ],
    });
    const notes = await q(
      `SELECT body FROM thread_messages WHERE thread_id=$1 AND kind='system' ORDER BY created_at, event_seq`,
      [card.id],
    );
    expect(notes.map((n) => n.body).join('\n')).toMatch(
      /Sam \(builder\) passed the question on to Ben \(ba\)/,
    );

    const a = await answerAsManager(it.id, { answer: 'Tabs.', optionId: 'o1' });
    expect(a.unblockedCardIds).toEqual([card.id]);
    expect(await trail(it.id)).toEqual(['asked', 'peer', 'ba', 'desk', 'answered']);
    expect(await q('SELECT 1 FROM ledger_entries')).toHaveLength(1);
  });

  it('skips the peer step when there is none and asks the BA directly', async () => {
    await fresh([
      ['Bea', 'builder', 'junior'],
      ['Ben', 'ba', 'senior'],
    ]);
    const { item: it } = await asked();
    expect(it.routed_to).toBe('agent');
    expect(await trail(it.id)).toEqual(['asked', 'ba']);
    const ben = await questionShift('Ben');
    expect((await answer(ben.shiftId, it.id, 'Tabs, per the house style.')).accepted).toBe(true);
    expect((await item(it.id)).status).toBe('answered');
    expect((await desk()).items).toHaveLength(0);
  });

  it('a question from the BA itself goes to the desk', async () => {
    await fresh([
      ['Ben', 'ba', 'senior'],
      ['Sam', 'builder', 'senior'],
    ]);
    const card = await w.card();
    await q(`UPDATE cards SET stage='finalize', home_workstation_id=$2, branch_name='aom/x' WHERE id=$1`, [
      card.id,
      w.workstationId,
    ]);
    const start = await h.dispatchTo(r, 'Ben');
    expect(start.brief.shift.stage).toBe('finalize');
    await h.startShift(r, start);
    await ask(start.shiftId, { text: 'Merge or PR for this one?' });
    const it = (await q('SELECT * FROM desk_items WHERE card_id=$1', [card.id]))[0]!;
    expect(it).toMatchObject({ routed_to: 'manager', asked_by_role: 'ba' });
    expect((await desk()).items).toHaveLength(1);
  });

  it('without a BA or a senior peer the question goes straight to the desk (as before M7)', async () => {
    await fresh([
      ['Bea', 'builder', 'junior'],
      ['Cai', 'builder', 'junior'],
    ]);
    const { item: it, res } = await asked();
    expect(it.routed_to).toBe('manager');
    expect(res.message).toMatch(/manager's desk/);
    expect(await trail(it.id)).toEqual(['asked']);
    expect((await desk()).items).toHaveLength(1);
  });

  it('shows the BA the ledger entries that match the question', async () => {
    await fresh([
      ['Bea', 'builder', 'junior'],
      ['Ben', 'ba', 'senior'],
    ]);
    await ok(
      w.t.req('POST', '/api/ledger', {
        cookie: w.owner.cookie,
        body: {
          scope: 'standing_order',
          projectId: w.projectId,
          title: 'Indentation',
          body: 'Source files use tabs for indentation, never spaces.',
          tags: [],
        },
      }),
      201,
    );
    const { item: it } = await asked();
    const ben = await questionShift('Ben');
    expect(ben.question.ledgerMatches.map((m: any) => m.title)).toContain('Indentation');
    expect(it.dedup_ledger_ids).toHaveLength(1);
  });
});

describe('escalation chain: failures', () => {
  it('a question shift that never reports is tried again and then the question moves on', async () => {
    await fresh([
      ['Bea', 'builder', 'junior'],
      ['Sam', 'builder', 'senior'],
      ['Ben', 'ba', 'senior'],
    ]);
    const { item: it } = await asked();
    for (let i = 0; i < 2; i++) {
      const s = await questionShift('Sam');
      r.ended(s.shiftId, 'no_report');
      await until(
        async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [s.shiftId, 'ended']))[0],
        3000,
        'ended',
      );
    }
    await h.dispatcher().run();
    expect((await item(it.id)).routed_to).toBe('agent');
    expect(await trail(it.id)).toEqual(['asked', 'peer', 'ba']);
    const note = ((await item(it.id)).escalation_trail as any[]).at(-1).note as string;
    expect(note).toMatch(/Sam \(builder\) could not take it/);
  });

  it('a question nobody can take (agent offline for too long) goes on to the desk', async () => {
    await fresh([
      ['Bea', 'builder', 'junior'],
      ['Sam', 'builder', 'senior'],
    ]);
    const { item: it } = await asked();
    expect(it.routed_to).toBe('agent');
    await hangUp();
    w.t.clock.advance(11 * 60_000);
    try {
      await h.dispatcher().run();
      expect((await item(it.id)).routed_to).toBe('manager');
      expect(await trail(it.id)).toEqual(['asked', 'peer', 'desk']);
    } finally {
      w.t.clock.setOffset(0);
    }
  });

  it('answering by hand on the desk while a peer works on it wins; the late agent report is refused', async () => {
    await fresh([
      ['Bea', 'builder', 'junior'],
      ['Sam', 'builder', 'senior'],
    ]);
    const { item: it } = await asked();
    const sam = await questionShift('Sam');
    await answerAsManager(it.id, { answer: 'Spaces.', optionId: 'o2' });
    const late = await answer(sam.shiftId, it.id, 'Tabs.');
    expect(late.accepted).toBe(false);
    expect(late.error).toMatch(/already answered/);
    expect((await item(it.id)).answer).toBe('Spaces.');
  });
});

describe('question shift plumbing', () => {
  it('records the question shift row and its end', async () => {
    await fresh([
      ['Bea', 'builder', 'junior'],
      ['Sam', 'builder', 'senior'],
    ]);
    const { item: it } = await asked();
    const s = await questionShift('Sam');
    await answer(s.shiftId, it.id, 'Tabs.');
    r.ended(s.shiftId, 'reported');
    await until(
      async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [s.shiftId, 'ended']))[0],
      3000,
      'ended',
    );
    const rows = await q(
      `SELECT id, kind, desk_item_id, status, outcome, card_id FROM shifts WHERE kind='question'`,
    );
    expect(rows).toEqual([
      {
        id: s.shiftId,
        kind: 'question',
        desk_item_id: it.id,
        status: 'ended',
        outcome: 'reported',
        card_id: null,
      },
    ]);
  });
});
