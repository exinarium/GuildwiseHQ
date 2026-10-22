import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { board, handoff, recommendations, resetHr } from './helpers/hr.ts';
import { pipeline } from './helpers/pipeline.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

// These tests move the clock by hours between a question and its answer: the pass that escalates a blocking question nobody
// took up for 20 minutes would send the questions on before the chain answers them, so it is switched off here.
vi.mock('../src/dispatcher/questions.ts', async (orig) => ({
  ...(await orig<typeof import('../src/dispatcher/questions.ts')>()),
  blockedQuestionPass: async () => 0,
}));

// M9 stats meet the M7 escalation chain and intake: who answered a question changes whose time it cost, and the
// BA's specs are blamed through the intake that drafted the card.
let w: World;
let r: FakeRunner;
let p: ReturnType<typeof pipeline>;
const HOUR = 3_600_000;

beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  await hangUp();
  await w.t.close();
  await closeAdminPool();
});

async function hangUp() {
  if (!r) return;
  r.close();
  await until(async () => !w.t.app.ctx.services.runners.isOnline(w.workstationId), 3000, 'runner offline');
  await until(
    async () => !(await q('SELECT connected FROM workstations WHERE id=$1', [w.workstationId]))[0]?.connected,
    3000,
    'disconnect recorded',
  );
}

async function fresh(team: Array<[string, string, 'junior' | 'senior']>) {
  await hangUp();
  await resetHr();
  await q('TRUNCATE intakes, intake_cards CASCADE');
  r = await w.connectRunner();
  p = pipeline(w, r);
  for (const [name, role, seniority] of team) await w.hire(name, role, seniority);
}

/** Moves the server clock on; the runner reports in again so its agents stay reachable. */
async function advance(ms: number) {
  w.t.clock.advance(ms);
  const at = w.t.clock.now();
  r.heartbeat();
  await until(
    async () =>
      new Date(
        (await q('SELECT last_seen_at FROM workstations WHERE id=$1', [w.workstationId]))[0]!.last_seen_at,
      ) >= at,
    3000,
    'heartbeat recorded',
  );
}

const agentId = async (name: string) => (await q('SELECT id FROM agents WHERE name=$1', [name]))[0]!.id;

/** `name` takes its next card and asks a blocking question on it. */
async function ask(name: string, text: string) {
  const start = await p.next(name);
  await p.startShift(r, start);
  const res = (await p.report(r, start.shiftId, {
    kind: 'question',
    text,
    options: [],
    doing: 'working',
    blocking: true,
  })) as any;
  expect(res.accepted).toBe(true);
  r.ended(start.shiftId, 'reported');
  await until(
    async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'ended']))[0],
    3000,
    'question shift ended',
  );
  return start;
}

const usedQuestionShifts = new Set<string>();
/** The question shift of `name` for desk item `itemId`, started: dispatches until the runner has been sent it. */
async function questionShift(name: string, itemId: string) {
  const mine = (f: any) =>
    f.type === 'shift.start' &&
    f.agent?.name === name &&
    f.kind === 'question' &&
    f.question?.deskItemId === itemId &&
    !usedQuestionShifts.has(f.shiftId);
  const start = (await until(
    async () => {
      await w.t.app.ctx.services.dispatcher.run();
      // A shift sent long ago (before the clock moved on) was given up by the server: only a live one counts.
      for (const f of r.received.filter(mine)) {
        const st = (await q('SELECT status FROM shifts WHERE id=$1', [(f as any).shiftId]))[0]?.status;
        if (st && st !== 'ended') return f;
      }
      return undefined;
    },
    15_000,
    `question shift for ${name}`,
  )) as any;
  usedQuestionShifts.add(start.shiftId);
  await p.startShift(r, start);
  return start;
}

describe('stats and metrics with the escalation chain', () => {
  it('a question answered up the chain still counts as blocked, but only the desk costs the manager time', async () => {
    await fresh([
      ['Bea', 'builder', 'junior'],
      ['Sam', 'builder', 'senior'],
    ]);
    const c1 = await w.card({ title: 'First' });
    await ask('Bea', 'Which timezone do the reports use?');
    // Sam takes a filler card, so Bea (idle the longer) is the next to get the second one.
    await w.card({ title: 'Filler' });
    await p.run('Sam', handoff());
    const c2 = await w.card({ title: 'Second' });
    await ask('Bea', 'Should invoices round totals?');
    const items = await q(`SELECT id, card_id FROM desk_items ORDER BY created_at, id`);
    expect(items).toHaveLength(2);
    const [i1, i2] = items as Array<{ id: string; card_id: string }>;
    expect(i1!.card_id).toBe(c1.id);
    expect(i2!.card_id).toBe(c2.id);

    // Two hours later the senior answers the first; the second goes on to the desk, where the manager takes three more.
    await advance(2 * HOUR);
    const s1 = await questionShift('Sam', i1!.id);
    expect(
      ((await p.report(r, s1.shiftId, { kind: 'answer', itemId: i1!.id, text: 'UTC.' })) as any).accepted,
    ).toBe(true);
    r.ended(s1.shiftId, 'reported');
    const s2 = await questionShift('Sam', i2!.id);
    expect(
      (
        (await p.report(r, s2.shiftId, {
          kind: 'escalate',
          itemId: i2!.id,
          note: 'a business rule',
        })) as any
      ).accepted,
    ).toBe(true);
    r.ended(s2.shiftId, 'reported');
    await advance(3 * HOUR);
    const cookie = await w.t.login(w.owner.email);
    w.owner.cookie = cookie;
    await ok(
      w.t.req('POST', `/api/desk/${i2!.id}/answer`, {
        cookie,
        body: { answer: 'Round to cents.', ledger: { scope: 'decision' } },
      }),
    );

    // Bea asked on both cards: the blocked rate does not care who answered.
    const bea = await ok<any>(w.t.req('GET', `/api/agents/${await agentId('Bea')}/stats`, { cookie }));
    expect(bea.stats.cardsTouched).toBe(2);
    expect(bea.stats.blockedRate.value).toBe(1);
    // Card 1 sat blocked for two hours on Sam; card 2 for five, the last three on the manager (one card, not two).
    const m = await ok<any>(w.t.req('GET', `/api/metrics?projectId=${w.projectId}`, { cookie }));
    expect(m.timeBlockedOnManager.cards).toBe(1);
    expect(m.timeBlockedOnManager.totalMs).toBeGreaterThanOrEqual(5 * HOUR);
    expect(m.timeBlockedOnManager.totalMs).toBeLessThan(5 * HOUR + 60_000);
  });

  it('a question only the chain handled leaves the manager no blocked time', async () => {
    await fresh([
      ['Bea', 'builder', 'junior'],
      ['Sam', 'builder', 'senior'],
    ]);
    await w.card({ title: 'Only card' });
    await ask('Bea', 'Which port does the dev server use?');
    const item = (await q('SELECT id FROM desk_items'))[0]!;
    await advance(4 * HOUR);
    const s = await questionShift('Sam', item.id);
    await p.report(r, s.shiftId, { kind: 'answer', itemId: item.id, text: 'Port 4600.' });
    r.ended(s.shiftId, 'reported');
    const m = await ok<any>(
      w.t.req('GET', `/api/metrics?projectId=${w.projectId}`, { cookie: w.owner.cookie }),
    );
    expect(m.timeBlockedOnManager).toEqual({ totalMs: 0, cards: 0, avgMsPerCard: null });
    const bea = await ok<any>(
      w.t.req('GET', `/api/agents/${await agentId('Bea')}/stats`, { cookie: w.owner.cookie }),
    );
    expect(bea.stats.blockedRate.value).toBe(1);
  });
});

describe('thin specs are attributed to the BA through the intake', () => {
  const draft = (title: string) => ({
    title,
    cardType: 'feature',
    docsNeeded: false,
    repo: 'toy',
    fields: {
      context: 'ctx',
      requirements: 'short',
      acceptanceCriteria: ['it works'],
      affectedAreas: 'src/',
      constraints: 'none',
      testPlan: 'run tests',
    },
  });
  async function rpc(chatId: string, method: string, params: Record<string, unknown>) {
    const rpcId = randomUUID();
    const from = r.received.length;
    r.send('rpc.request', { rpcId, shiftId: chatId, method, params });
    return (await r.waitFor('rpc.response', (f) => f.rpcId === rpcId, 15_000, from)) as any;
  }

  it('builders blocked on the intake-drafted thin specs make the BA the target of the spec recommendation', async () => {
    await fresh([
      ['Bea', 'builder', 'junior'],
      ['Ben', 'ba', 'senior'],
    ]);
    const from = r.received.length;
    const created = await ok<any>(
      w.t.req('POST', '/api/intakes', { cookie: w.owner.cookie, body: { note: 'ABC-1' } }),
      201,
    );
    const start = (await r.waitFor(
      'chat.start',
      (f) => f.threadId === created.intake.threadId,
      15_000,
      from,
    )) as any;
    expect((await rpc(start.chatId, 'intake.map', { project: 'TOY' })).ok).toBe(true);
    for (const t of ['Login page', 'Export button', 'Avatar upload']) {
      const c = await rpc(start.chatId, 'card.create', draft(t));
      expect(c.ok).toBe(true);
      expect((await rpc(start.chatId, 'card.specify', { ref: c.result.ref })).ok).toBe(true);
    }
    expect(await q(`SELECT 1 FROM cards WHERE origin='intake'`)).toHaveLength(3);
    // Three different topics, so no standing order applies; the questions wait with the BA.
    await ask('Bea', 'Should invoices round totals?');
    await ask('Bea', 'Which timezone do reports use?');
    await ask('Bea', 'Where do avatars live?');

    const recs = await recommendations(w);
    const thin = recs.find((x) => x.kind === 'blocked_thin_specs');
    expect(thin).toBeDefined();
    const ben = await agentId('Ben');
    expect(thin).toMatchObject({ agentId: ben, agentName: 'Ben', roleKey: 'ba' });
    expect(thin.evidence.metrics[0].value).toBe('3 of 3');
    // The BA's HR card carries the recommendation about its specs.
    const b = await board(w);
    expect(b.recommendations.filter((x: any) => x.agentId === ben).map((x: any) => x.kind)).toEqual([
      'blocked_thin_specs',
    ]);
    // A review bounce blamed on the unclear spec is logged against the BA that drafted it.
    const card = (await q(`SELECT id FROM cards WHERE origin='intake' ORDER BY number LIMIT 1`))[0]!;
    expect(await q(`SELECT 1 FROM intake_cards WHERE card_id=$1`, [card.id])).toHaveLength(1);
  });
});
