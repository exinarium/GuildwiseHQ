import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectLoops } from '../src/ceo/detectors.ts';
import { appoint } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { approve, changes, DIFF_SMALL, handoff, pipeline } from './helpers/pipeline.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/**
 * Lean Team v3, stream S1a: answers that keep a card parked, the repeat guard, question shifts in the loop breaker,
 * duplicate checks on every route, topic routing, waiting inside the shift, card affinity, dependency order and the
 * stop-loss budget (design section 9).
 */

let w: World;
let r: FakeRunner;
let p: ReturnType<typeof pipeline>;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' }, project: {} });
  r = await w.connectRunner({ capabilities: ['ceo:1'] });
  p = pipeline(w, r);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

/** Clears the work between tests but keeps the workstation's DevOps engineer (a CEO is appointed by the test that needs one). */
async function reset() {
  await q(
    `TRUNCATE cards, card_dependencies, card_handoffs, card_transitions, shifts, threads, thread_messages,
       desk_items, card_blockers, ledger_entries, runner_commands, runner_inbox, devops_requests, ceo_settings CASCADE`,
  );
  await q('DELETE FROM agents WHERE NOT is_devops');
  await q('UPDATE projects SET stop_loss = NULL');
  fromFrame = r.received.length;
  baseSeq = String((await q('SELECT coalesce(max(seq), 0) AS s FROM events'))[0]!.s);
}

const cardRow = async (id: string) => (await q('SELECT * FROM cards WHERE id=$1', [id]))[0]!;
const itemRow = async (id: string) => (await q('SELECT * FROM desk_items WHERE id=$1', [id]))[0]!;
const itemsOf = (cardId: string) =>
  q('SELECT * FROM desk_items WHERE card_id=$1 ORDER BY created_at', [cardId]);
let baseSeq = '0';
const eventsOfType = async (type: string) =>
  (await q('SELECT payload FROM events WHERE type=$1 AND seq > $2 ORDER BY seq', [type, baseSeq])).map(
    (e) => e.payload,
  );
const agentId = async (name: string) =>
  (await q('SELECT id FROM agents WHERE name=$1', [name]))[0]!.id as string;

const ask = (shiftId: string, over: Record<string, unknown> = {}) =>
  p.report(r, shiftId, {
    kind: 'question',
    text: 'Should the retry delay be 5 seconds or 10 seconds?',
    options: [],
    doing: 'writing the retry loop',
    blocking: true,
    ...over,
  });

/** The question shift for `name` (sent after this test's `reset`, not used before), started. */
const usedQuestionShifts = new Set<string>();
async function questionShift(name: string) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    await q('UPDATE workstations SET last_seen_at=$1 WHERE connected', [w.t.clock.now()]);
    await r.barrier();
    await p.dispatcher().run();
    const found = r.received
      .slice(fromFrame)
      .find(
        (f: any) =>
          f.type === 'shift.start' &&
          f.kind === 'question' &&
          f.agent.name === name &&
          !usedQuestionShifts.has(f.shiftId),
      ) as any;
    if (found) {
      usedQuestionShifts.add(found.shiftId);
      await p.startShift(r, found);
      return found;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for a question shift for ${name}`);
    await new Promise((res) => setTimeout(res, 100));
  }
}
const answer = (
  shiftId: string,
  itemId: string,
  text = 'Use 10 seconds.',
  extra: Record<string, unknown> = {},
) => p.report(r, shiftId, { kind: 'answer', itemId, text, ...extra });
const escalate = (shiftId: string, itemId: string) =>
  p.report(r, shiftId, { kind: 'escalate', itemId, note: 'not mine to decide' });

/** An rpc from a running shift (the runner forwards what it does not answer itself). */
async function rpc(shiftId: string, method: string, params: Record<string, unknown> = {}) {
  const rpcId = randomUUID();
  const from = r.received.length;
  r.send('rpc.request', { rpcId, shiftId, method, params });
  return (await r.waitFor('rpc.response', (f) => f.rpcId === rpcId, 10_000, from)) as {
    ok: boolean;
    result?: any;
    error?: string;
  };
}

/** Bea starts the card and asks a blocking question; returns the shift start, the card and the desk item. */
async function buildAndAsk(title: string, over: Record<string, unknown> = {}, who?: string) {
  const card = await w.card({ title });
  const start = who ? await nextShift(who) : await claimCard(card.id);
  await p.startShift(r, start);
  const res = await ask(start.shiftId, over);
  // A blocking question ends the shift; a waiting one keeps it (the test ends it).
  if (res.accepted && over.blocking !== false && over.converts !== true) r.ended(start.shiftId, 'reported');
  return { card, start, res };
}

/**
 * The next card-shift start (after this test's `reset`) that `match` accepts and nobody took yet. The dispatcher
 * picks the agent: the pass repeats until the start arrives.
 */
let fromFrame = 0;
const taken = new Set<string>();
async function nextStart(match: (f: any) => boolean, what: string) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    await q('UPDATE workstations SET last_seen_at=$1 WHERE connected', [w.t.clock.now()]);
    await r.barrier();
    await p.dispatcher().run();
    const found = r.received
      .slice(fromFrame)
      .find((f: any) => f.type === 'shift.start' && f.kind === 'card' && !taken.has(f.shiftId) && match(f));
    if (found) {
      taken.add((found as any).shiftId);
      return found as any;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((res) => setTimeout(res, 100));
  }
}
const claimCard = (cardId: string) =>
  nextStart((f) => f.brief.card.id === cardId, `a claim of card ${cardId}`);
const nextShift = (name: string) => nextStart((f) => f.agent.name === name, `a shift for ${name}`);

/** Dispatches the next shift to `name`, runs it to `report` and waits until it ended. */
async function run(name: string, report: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const start = await nextShift(name);
  await p.startShift(r, start);
  const res = await p.report(r, start.shiftId, report, extra);
  r.ended(start.shiftId, 'reported');
  await until(
    async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'ended']))[0],
    3000,
    'shift ended',
  );
  return { start, res };
}

describe('an answer that keeps the card parked', () => {
  it('leaves the card blocked, records the condition and keeps the blocker (old answers still unblock)', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    await w.hire('Sam', 'builder', 'senior');
    const { card, start } = await buildAndAsk('Parked card');
    const [item] = await itemsOf(card.id);
    expect(item).toMatchObject({ routed_to: 'agent', blocking: true });
    const qs = await questionShift('Sam');
    const res = await answer(qs.shiftId, item!.id, 'Wait for TOY-9.', {
      keepBlockedUntil: 'TOY-9 is merged',
    });
    expect(res).toMatchObject({ accepted: true });
    expect(res.message).toMatch(/stays parked until: TOY-9 is merged/);
    r.ended(qs.shiftId, 'reported');
    await until(async () => (await itemRow(item!.id)).status === 'answered', 3000, 'answered');

    expect(await cardRow(card.id)).toMatchObject({ status: 'blocked', claim_id: null });
    expect(await itemRow(item!.id)).toMatchObject({
      status: 'answered',
      keep_blocked_until: 'TOY-9 is merged',
    });
    expect(await q('SELECT 1 FROM card_blockers WHERE card_id=$1', [card.id])).toHaveLength(1);
    const ev = (await eventsOfType('QuestionAnswered')).at(-1);
    expect(ev).toMatchObject({ keepBlockedUntil: 'TOY-9 is merged', unblockedCardIds: [] });
    // The dispatcher does not hand it out, and the card page still says why it is blocked.
    await p.dispatcher().run();
    await r.barrier();
    expect(r.of('shift.start').filter((s) => s.brief.card.id === card.id && s.kind === 'card')).toHaveLength(
      1,
    );
    const detail = await ok<any>(w.t.req('GET', `/api/cards/${card.id}`, { cookie: w.owner.cookie }));
    expect(detail.blockers).toEqual([
      { deskItemId: item!.id, title: item!.title, keepBlockedUntil: 'TOY-9 is merged' },
    ]);
  });

  it('without the condition the card returns to the queue, as before', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    await w.hire('Sam', 'builder', 'senior');
    const { card, start } = await buildAndAsk('Released card');
    const [item] = await itemsOf(card.id);
    const qs = await questionShift('Sam');
    await answer(qs.shiftId, item!.id);
    r.ended(qs.shiftId, 'reported');
    await until(async () => (await cardRow(card.id)).status === 'queued', 3000, 'queued');
    expect(await q('SELECT 1 FROM card_blockers WHERE card_id=$1', [card.id])).toHaveLength(0);
  });

  it('the owner can keep a card parked when answering on the desk', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    const { card, start } = await buildAndAsk('Owner keeps it parked');
    const [item] = await itemsOf(card.id);
    expect(item!.routed_to).toBe('manager');
    await ok(
      w.t.req('POST', `/api/desk/${item!.id}/answer`, {
        cookie: w.owner.cookie,
        body: { answer: 'Not yet', keepBlockedUntil: 'the design is approved' },
      }),
    );
    expect(await cardRow(card.id)).toMatchObject({ status: 'blocked' });
    expect(await itemRow(item!.id)).toMatchObject({ keep_blocked_until: 'the design is approved' });
  });
});

describe('the repeat guard', () => {
  it('parks the card with a back-off and one desk item when the same question comes again', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    await w.hire('Sam', 'builder', 'senior');
    const { card, start } = await buildAndAsk('Asks twice');
    const [first] = await itemsOf(card.id);
    const qs = await questionShift('Sam');
    await answer(qs.shiftId, first!.id, 'Use 10 seconds.');
    r.ended(qs.shiftId, 'reported');
    await until(async () => (await cardRow(card.id)).status === 'queued', 3000, 'queued');

    // Bea gets the card again and asks the same thing in the same stage, nothing changed in between.
    const again = await claimCard(card.id);
    await p.startShift(r, again);
    const refused = await ask(again.shiftId);
    expect(refused).toMatchObject({ accepted: false });
    expect(refused.error).toMatch(/ledger already has similar entries/);
    const res = await ask(again.shiftId, { force: true });
    expect(res).toMatchObject({ accepted: true });
    expect(res.message).toMatch(/same question/);
    r.ended(again.shiftId, 'reported');

    const items = await itemsOf(card.id);
    expect(items.filter((i) => i.kind === 'question')).toHaveLength(1);
    const alerts = items.filter((i) => i.subkind === 'repeat_question');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ status: 'open', blocking: true, kind: 'escalation' });
    const c = await cardRow(card.id);
    expect(c).toMatchObject({ status: 'blocked', claim_id: null });
    expect(new Date(c.retry_after).getTime()).toBeGreaterThan(Date.now());
    expect(await eventsOfType('QuestionRaised')).toHaveLength(1);

    // Resolving the item is the owner's call; the card returns to the queue after the back-off.
    await ok(
      w.t.req('POST', `/api/desk/${alerts[0]!.id}/resolve`, {
        cookie: w.owner.cookie,
        body: { resolution: 'acknowledged' },
      }),
    );
    expect((await cardRow(card.id)).status).toBe('queued');
  });

  it('does not fire when something changed (a handoff) or the stage differs', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    await w.hire('Sam', 'builder', 'senior');
    const { card, start } = await buildAndAsk('Progress in between');
    const [first] = await itemsOf(card.id);
    const qs = await questionShift('Sam');
    await answer(qs.shiftId, first!.id);
    r.ended(qs.shiftId, 'reported');
    // Bea hands the work on (a state change); a later question about the same thing is a new question.
    await run('Bea', handoff(), DIFF_SMALL);
    const items = await itemsOf(card.id);
    expect(items.some((i) => i.subkind === 'repeat_question')).toBe(false);
  });
});

describe('duplicate checks on every route', () => {
  it('a blocking question that repeats a ledger entry is refused unless forced', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    await w.hire('Sam', 'builder', 'senior');
    const a = await buildAndAsk('First card');
    const [it] = await itemsOf(a.card.id);
    const qs = await questionShift('Sam');
    await answer(qs.shiftId, it!.id, 'Use 10 seconds.');
    r.ended(qs.shiftId, 'reported');
    const card = await w.card({ title: 'Second card' });
    const start = await claimCard(card.id);
    await p.startShift(r, start);
    const refused = await ask(start.shiftId, { blocking: true });
    expect(refused).toMatchObject({ accepted: false });
    expect(refused.error).toMatch(/Use 10 seconds/);
    expect((await cardRow(card.id)).status).toBe('claimed');
    const forced = await ask(start.shiftId, { blocking: true, force: true });
    expect(forced).toMatchObject({ accepted: true });
  });

  it('a question that goes to a peer is attached to the same question already open', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    await w.hire('Sam', 'builder', 'senior');
    const a = await buildAndAsk('Peer one', {});
    const b = await buildAndAsk('Peer two', {});
    expect(b.res.message).toMatch(/already open/);
    const [ia] = await itemsOf(a.card.id);
    const [ib] = await itemsOf(b.card.id);
    expect(ia).toMatchObject({ routed_to: 'agent', status: 'open' });
    expect(ib).toMatchObject({ status: 'superseded', merged_into: ia!.id });
    expect((await eventsOfType('QuestionMerged')).length).toBe(1);
    // Both cards wait on the surviving question.
    expect((await q('SELECT card_id FROM card_blockers WHERE desk_item_id=$1', [ia!.id])).length).toBe(2);
  });
});

describe('question shifts count for the loop breaker', () => {
  async function questionShiftRows(cardId: string, itemId: string, n: number) {
    const bea = await agentId('Bea');
    for (let i = 0; i < n; i++)
      await q(
        `INSERT INTO shifts (id, org_id, agent_id, workstation_id, card_id, kind, status, outcome, runtime, model, started_at, ended_at, desk_item_id)
         SELECT $1, org_id, $2, workstation_id, NULL, 'question', 'ended', 'reported', runtime, model, now(), now(), $3 FROM agents WHERE id=$2`,
        [randomUUID(), bea, itemId],
      );
    return cardId;
  }

  it('five question shifts on one card in two hours back the card off, whatever the wording', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    const first = await buildAndAsk('Chatty card', {
      text: 'Which retry delay do you want for the 12 uploads?',
    });
    const [item] = await itemsOf(first.card.id);
    await questionShiftRows(first.card.id, item!.id, 5);
    // A fifth-and-more question shift exists: the next question (different words) engages the loop breaker.
    await ok(
      w.t.req('POST', `/api/desk/${item!.id}/answer`, {
        cookie: w.owner.cookie,
        body: { answer: 'Use 10 seconds.' },
      }),
    );
    const start = await nextShift('Bea');
    await p.startShift(r, start);
    const res = await ask(start.shiftId, {
      text: 'Is the cache directory per user or shared across workers?',
    });
    expect(res).toMatchObject({ accepted: true });
    const c = await cardRow(first.card.id);
    expect(c.retry_failures).toBeGreaterThan(0);
    expect(new Date(c.retry_after).getTime()).toBeGreaterThan(Date.now());
    const alerts = (await itemsOf(first.card.id)).filter((i) => i.subkind === 'loop_backoff');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.title).toMatch(/keeps asking: 5 question shifts/);

    const loops = await detectLoops(w.t.app.ctx.pool);
    expect(
      loops.some(
        (l) =>
          l.fingerprint === `loop:card:${first.card.id}` ||
          l.fingerprint === `loop:questions:${first.card.id}`,
      ),
    ).toBe(true);
  });

  it('four question shifts raise nothing', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    const first = await buildAndAsk('Quiet card', {
      text: 'Which retry delay do you want for the 7 uploads?',
    });
    const [item] = await itemsOf(first.card.id);
    await questionShiftRows(first.card.id, item!.id, 4);
    expect(
      (await detectLoops(w.t.app.ctx.pool)).filter(
        (l) => l.fingerprint === `loop:questions:${first.card.id}`,
      ),
    ).toHaveLength(0);
    expect((await cardRow(first.card.id)).retry_failures).toBe(0);
  });

  it('the detector reports a card with five question shifts', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    const first = await buildAndAsk('Detected card', {
      text: 'Which retry delay do you want for the 9 uploads?',
    });
    const [item] = await itemsOf(first.card.id);
    await questionShiftRows(first.card.id, item!.id, 5);
    const found = (await detectLoops(w.t.app.ctx.pool)).filter(
      (l) => l.fingerprint === `loop:questions:${first.card.id}`,
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'loop', count: 5 });
  });
});

describe('topic routing', () => {
  it('environment goes to DevOps as a request and parks the card on it (no question for anyone else)', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    await w.hire('Sam', 'builder', 'senior');
    const { card, start, res } = await buildAndAsk('Needs the app', {
      text: 'The staging app is not running, how do I test?',
      topic: 'environment',
    });
    expect(res).toMatchObject({ accepted: true });
    expect(res.message).toMatch(/DevOps/);
    const c = await cardRow(card.id);
    expect(c).toMatchObject({ status: 'waiting', claim_id: null });
    expect(c.parked_request_id).not.toBeNull();
    const reqs = await q('SELECT * FROM devops_requests WHERE card_id=$1', [card.id]);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.requested_by_id).toBe(await agentId('Bea'));
    expect(reqs[0]!.summary).toMatch(/environment/);
    // Sam, the senior peer, was not asked.
    expect((await itemsOf(card.id)).filter((i) => i.kind === 'question')).toHaveLength(0);
  });

  it('a second environment question attaches to the open request', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    const { card, start } = await buildAndAsk('Waits twice', {
      topic: 'tooling',
      blocking: false,
      text: 'The linter binary is missing',
    });
    const again = await ask(start.shiftId, {
      topic: 'tooling',
      blocking: false,
      text: 'Still no linter binary on this machine',
    });
    expect(again.message).toMatch(/already working a request/);
    expect(await q('SELECT 1 FROM devops_requests WHERE card_id=$1', [card.id])).toHaveLength(1);
    expect((await cardRow(card.id)).status).toBe('claimed');
  });

  it('dependency and design go to the card architect, requirements to the BA, code to the builder', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    await w.hire('Arch', 'architect', 'senior');
    await w.hire('Ben', 'ba', 'senior');
    await w.hire('Rex', 'reviewer', 'senior');
    const routed = async (topic: string, who: string, start: any) => {
      const res = await ask(start.shiftId, {
        topic,
        blocking: false,
        text: `Question about ${topic} number ${Math.floor(Math.random() * 1e6)}`,
      });
      expect(res.accepted).toBe(true);
      const rows = await q(
        `SELECT routed_agent_id, topic FROM desk_items WHERE card_id=$1 ORDER BY created_at DESC LIMIT 1`,
        [start.brief.card.id],
      );
      expect(rows[0]!.topic).toBe(topic);
      expect(rows[0]!.routed_agent_id).toBe(await agentId(who));
    };
    const card = await w.card({ title: 'Routed by topic' });
    const bea = await nextShift('Bea');
    await p.startShift(r, bea);
    await routed('dependency', 'Arch', bea);
    await routed('order', 'Arch', bea);
    await routed('design', 'Arch', bea);
    await routed('requirements', 'Ben', bea);
    r.ended(bea.shiftId, 'stopped');
    void card;
  });

  it('code goes to the builder of the card, even for a reviewer asking', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    await w.hire('Dan', 'builder', 'senior');
    await w.hire('Rex', 'reviewer', 'senior');
    const card = await w.card({ title: 'Review asks the builder' });
    await run('Bea', handoff(), DIFF_SMALL);
    const rex = await nextShift('Rex');
    await p.startShift(r, rex);
    const res = await ask(rex.shiftId, {
      topic: 'code',
      blocking: false,
      text: 'Why does the parser skip blank lines here?',
    });
    expect(res.accepted).toBe(true);
    const [it] = await itemsOf(card.id);
    expect(it!.routed_agent_id).toBe(await agentId('Bea'));
  });

  it('with no topic and nobody else to ask the CEO comes before the desk; a CEO question runs on Sonnet', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    const appointed = { agentId: await appoint(w, 'Ada Prime') };
    // The mock runner offers the `mock` runtime only (the helper points the built-in CEO at it).
    const { card, res } = await buildAndAsk('Goes to the CEO');
    expect(res.message).toMatch(/Ada Prime/);
    const [it] = await itemsOf(card.id);
    expect(it).toMatchObject({ routed_to: 'agent', routed_agent_id: appointed.agentId });
    const trail = (it!.escalation_trail as Array<Record<string, any>>).map((s) => s.step);
    expect(trail).toEqual(['asked', 'ceo']);
    const qs = await questionShift('Ada Prime');
    expect(qs.agent.model).toBe('sonnet');
    // The CEO cannot pass it back to itself: escalating goes to the manager's desk.
    await escalate(qs.shiftId, it!.id);
    expect(await itemRow(it!.id)).toMatchObject({ routed_to: 'manager' });
  });

  it('a CEO answer is labelled a CEO decision on the desk item, the card thread and the ledger entry', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    await appoint(w, 'Ada Prime');
    const { card } = await buildAndAsk('CEO decides');
    const [it] = await itemsOf(card.id);
    const qs = await questionShift('Ada Prime');
    await answer(qs.shiftId, it!.id, 'Take option 1.');
    r.ended(qs.shiftId, 'reported');
    // The CEO's decision is on the resolved item (open for the owner's review), not on a second card.
    const list = await ok<any>(w.t.req('GET', '/api/desk?status=open', { cookie: w.owner.cookie }));
    const dto = (list.items ?? list).find((x: any) => x.id === it!.id);
    expect(dto).toMatchObject({
      answeredByAgentName: 'Ada Prime',
      answeredByAgentRole: 'ceo',
      status: 'answered',
    });
    expect(dto.ceoDecision).toMatchObject({ decision: 'Take option 1.', reviewed: false });
    expect(
      await q(`SELECT 1 FROM desk_items WHERE subkind='ceo_decision' AND card_id=$1`, [card.id]),
    ).toHaveLength(0);
    const msgs = await q(`SELECT body FROM thread_messages WHERE thread_id=$1 AND kind='answer'`, [card.id]);
    expect(msgs.map((m) => m.body)).toEqual(['CEO decision: Take option 1.']);
    const led = await q('SELECT tags, body FROM ledger_entries WHERE source_desk_item_id=$1', [it!.id]);
    expect(led[0]!.tags).toEqual(['ceo-decision']);
    expect(led[0]!.body).toContain('CEO decision, Ada Prime');
  });

  it("routine topics are answered on Sonnet, design keeps the answerer's model", async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    await w.hire('Arch', 'architect', 'senior');
    const card = await w.card({ title: 'Models' });
    const bea = await nextShift('Bea');
    await p.startShift(r, bea);
    await ask(bea.shiftId, { topic: 'dependency', blocking: false, text: 'Does TOY-77 come first?' });
    const routine = await questionShift('Arch');
    expect(routine.agent.model).toBe('sonnet');
    await answer(routine.shiftId, (await itemsOf(card.id))[0]!.id, 'No.');
    r.ended(routine.shiftId, 'reported');
    await ask(bea.shiftId, {
      topic: 'design',
      blocking: false,
      text: 'Should the cache be a separate module?',
    });
    const design = await questionShift('Arch');
    expect(design.agent.model).toBe('mock');
    // The slim brief: no card ledger entries, a short thread, the best ledger matches next to the question.
    expect(design.brief.ledger).toEqual([]);
    expect(design.brief.thread.length).toBeLessThanOrEqual(3);
    expect(design.question.ledgerMatches.length).toBeLessThanOrEqual(3);
  });

  it('a stop-loss style question from the owner chain without agents goes straight to the desk', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    const { card } = await buildAndAsk('Alone');
    const [it] = await itemsOf(card.id);
    expect(it).toMatchObject({ routed_to: 'manager' });
  });
});

describe('waiting inside the shift and card affinity', () => {
  it('a waiting question keeps the shift; the answer shows up in question.status', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    await w.hire('Sam', 'builder', 'senior');
    const { card, start, res } = await buildAndAsk('Waits for Sam', { blocking: false, wait: true });
    expect(res).toMatchObject({ accepted: true });
    expect(await cardRow(card.id)).toMatchObject({ status: 'claimed', claim_shift_id: start.shiftId });
    const open = await rpc(start.shiftId, 'question.status');
    expect(open.result).toMatchObject({ state: 'open' });
    expect(open.result.remainingMs).toBeGreaterThan(0);

    const [item] = await itemsOf(card.id);
    const qs = await questionShift('Sam');
    await answer(qs.shiftId, item!.id, 'Use 10 seconds.');
    r.ended(qs.shiftId, 'reported');
    const done = await rpc(start.shiftId, 'question.status');
    expect(done.result).toMatchObject({ state: 'answered', answer: 'Use 10 seconds.' });
    // Same shift, same claim: nothing was released.
    expect(await cardRow(card.id)).toMatchObject({ status: 'claimed', claim_shift_id: start.shiftId });
  });

  it('with nobody but the manager the status says unattended', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    const { start } = await buildAndAsk('Only the desk', { blocking: false, wait: true });
    expect((await rpc(start.shiftId, 'question.status')).result.state).toBe('unattended');
  });

  it('the conversion message says why: owner-only versus timeout', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    await w.card({ title: 'Reason card' });
    const start = await nextShift('Bea');
    await p.startShift(r, start);
    expect(await ask(start.shiftId, { blocking: false, wait: true })).toMatchObject({ accepted: true });
    const owner = await ask(start.shiftId, { blocking: true, converts: true, convertReason: 'owner_only' });
    expect(owner.message).toMatch(/Only the owner can answer this; the card waits on the desk/);
    expect(owner.message).not.toMatch(/No answer/);
    r.ended(start.shiftId, 'reported');

    await reset();
    await w.hire('Bea', 'builder', 'junior');
    await w.card({ title: 'Reason card 2' });
    const start2 = await nextShift('Bea');
    await p.startShift(r, start2);
    expect(await ask(start2.shiftId, { blocking: false, wait: true })).toMatchObject({ accepted: true });
    const late = await ask(start2.shiftId, { blocking: true, converts: true, waitedMinutes: 10 });
    expect(late.message).toMatch(/No answer within 10 minutes/);
    r.ended(start2.shiftId, 'reported');
  });

  it('when the wait runs out the card is parked, the agent keeps it, and the answer resumes its session first', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    await w.hire('Dan', 'builder', 'junior');
    await w.hire('Sam', 'builder', 'senior');
    const card = await w.card({ title: 'Affinity card' });
    const start = await nextShift('Bea');
    await p.startShift(r, start);
    await q('UPDATE shifts SET runtime_session_id=$2 WHERE id=$1', [start.shiftId, 'sess-bea-1']);
    expect(await ask(start.shiftId, { blocking: false, wait: true })).toMatchObject({ accepted: true });
    const convert = await ask(start.shiftId, { blocking: true, converts: true });
    expect(convert).toMatchObject({ accepted: true });
    expect(convert.message).toMatch(/keep it/);
    r.ended(start.shiftId, 'reported');

    const c = await cardRow(card.id);
    expect(c).toMatchObject({ status: 'blocked', claim_id: null, affinity_agent_id: await agentId('Bea') });
    expect(new Date(c.affinity_until).getTime()).toBeGreaterThan(Date.now() + 3 * 3600_000);
    const [item] = await itemsOf(card.id);
    expect(item).toMatchObject({ blocking: true, pinned: true, status: 'open' });
    expect((await eventsOfType('QuestionMadeBlocking')).length).toBe(1);
    expect(await q('SELECT 1 FROM card_blockers WHERE card_id=$1', [card.id])).toHaveLength(1);
    expect((await rpc(start.shiftId, 'question.status')).result.state).toBe('parked');

    const qs = await questionShift('Sam');
    await answer(qs.shiftId, item!.id, 'Use 10 seconds.');
    r.ended(qs.shiftId, 'reported');
    await until(async () => (await cardRow(card.id)).status === 'queued', 3000, 'queued');

    // Dan is free and would take the card; the affinity keeps it for Bea.
    const from = r.received.length;
    await p.dispatcher().run();
    const resumed = (await r.waitFor(
      'shift.start',
      (f) => f.agent.name === 'Bea' && f.kind === 'card' && f.brief.card.id === card.id,
      10_000,
      from,
    )) as any;
    expect(resumed.resumeSessionId).toBe('sess-bea-1');
    expect(resumed.resumeMessage).toMatch(/Use 10 seconds/);
    expect(
      r.of('shift.start').filter((f) => f.agent.name === 'Dan' && f.brief.card.id === card.id),
    ).toHaveLength(0);
  });

  it('an affinity ends at its expiry: any agent may take the card again', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    await w.hire('Dan', 'builder', 'junior');
    const card = await w.card({ title: 'Expired affinity' });
    await q(`UPDATE cards SET affinity_agent_id=$2, affinity_until=now() - interval '1 minute' WHERE id=$1`, [
      card.id,
      await agentId('Bea'),
    ]);
    const made = await p.dispatcher().runPass();
    expect(made.filter((m) => m.cardId === card.id)).toHaveLength(1);
  });

  it('review findings send the card back to its builder, who alone may claim it; the next stage clears it', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    await w.hire('Dan', 'builder', 'junior');
    await w.hire('Rex', 'reviewer', 'senior');
    const card = await w.card({ title: 'Back to the builder' });
    const built = await run('Bea', handoff(), DIFF_SMALL);
    await q('UPDATE shifts SET runtime_session_id=$2 WHERE id=$1', [built.start.shiftId, 'sess-bea-2']);
    await run('Rex', changes(['missed_requirement'], 'The retry is missing.'));
    const c = await cardRow(card.id);
    expect(c).toMatchObject({
      stage: 'build',
      affinity_agent_id: await agentId('Bea'),
      affinity_reason: 'review',
    });
    const back = await nextShift('Bea');
    expect(back.resumeSessionId).toBe('sess-bea-2');
    expect(back.resumeMessage).toMatch(/The retry is missing/);
    expect(
      r.of('shift.start').filter((f) => f.agent.name === 'Dan' && f.brief.card.id === card.id),
    ).toHaveLength(0);
    await p.startShift(r, back);
    await p.report(r, back.shiftId, handoff(), DIFF_SMALL);
    r.ended(back.shiftId, 'reported');
    await until(async () => (await cardRow(card.id)).stage === 'review', 3000, 'review');
    expect((await cardRow(card.id)).affinity_agent_id).toBeNull();
  });
});

describe('order between cards is enforced at every stage', () => {
  it('a card in review waits for its dependency to merge; the dependency landing releases it', async () => {
    await reset();
    await w.hire('Rex', 'reviewer', 'senior');
    const base = await w.card({ title: 'Base' });
    const dependent = await w.card({ title: 'Dependent', dependencies: [base.id] });
    // The dependent is already past its first build (it has a branch and sits in review), as in P5-24.
    await q(
      `UPDATE cards SET stage='review', status='queued', worktree_path='/work/dep', rework_round=0 WHERE id=$1`,
      [dependent.id],
    );
    await q('UPDATE cards SET status=$2 WHERE id=$1', [base.id, 'blocked']);
    await p.dispatcher().run();
    await r.barrier();
    expect(r.of('shift.start').filter((f) => f.brief.card.id === dependent.id)).toHaveLength(0);
    await q(`UPDATE cards SET status='done' WHERE id=$1`, [base.id]);
    await q('UPDATE workstations SET last_seen_at=$1 WHERE connected', [w.t.clock.now()]);
    const start = await nextShift('Rex');
    expect(start.brief.card.id).toBe(dependent.id);
  });
});

describe('card.depend and card.facts', () => {
  it('an architect records a dependency on a card that is already claimed; cycles and builders are refused', async () => {
    await reset();
    await w.hire('Arch', 'architect', 'senior');
    await w.hire('Bea', 'builder', 'junior');
    const a = await w.card({ title: 'Needs design', designNeeded: true });
    const b = await w.card({ title: 'Other', designNeeded: false });
    const start = await nextShift('Arch');
    await p.startShift(r, start);
    expect(start.brief.card.id).toBe(a.id);
    const res = await rpc(start.shiftId, 'card.depend', { on: b.ref });
    expect(res.ok).toBe(true);
    expect(res.result.message).toMatch(/now depends on/);
    expect(
      await q('SELECT 1 FROM card_dependencies WHERE card_id=$1 AND depends_on_card_id=$2', [a.id, b.id]),
    ).toHaveLength(1);
    expect((await eventsOfType('CardUpdated')).some((e) => e.changes?.dependencies?.includes(b.id))).toBe(
      true,
    );
    // again: nothing changes
    expect((await rpc(start.shiftId, 'card.depend', { on: b.ref })).result.added).toBe(false);
    // the other way round is a cycle
    const cycle = await rpc(start.shiftId, 'card.depend', { on: a.ref, card: b.ref });
    expect(cycle.ok).toBe(false);
    expect(cycle.error).toMatch(/cycle/);
    expect(await q('SELECT 1 FROM card_dependencies WHERE card_id=$1', [b.id])).toHaveLength(0);
    // a card of nobody's project is not found, a card cannot depend on itself
    expect((await rpc(start.shiftId, 'card.depend', { on: 'NOPE-1' })).ok).toBe(false);
    expect((await rpc(start.shiftId, 'card.depend', { on: a.ref })).error).toMatch(/itself/);
    // facts: the dependency has not merged
    const facts = await rpc(start.shiftId, 'card.facts');
    expect(facts.ok).toBe(true);
    expect(facts.result).toMatchObject({
      ref: a.ref,
      allDependenciesMerged: false,
      dependencies: [{ ref: b.ref, merged: false }],
    });
    expect(facts.result.branch.name).toMatch(/needs-design|toy|TOY/i);
    expect(facts.result.environment).toHaveProperty('project');
    const other = await rpc(start.shiftId, 'card.facts', { ref: b.ref });
    expect(other.result).toMatchObject({ ref: b.ref, dependents: [{ ref: a.ref }] });
  });

  it('a builder may not record dependencies', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    const a = await w.card({ title: 'Builder card', designNeeded: false });
    const b = await w.card({ title: 'Another', designNeeded: false });
    const start = await nextShift('Bea');
    await p.startShift(r, start);
    const res = await rpc(start.shiftId, 'card.depend', { on: a.id === start.brief.card.id ? b.ref : a.ref });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/architect, planner or BA/);
  });
});

describe('stop-loss per card', () => {
  async function toChangesRequested(builder: string, reviewer: string) {
    await run(builder, handoff(), DIFF_SMALL);
    await run(reviewer, changes(['weak_tests'], 'More tests please.'));
  }

  it('parks a small card after two review rounds and asks the architect; the answer extends the budget', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    await w.hire('Rex', 'reviewer', 'senior');
    await w.hire('Arch', 'architect', 'senior');
    const card = await w.card({ title: 'Goes round', designNeeded: false });
    await toChangesRequested('Bea', 'Rex');
    expect((await cardRow(card.id)).status).toBe('queued');
    await toChangesRequested('Bea', 'Rex');
    const c = await cardRow(card.id);
    expect(c.status).toBe('blocked');
    const stop = (await itemsOf(card.id)).filter((i) => i.subkind === 'stop_loss');
    expect(stop).toHaveLength(1);
    expect(stop[0]).toMatchObject({
      blocking: true,
      routed_to: 'agent',
      routed_agent_id: await agentId('Arch'),
      topic: 'design',
    });
    expect(stop[0]!.title).toMatch(/2\/2 review rounds/);

    // The architect says go on: the card returns, with a bigger budget.
    const qs = await questionShift('Arch');
    await answer(qs.shiftId, stop[0]!.id, 'Go on, the tests are the issue.');
    r.ended(qs.shiftId, 'reported');
    await until(async () => (await cardRow(card.id)).status === 'queued', 3000, 'queued');
    // One more pass and round: an approval now takes the card on to Test.
    await run('Bea', handoff(), DIFF_SMALL);
    await run('Rex', approve());
    expect((await cardRow(card.id)).stage).toBe('test');
  });

  it('an architect who cannot resolve it sends one item to the owner', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    await w.hire('Rex', 'reviewer', 'senior');
    await w.hire('Arch', 'architect', 'senior');
    await w.hire('Ben', 'ba', 'senior');
    const card = await w.card({ title: 'Escalated', designNeeded: false });
    await toChangesRequested('Bea', 'Rex');
    await toChangesRequested('Bea', 'Rex');
    const [stop] = (await itemsOf(card.id)).filter((i) => i.subkind === 'stop_loss');
    const qs = await questionShift('Arch');
    await escalate(qs.shiftId, stop!.id);
    // straight to the owner: not the BA
    expect(await itemRow(stop!.id)).toMatchObject({ routed_to: 'manager', status: 'open' });
    const desk = await ok<any>(w.t.req('GET', '/api/desk', { cookie: w.owner.cookie }));
    expect(desk.items.filter((i: any) => i.id === stop!.id)).toHaveLength(1);
  });

  it('the budget is a project setting with the design defaults', async () => {
    await reset();
    const before = await ok<any>(w.t.req('GET', `/api/projects/${w.projectId}`, { cookie: w.owner.cookie }));
    expect(before.project.stopLoss).toEqual({
      small: { buildPasses: 2, reviewRounds: 2, shifts: 10 },
      medium: { buildPasses: 3, reviewRounds: 2, shifts: 15 },
      large: { buildPasses: 4, reviewRounds: 2, shifts: 25 },
    });
    const settings = {
      small: { buildPasses: 1, reviewRounds: 1, shifts: 3 },
      medium: { buildPasses: 3, reviewRounds: 2, shifts: 15 },
      large: { buildPasses: 4, reviewRounds: 2, shifts: 25 },
    };
    const after = await ok<any>(
      w.t.req('PUT', `/api/projects/${w.projectId}/stop-loss`, {
        cookie: w.owner.cookie,
        body: { settings },
      }),
    );
    expect(after.project.stopLoss.small).toEqual(settings.small);
    await w.hire('Bea', 'builder', 'junior');
    await w.hire('Rex', 'reviewer', 'senior');
    const card = await w.card({ title: 'One round only', designNeeded: false });
    await toChangesRequested('Bea', 'Rex');
    expect((await cardRow(card.id)).status).toBe('blocked');
    const reset2 = await ok<any>(
      w.t.req('PUT', `/api/projects/${w.projectId}/stop-loss`, {
        cookie: w.owner.cookie,
        body: { settings: null },
      }),
    );
    expect(reset2.project.stopLoss.small.shifts).toBe(10);
  });

  it('a card that used its shifts is parked instead of claimed again', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    await w.hire('Arch', 'architect', 'senior');
    const card = await w.card({ title: 'Too many shifts', designNeeded: false });
    const bea = await agentId('Bea');
    for (let i = 0; i < 10; i++)
      await q(
        `INSERT INTO shifts (id, org_id, agent_id, workstation_id, card_id, kind, stage, status, outcome, runtime, model, started_at, ended_at)
         SELECT $1, org_id, id, workstation_id, $3, 'card', 'build', 'ended', 'no_report', runtime, model, now(), now() FROM agents WHERE id=$2`,
        [randomUUID(), bea, card.id],
      );
    await p.dispatcher().run();
    await r.barrier();
    expect(r.of('shift.start').filter((f) => f.kind === 'card' && f.brief.card.id === card.id)).toHaveLength(
      0,
    );
    expect((await cardRow(card.id)).status).toBe('blocked');
    const [stop] = (await itemsOf(card.id)).filter((i) => i.subkind === 'stop_loss');
    expect(stop!.title).toMatch(/shifts budget/);
    expect(stop!.routed_agent_id).toBe(await agentId('Arch'));
  });
});
