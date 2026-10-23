import { randomUUID } from 'node:crypto';
import { BOARD_VERBS_CAPABILITY, SESSION_TURNS_CAPABILITY, SESSION_VERBS_CAPABILITY } from '@aom/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PROJECTION_TABLES } from '../src/projections/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { Browser } from './helpers/browser.ts';
import { appoint } from './helpers/ceo.ts';
import { closeAdminPool, q as rawQ } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/**
 * Boardroom (phase C): the Chair's orchestration (independent first round, speaker choice, mentions, convergence, decision
 * points, round cap), the whiteboard, the minutes, Pull into PRD, costs and budget, and replay safety.
 */
const q = async (sql: string, params: unknown[] = []): Promise<any[]> => rawQ(sql, params) as Promise<any[]>;
let w: World;
let r: FakeRunner;
const seen = new Set<string>();
const CAPS = [SESSION_TURNS_CAPABILITY, SESSION_VERBS_CAPABILITY, BOARD_VERBS_CAPABILITY];
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ capabilities: CAPS });
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

/**
 * A workstation runs four session turns at once: a test must not leave one hanging for the next. After each test every board
 * session is paused (so nothing new follows) and what is still queued or running is cancelled.
 */
afterEach(async () => {
  let quiet = 0;
  for (let pass = 0; pass < 20 && quiet < 2; pass++) {
    const open = await q(
      `SELECT id, thread_id, status FROM session_turns WHERE status IN ('queued','running')`,
    );
    if (!open.length) {
      quiet++;
      await new Promise((res) => setTimeout(res, 200));
      continue;
    }
    quiet = 0;
    for (const th of new Set(open.map((t) => t.thread_id as string))) {
      await w.t.req('POST', `/api/board/${th}/pause`, { cookie: w.owner.cookie });
      await w.t.req('POST', `/api/discovery/${th}/pause`, { cookie: w.owner.cookie });
    }
    // queued turns first: failing a running one lets the next queued turn start
    for (const t of open.filter((x) => x.status === 'queued'))
      await w.t.app.ctx.services.sessions.cancel(w.owner.id, t.thread_id, t.id).catch(() => undefined);
    for (const t of open.filter((x) => x.status === 'running'))
      r.send('chat.error', { chatId: t.id, threadId: t.thread_id, error: 'cancelled' });
    await new Promise((res) => setTimeout(res, 150));
  }
});

const owner = (method: string, url: string, body?: unknown, expected = 200) =>
  ok<any>(
    w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) }),
    expected,
  );
const raw = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) });

const CAST = [
  { kind: 'persona', refId: 'devils-advocate' },
  { kind: 'persona', refId: 'user-advocate' },
  { kind: 'persona', refId: 'cost-hawk' },
];
const create = async (over: Record<string, unknown> = {}) =>
  (
    await owner(
      'POST',
      '/api/board',
      {
        topic: 'Should we launch a pilot?',
        brief: 'We have one friendly customer and eight weeks.',
        cast: CAST,
        roundCap: 3,
        ...over,
      },
      201,
    )
  ).state;
const get = async (id: string) => (await owner('GET', `/api/board/${id}`)).state;
const slugOf = (st: any, key: string) => st.cast.find((c: any) => c.refId === key).slug as string;

const nextStart = async (threadId: string, pred: (f: any) => boolean = () => true): Promise<any> => {
  const f = await r.waitFor(
    'chat.start',
    (x) => !seen.has(x.chatId) && x.threadId === threadId && pred(x),
    15_000,
  );
  seen.add(f.chatId);
  return f;
};
const role = (name: string) => (f: any) => f.message.includes(`"role":"${name}"`);
const call = async (turnId: string, method: string, params: Record<string, unknown> = {}) => {
  const rpcId = randomUUID();
  const from = r.received.length;
  r.send('rpc.request', { rpcId, shiftId: turnId, method, params });
  return (await r.waitFor('rpc.response', (f) => f.rpcId === rpcId, 15_000, from)) as {
    ok: boolean;
    result?: any;
    error?: string;
  };
};
const finish = async (start: any, text = 'ok', usage = { inputTokens: 100, outputTokens: 20 }) => {
  r.send('chat.done', {
    chatId: start.chatId,
    threadId: start.threadId,
    messageText: text,
    usage: { ...usage, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  await until(
    async () =>
      (await q('SELECT status FROM session_turns WHERE id=$1', [start.chatId]))[0]?.status === 'done',
  );
};
const speakerOf = (f: any): string => f.session.speaker.personaKey as string;

/** Answers round 1: the three independent turns, in the order they arrived. */
const answerRound1 = async (id: string, texts: Record<string, string> = {}) => {
  const out: any[] = [];
  for (let i = 0; i < 3; i++) out.push(await nextStart(id, role('speaker')));
  for (const s of out) await finish(s, texts[speakerOf(s)] ?? `${speakerOf(s)} answers on its own`);
  return out;
};
/** The Chair's turn after a round: picks `speakers` (handles) and ends its turn. */
const chairPicks = async (id: string, speakers: string[], extra: Record<string, unknown> = {}) => {
  const start = await nextStart(id, role('chair'));
  const a = await call(start.chatId, 'board.next', { speakers, reason: 'They see it differently', ...extra });
  expect(a.ok, a.error).toBe(true);
  await finish(start, 'Next up.');
  return { start, reply: a };
};

describe('creating a boardroom and the independent first round', () => {
  it('queues every seat at once with only the topic and the brief, seals the answers, then reveals them together', async () => {
    const b = await Browser.open(w.baseUrl, w.owner.cookie);
    await b.hello();
    const st = await create();
    expect(st).toMatchObject({
      config: { stage: 'round', round: 1, revealedRound: 0, format: 'open', roundCap: 3 },
      waitingFor: 'speakers',
      chair: { displayName: 'Chair' },
    });
    expect(st.cast.map((c: any) => c.refId)).toEqual(['devils-advocate', 'user-advocate', 'cost-hawk']);
    expect(st.rounds[0]).toMatchObject({ round: 1, kind: 'independent', source: 'independent' });
    await b.until(() => b.of('discovery.updated').some((m) => m.threadId === st.threadId));

    const starts = [];
    for (let i = 0; i < 3; i++) starts.push(await nextStart(st.threadId, role('speaker')));
    // all three were queued at once, each sees the topic and the brief and nothing else
    for (const s of starts) {
      expect(s.session).toMatchObject({ kind: 'boardroom', speaker: { kind: 'persona' } });
      expect(s.message).toContain('"kind":"independent"');
      expect(s.message).toContain('Should we launch a pilot?');
      expect(s.message).toContain('We have one friendly customer');
      expect(s.message).toContain('Your stance');
      expect(s.message).toContain('You have not seen anyone else yet');
      expect(s.message).not.toContain('Chair picks');
    }
    const turns = await q(`SELECT context, round, meta, model FROM session_turns WHERE thread_id=$1`, [
      st.threadId,
    ]);
    expect(turns).toHaveLength(3);
    for (const t of turns) {
      expect(t.context.mode).toBe('selected');
      expect(t.context.messageIds).toHaveLength(1);
      expect(t.round).toBe(1);
      expect(t.meta).toMatchObject({ purpose: 'board_speaker', kind: 'independent', round: 1 });
      expect(t.model).toEqual({ runtime: 'mock', model: 'mock' });
    }

    // a speaker writes a sticky note and asks for the board: nothing of the others is visible
    const shown = await call(starts[0].chatId, 'board.show');
    expect(shown.result.text).toContain('sealed');
    expect(
      (await call(starts[0].chatId, 'board.add', { column: 'risks', text: 'Adoption is assumed' })).ok,
    ).toBe(true);
    // the Chair's verbs are not available to a speaker
    const denied = await call(starts[0].chatId, 'board.next', { speakers: ['x'], reason: 'y' });
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain('not available');

    await finish(starts[0], 'Devil answers');
    await finish(starts[1], 'User answers');
    let mid = await get(st.threadId);
    expect(mid.sealedProgress).toEqual({ done: 2, total: 3 });
    expect(mid.sealedMessageIds).toHaveLength(2);
    expect(mid.hiddenNotes).toBe(1);
    expect(mid.notes).toHaveLength(0);
    expect(mid.config.revealedRound).toBe(0);

    await finish(starts[2], 'Cost answers');
    await until(async () => (await get(st.threadId)).config.revealedRound === 1);
    mid = await get(st.threadId);
    expect(mid.config).toMatchObject({ stage: 'chair', revealedRound: 1 });
    expect(mid.sealedMessageIds).toEqual([]);
    expect(mid.hiddenNotes).toBe(0);
    expect(mid.notes.map((n: any) => n.text)).toEqual(['Adoption is assumed']);
    expect(mid.rounds[0].status).toBe('done');
    const msgs = (await owner('GET', `/api/threads/${st.threadId}/messages`)).messages as any[];
    expect(msgs.some((m) => m.kind === 'system' && /revealed together/.test(m.body))).toBe(true);
    expect(msgs.filter((m) => m.authorKind === 'agent' && m.data?.round === 1)).toHaveLength(3);
    // the Chair is up next
    const chair = await nextStart(st.threadId, role('chair'));
    expect(chair.session.speaker.personaKey).toBe('chair');
    expect(chair.message).toContain('Round 1 is over');
    expect(chair.message).toContain('aom board next');
    await finish(chair, 'x');
    b.close();
  });
});

describe('the Chair chooses the speakers', () => {
  it('plans the next round, never opens with the last speaker, caps the pick at three, and runs the speakers one after the other', async () => {
    const st = await create({ roundCap: 4 });
    const round1 = await answerRound1(st.threadId);
    const last = speakerOf(round1[2]);
    const others = ['devils-advocate', 'user-advocate', 'cost-hawk'].filter((k) => k !== last);
    // the Chair picks the last speaker first, a duplicate, and a stranger: the server fixes the pick
    const chair = await nextStart(st.threadId, role('chair'));
    expect(chair.message).toContain(`do not pick them first`);
    const bad = await call(chair.chatId, 'board.next', { speakers: ['nobody-here'], reason: 'x' });
    expect(bad.ok).toBe(false);
    const a = await call(chair.chatId, 'board.next', {
      speakers: [
        slugOf(st, last),
        slugOf(st, others[0] as string),
        slugOf(st, others[0] as string),
        slugOf(st, others[1] as string),
      ],
      reason: 'They see it differently',
      instruction: 'Name the real disagreement',
    });
    expect(a.ok, a.error).toBe(true);
    expect(a.result.message).toContain('Adjusted by the server');
    // a second call in the same turn is refused
    expect((await call(chair.chatId, 'board.next', { speakers: [slugOf(st, last)], reason: 'x' })).ok).toBe(
      false,
    );
    await finish(chair, 'Next up.');
    const mid = await get(st.threadId);
    const round2 = mid.rounds[1];
    expect(round2).toMatchObject({
      round: 2,
      kind: 'discussion',
      source: 'chair',
      instruction: 'Name the real disagreement',
    });
    expect(round2.speakers.length).toBeLessThanOrEqual(3);
    expect(round2.speakers[0].participantId).not.toBe(
      mid.cast.find((c: any) => c.refId === last).participantId,
    );
    expect(new Set(round2.speakers.map((s: any) => s.participantId)).size).toBe(round2.speakers.length);
    expect(mid.chairStatus).toContain('Chair picks:');
    expect(mid.chairStatus).toContain('They see it differently');

    // sequential: the second speaker is only queued once the first has answered, and hears it
    const first = await nextStart(st.threadId, role('speaker'));
    expect(first.message).toContain('"kind":"discussion"');
    expect(first.message).toContain('Name the real disagreement');
    expect(first.message).toContain('The Chair asks');
    const ctx1 = await q(`SELECT context FROM session_turns WHERE id=$1`, [first.chatId]);
    expect(ctx1[0].context.mode).toBe('all');
    await new Promise((res) => setTimeout(res, 200));
    expect(
      r.received.filter(
        (f: any) => f.type === 'chat.start' && !seen.has(f.chatId) && f.threadId === st.threadId,
      ),
    ).toHaveLength(0);
    await finish(first, 'FIRST-SPOKE-HERE');
    if (round2.speakers.length > 1) {
      const second = await nextStart(st.threadId, role('speaker'));
      expect(second.message).toContain('FIRST-SPOKE-HERE');
      expect(speakerOf(second)).not.toBe(speakerOf(first));
      await finish(second, 'second');
    }
    if (round2.speakers.length > 2) await finish(await nextStart(st.threadId, role('speaker')), 'third');
    // the stance is repeated at every turn: the next Chair turn lists it
    const chair2 = await nextStart(st.threadId, role('chair'));
    expect(chair2.message).toContain('Round 2 is over');
    await finish(chair2, 'x');
  });

  it('honours the owner @mentions: a mentioned seat speaks next, even if it spoke last', async () => {
    const st = await create({ roundCap: 4 });
    const round1 = await answerRound1(st.threadId);
    const last = speakerOf(round1[2]);
    const chair = await nextStart(st.threadId, role('chair'));
    const said = await owner(
      'POST',
      `/api/board/${st.threadId}/say`,
      { body: `@${slugOf(st, last)} what does this cost us?` },
      201,
    );
    expect(said.mentioned).toHaveLength(1);
    expect((await get(st.threadId)).waitingFor).toBe('chair');
    const pick = await call(chair.chatId, 'board.next', {
      speakers: ['user-advocate', 'devils-advocate'].map((k) => slugOf(st, k)),
      reason: 'x',
    });
    expect(pick.ok, pick.error).toBe(true);
    expect(pick.result.message).toContain('Mentioned by the owner');
    await finish(chair);
    const mid = await get(st.threadId);
    expect(mid.rounds[1].speakers[0].name).toBe(mid.cast.find((c: any) => c.refId === last).displayName);
    expect(mid.rounds[1].speakers.length).toBeLessThanOrEqual(3);
    const spk = await nextStart(st.threadId, role('speaker'));
    expect(speakerOf(spk)).toBe(last);
    // the owner's message is part of the context of the round
    const lines = await q(`SELECT context FROM session_turns WHERE id=$1`, [spk.chatId]);
    expect(lines[0].context.mode).toBe('all');
    expect(spk.message).toContain('what does this cost us?');
    // @all reaches the whole cast
    const all = await owner('POST', `/api/board/${st.threadId}/say`, { body: 'Hey @all, quick check' }, 201);
    expect(all.mentioned).toHaveLength(3);
    // unknown handles mention nobody
    expect(
      (await owner('POST', `/api/board/${st.threadId}/say`, { body: '@nobody hi' }, 201)).mentioned,
    ).toEqual([]);
  });

  it('falls back to the least heard voices when the Chair twice gives no usable pick', async () => {
    const st = await create({ roundCap: 4 });
    await answerRound1(st.threadId);
    const c1 = await nextStart(st.threadId, role('chair'));
    await finish(c1, 'I will think about it');
    const c2 = await nextStart(st.threadId, role('chair'));
    expect(c2.message).toContain('Your last turn ended without a valid pick');
    await finish(c2, 'still thinking');
    await until(async () => (await get(st.threadId)).rounds.length === 2);
    const mid = await get(st.threadId);
    expect(mid.rounds[1]).toMatchObject({ source: 'fallback', round: 2 });
    expect(mid.rounds[1].speakers.length).toBeGreaterThanOrEqual(1);
    const msgs = (await owner('GET', `/api/threads/${st.threadId}/messages`)).messages as any[];
    expect(msgs.some((m) => m.kind === 'system' && /server picked/.test(m.body))).toBe(true);
    // the Chair's own words never reach the speakers' transcript
    const spk = await nextStart(st.threadId, role('speaker'));
    expect(spk.message).not.toContain('still thinking');
  });
});

describe('convergence, decision points and the end', () => {
  it('turns the next round into a dissent round when the Chair flags early agreement', async () => {
    const st = await create({ roundCap: 4 });
    await answerRound1(st.threadId);
    const chair = await nextStart(st.threadId, role('chair'));
    expect((await call(chair.chatId, 'board.converge', { note: 'all three want a pilot' })).ok).toBe(true);
    const pick = await call(chair.chatId, 'board.next', {
      speakers: [slugOf(st, 'devils-advocate')],
      reason: 'to dissent',
    });
    expect(pick.ok, pick.error).toBe(true);
    expect(pick.result.message).toContain('(dissent)');
    await finish(chair);
    const mid = await get(st.threadId);
    expect(mid.rounds[1]).toMatchObject({ kind: 'dissent' });
    expect(mid.config.dissentNext).toBe(false);
    const spk = await nextStart(st.threadId, role('speaker'));
    expect(spk.message).toContain('"kind":"dissent"');
    expect(spk.message).toContain('Steel-man the strongest opposing view');
    const msgs = (await owner('GET', `/api/threads/${st.threadId}/messages`)).messages as any[];
    expect(msgs.some((m) => m.kind === 'system' && /agreeing early/.test(m.body))).toBe(true);
    await finish(spk);
  });

  it('pauses at a decision point until the owner decides, and tells the next round what was decided', async () => {
    const st = await create({ roundCap: 4 });
    await answerRound1(st.threadId);
    const chair = await nextStart(st.threadId, role('chair'));
    const p = await call(chair.chatId, 'board.pause', {
      question: 'Pilot or prove demand first?',
      options: ['Pilot', 'Prove demand'],
    });
    expect(p.ok, p.error).toBe(true);
    // after pausing the Chair cannot also plan a round
    expect(
      (await call(chair.chatId, 'board.next', { speakers: [slugOf(st, 'cost-hawk')], reason: 'x' })).ok,
    ).toBe(false);
    await finish(chair, 'Over to you.');
    let mid = await get(st.threadId);
    expect(mid.waitingFor).toBe('decision');
    expect(mid.config.stage).toBe('decision');
    const d = mid.decisions[0];
    expect(d).toMatchObject({ status: 'open', question: 'Pilot or prove demand first?' });
    expect(d.options.map((o: any) => o.label)).toEqual(['Pilot', 'Prove demand']);
    await new Promise((res) => setTimeout(res, 300));
    expect(
      r.received.filter(
        (f: any) => f.type === 'chat.start' && !seen.has(f.chatId) && f.threadId === st.threadId,
      ),
    ).toHaveLength(0);
    // the owner decides
    expect(
      (await raw('POST', `/api/board/${st.threadId}/decisions/${d.id}/resolve`, { answer: '' })).status,
    ).toBe(400);
    mid = (
      await owner('POST', `/api/board/${st.threadId}/decisions/${d.id}/resolve`, {
        optionId: 'o2',
        answer: 'with ten paying users',
      })
    ).state;
    expect(mid.decisions[0]).toMatchObject({
      status: 'resolved',
      answer: 'Prove demand: with ten paying users',
    });
    expect(mid.notes.some((n: any) => n.column === 'decisions' && /Prove demand/.test(n.text))).toBe(true);
    expect(
      (await raw('POST', `/api/board/${st.threadId}/decisions/${d.id}/resolve`, { answer: 'again' })).status,
    ).toBe(409);
    const chair2 = await nextStart(st.threadId, role('chair'));
    expect(chair2.message).toContain('Decisions the owner took');
    expect(chair2.message).toContain('Prove demand: with ten paying users');
    expect(chair2.message).toContain('Decision on');
    await finish(chair2);
  });

  it('ends at the round cap with minutes: a synthesis turn, the minutes document, and Pull into PRD', async () => {
    const st = await create({ roundCap: 2, format: 'pre_mortem' });
    await answerRound1(st.threadId);
    const { start: chair } = await chairPicks(
      st.threadId,
      ['cost-hawk', 'user-advocate'].map((k) => slugOf(st, k)),
    );
    void chair;
    // record a disagreement during round 2
    const s1 = await nextStart(st.threadId, role('speaker'));
    expect(s1.message).toContain('Pre-mortem, second look');
    const dis = await call(s1.chatId, 'board.disagreement', {
      topic: 'Pilot now or later',
      positions: ['Cost Hawk|later, after the numbers', 'User Advocate|now, with one customer'],
    });
    expect(dis.ok, dis.error).toBe(true);
    // the same topic is not recorded twice; one position is not a disagreement
    expect(
      (
        await call(s1.chatId, 'board.disagreement', {
          topic: 'pilot now or later',
          positions: ['A|x', 'B|y'],
        })
      ).result.message,
    ).toContain('already recorded');
    expect((await call(s1.chatId, 'board.disagreement', { topic: 'x', positions: ['A|x'] })).ok).toBe(false);
    await finish(s1, 'one');
    const s2 = await nextStart(st.threadId, role('speaker'));
    await finish(s2, 'two');
    // round 2 is the cap: the Chair writes the minutes with the strong model
    const min = await nextStart(st.threadId, role('minutes'));
    expect(min.message).toContain('aom board minutes');
    expect(min.agent.model).toBe('mock');
    expect((await get(st.threadId)).config.stage).toBe('minutes');
    // the minutes verb is for the minutes turn only
    expect((await call(min.chatId, 'board.add', { column: 'ideas', text: 'x' })).ok).toBe(false);
    const saved = await call(min.chatId, 'board.minutes', {
      content:
        '## Positions\n\n- Cost Hawk: later\n\n## Agreements\n\n- Test first\n\n## Open questions\n\n- Unit cost?',
    });
    expect(saved.ok, saved.error).toBe(true);
    await finish(min, 'Saved.');
    await until(async () => (await get(st.threadId)).config.stage === 'ended');
    const fin = await get(st.threadId);
    expect(fin).toMatchObject({ waitingFor: 'ended', config: { endReason: 'round_cap' } });
    expect(fin.config.minutesDocId).toBeTruthy();
    const doc = (await owner('GET', `/api/documents/${fin.config.minutesDocId}`)).document;
    expect(doc).toMatchObject({ kind: 'minutes', status: 'draft', sourceThreadIds: [st.threadId] });
    const content = doc.content as string;
    for (const h of [
      '# Minutes: Should we launch a pilot?',
      '## Cast',
      '## Positions',
      '## Agreements',
      '## Open questions',
      '## Unresolved disagreements',
      '## Whiteboard',
    ]) {
      expect(content).toContain(h);
    }
    expect(content).toContain('Pilot now or later');
    expect(content).toContain('Cost Hawk: later, after the numbers');
    expect(content).toContain('Devil');
    // no more turns once ended; the owner cannot talk to a finished room
    expect((await raw('POST', `/api/board/${st.threadId}/say`, { body: 'hello?' })).status).toBe(409);

    // Pull into PRD: a discovery session in capture, seeded and linked
    await owner(
      'POST',
      `/api/board/${st.threadId}/notes`,
      { column: 'decisions', text: 'Pilot with one customer' },
      201,
    ).catch(() => undefined);
    const pulled = await owner('POST', `/api/board/${st.threadId}/pull-into-prd`, undefined, 201);
    expect(pulled.state.config.prdSessionId).toBe(pulled.discoveryId);
    const ds = (await owner('GET', `/api/discovery/${pulled.discoveryId}`)).state;
    expect(ds.config.phase).toBe('capture');
    expect(ds.config.ceoMode).toBe('owner_only');
    expect(ds.documents.some((d: any) => d.id === pulled.docId && d.kind === 'prd')).toBe(true);
    const prd = (await owner('GET', `/api/documents/${pulled.docId}`)).document;
    expect(prd.content).toContain('Boardroom background');
    expect(prd.content).toContain(fin.config.minutesDocId);
    expect(prd.sourceThreadIds).toContain(st.threadId);
    expect(
      ds.notes.some((n: any) => n.section === 'decisions' && /Pilot with one customer/.test(n.text)),
    ).toBe(true);
    const fac = await nextStart(pulled.discoveryId, (f) => f.message.includes('"role":"facilitator"'));
    expect(fac.message).toContain('"phase":"capture"');
    expect(fac.message).toContain('"hasPrd":true');
    await finish(fac);
    expect((await raw('POST', `/api/board/${st.threadId}/pull-into-prd`)).status).toBe(409);
  });

  it('ends on the owner signal: queued turns are cancelled, the minutes are written, and a failed synthesis still leaves the facts', async () => {
    const st = await create({ roundCap: 5 });
    await answerRound1(st.threadId);
    const chair = await nextStart(st.threadId, role('chair'));
    const ended = await owner('POST', `/api/board/${st.threadId}/end`);
    expect(ended.state.config).toMatchObject({ stage: 'minutes', endReason: 'owner' });
    // the running Chair turn finishes without effect; the synthesis follows
    await finish(chair, 'late');
    const min = await nextStart(st.threadId, role('minutes'));
    // the Chair answers in prose, without the verb: the reply text with headings is used
    await finish(
      min,
      '## Positions\n\n- everyone had a view\n\n## Agreements\n\n- none\n\n## Open questions\n\n- all of it',
    );
    await until(async () => (await get(st.threadId)).config.stage === 'ended');
    const fin = await get(st.threadId);
    expect(fin.config.endReason).toBe('owner');
    const doc = (await owner('GET', `/api/documents/${fin.config.minutesDocId}`)).document;
    expect(doc.content).toContain('everyone had a view');
    expect(doc.content).toContain('by the owner');
    // ending twice is harmless; saying more is refused
    expect((await owner('POST', `/api/board/${st.threadId}/end`)).state.config.stage).toBe('ended');
  });

  it('writes minutes on demand while the session goes on, as a new version of the same document', async () => {
    const st = await create({ roundCap: 4 });
    await answerRound1(st.threadId);
    const chair = await nextStart(st.threadId, role('chair'));
    await owner('POST', `/api/board/${st.threadId}/minutes`, undefined, 202);
    expect((await raw('POST', `/api/board/${st.threadId}/minutes`)).status).toBe(409);
    const min = await nextStart(st.threadId, role('minutes'));
    expect((await call(min.chatId, 'board.minutes', { content: '## Positions\n\n- first take' })).ok).toBe(
      true,
    );
    await finish(min);
    const mid = await get(st.threadId);
    expect(mid.config.stage).toBe('chair');
    const docId = mid.config.minutesDocId;
    expect(docId).toBeTruthy();
    // the Chair's turn goes on and a second request makes version 2
    await call(chair.chatId, 'board.next', { speakers: [slugOf(st, 'cost-hawk')], reason: 'x' });
    await finish(chair);
    await owner('POST', `/api/board/${st.threadId}/minutes`, undefined, 202);
    const min2 = await nextStart(st.threadId, role('minutes'));
    await call(min2.chatId, 'board.minutes', { content: '## Positions\n\n- second take' });
    await finish(min2);
    const doc = (await owner('GET', `/api/documents/${docId}`)).document;
    expect(doc.currentVersion).toBe(2);
    expect(doc.content).toContain('second take');
  });
});

describe('the whiteboard', () => {
  it('lets agents add (capped, no duplicates) and the owner add, move, edit, vote, merge and delete', async () => {
    const st = await create({ roundCap: 4 });
    const starts = [];
    for (let i = 0; i < 3; i++) starts.push(await nextStart(st.threadId, role('speaker')));
    const s = starts[0];
    expect((await call(s.chatId, 'board.add', { column: 'ideas', text: 'Idea one' })).ok).toBe(true);
    expect(
      (await call(s.chatId, 'board.add', { column: 'ideas', text: 'idea one' })).result.message,
    ).toContain('already on the board');
    expect((await call(s.chatId, 'board.add', { column: 'risks', text: 'Risk two' })).ok).toBe(true);
    const third = await call(s.chatId, 'board.add', { column: 'risks', text: 'Risk three' });
    expect(third.ok).toBe(false);
    expect(third.error).toContain('already added 2 notes');
    expect((await call(s.chatId, 'board.add', { column: 'bogus', text: 'x' })).ok).toBe(false);
    for (const x of starts) await finish(x);
    const chair = await nextStart(st.threadId, role('chair'));
    await finish(chair);

    let cur = await get(st.threadId);
    expect(cur.notes.map((n: any) => n.text).sort()).toEqual(['Idea one', 'Risk two']);
    expect(cur.notes[0].byKind).toBe('persona');
    // the owner adds, moves and edits
    cur = (
      await owner('POST', `/api/board/${st.threadId}/notes`, { column: 'questions', text: 'Who pays?' }, 201)
    ).state;
    const mine = cur.notes.find((n: any) => n.text === 'Who pays?');
    expect(mine.byKind).toBe('user');
    cur = (
      await owner('PATCH', `/api/board/${st.threadId}/notes/${mine.id}`, {
        column: 'parked',
        text: 'Who pays? (later)',
      })
    ).state;
    expect(cur.notes.find((n: any) => n.id === mine.id)).toMatchObject({
      column: 'parked',
      text: 'Who pays? (later)',
    });
    expect((await raw('PATCH', `/api/board/${st.threadId}/notes/${mine.id}`, {})).status).toBe(400);
    // vote and unvote
    cur = (await owner('POST', `/api/board/${st.threadId}/notes/${mine.id}/vote`)).state;
    expect(cur.notes.find((n: any) => n.id === mine.id)).toMatchObject({ votes: 1, votedByMe: true });
    cur = (await owner('POST', `/api/board/${st.threadId}/notes/${mine.id}/vote`)).state;
    expect(cur.notes.find((n: any) => n.id === mine.id)).toMatchObject({ votes: 0, votedByMe: false });
    // merge: the first survives with the others' texts; votes are added up; the others disappear
    const [a, b2] = [
      cur.notes.find((n: any) => n.text === 'Idea one'),
      cur.notes.find((n: any) => n.text === 'Risk two'),
    ];
    await owner('POST', `/api/board/${st.threadId}/notes/${a.id}/vote`);
    cur = (
      await owner('POST', `/api/board/${st.threadId}/notes/merge`, {
        noteIds: [a.id, b2.id],
        text: 'Idea one and risk two',
      })
    ).state;
    const merged = cur.notes.find((n: any) => n.id === a.id);
    expect(merged).toMatchObject({ text: 'Idea one and risk two', votes: 1, mergedFrom: ['Risk two'] });
    expect(cur.notes.some((n: any) => n.id === b2.id)).toBe(false);
    expect((await raw('POST', `/api/board/${st.threadId}/notes/merge`, { noteIds: [a.id] })).status).toBe(
      400,
    );
    // delete
    cur = (await owner('DELETE', `/api/board/${st.threadId}/notes/${mine.id}`)).state;
    expect(cur.notes.some((n: any) => n.id === mine.id)).toBe(false);
    expect((await raw('DELETE', `/api/board/${st.threadId}/notes/${mine.id}`)).status).toBe(404);
  });
});

describe('formats, length cap and models', () => {
  it('gives each seat its format assignment: six hats rotate, red and blue are split, option scoring asks for scores', async () => {
    const hats = await create({ format: 'six_hats', roundCap: 2 });
    const starts = [];
    for (let i = 0; i < 3; i++) starts.push(await nextStart(hats.threadId, role('speaker')));
    const labels = starts.map((s) => /"label":"([^"]*)"/.exec(s.message)?.[1]);
    expect(new Set(labels).size).toBe(3);
    expect(labels.every((l) => /hat$/.test(l as string))).toBe(true);
    for (const s of starts) await finish(s);
    await finish(await nextStart(hats.threadId, role('chair')));

    const rb = await create({ format: 'red_blue', roundCap: 2 });
    const rbs = [];
    for (let i = 0; i < 3; i++) rbs.push(await nextStart(rb.threadId, role('speaker')));
    expect(rbs.map((s) => /"label":"([^"]*)"/.exec(s.message)?.[1]).sort()).toEqual([
      'Blue team',
      'Red team',
      'Red team',
    ]);
    for (const s of rbs) await finish(s);
    await finish(await nextStart(rb.threadId, role('chair')));

    const os = await create({
      format: 'option_scoring',
      brief: 'Options: A pilot, B partner, C wait',
      roundCap: 2,
    });
    const oss = await nextStart(os.threadId, role('speaker'));
    expect(oss.message).toContain('Score each option from 1');
    await finish(oss);
    for (let i = 0; i < 2; i++) await finish(await nextStart(os.threadId, role('speaker')));
    await finish(await nextStart(os.threadId, role('chair')));
  });

  it('cuts a speaker that ignores the length cap, and runs personas, the Chair and the minutes on the chosen models', async () => {
    const st = await create({
      roundCap: 2,
      models: {
        persona: { runtime: 'mock', model: 'mock' },
        chair: { runtime: 'mock', model: 'mock' },
        synthesis: { runtime: 'mock', model: 'mock' },
      },
      cast: [
        { kind: 'persona', refId: 'devils-advocate', model: { runtime: 'mock', model: 'mock' } },
        { kind: 'persona', refId: 'user-advocate' },
        {
          kind: 'persona',
          refId: 'ad-hoc-regulator',
          stance: 'A cautious compliance officer',
          displayName: 'Regulator',
          seat: 'Compliance',
        },
      ],
    });
    expect(st.cast.find((c: any) => c.refId === 'ad-hoc-regulator')).toMatchObject({
      displayName: 'Regulator',
      seat: 'Compliance',
      stance: 'A cautious compliance officer',
      slug: 'regulator',
    });
    const starts = [];
    for (let i = 0; i < 3; i++) starts.push(await nextStart(st.threadId, role('speaker')));
    const reg = starts.find((s) => speakerOf(s) === 'ad-hoc-regulator');
    expect(reg.message).toContain(
      'Your stance (hold it, whatever the others say): A cautious compliance officer',
    );
    expect(reg.message).toContain('seated as Compliance');
    const long = 'This is a long sentence that goes on. '.repeat(80);
    await finish(starts[0], long);
    const msg = (
      await q(
        `SELECT body, data FROM thread_messages WHERE id=(SELECT message_id FROM session_turns WHERE id=$1)`,
        [starts[0].chatId],
      )
    )[0];
    expect(msg.body.length).toBeLessThan(1500);
    expect(msg.body.endsWith('…')).toBe(true);
    expect(msg.data.truncated).toBe(true);
    expect(msg.data.purpose).toBe('board_speaker');
    for (const s of starts.slice(1)) await finish(s);
    await finish(await nextStart(st.threadId, role('chair')));
  });

  it('defaults to cheap models for personas and the Chair and the strongest for the minutes, falling back to what the workstation offers', async () => {
    const { defaultModelFor } = await import('../src/sessions/board-state.ts');
    expect(defaultModelFor('persona', ['claude-code'])).toEqual({ runtime: 'claude-code', model: 'haiku' });
    expect(defaultModelFor('chair', ['claude-code'])).toEqual({ runtime: 'claude-code', model: 'sonnet' });
    expect(defaultModelFor('synthesis', ['claude-code'])).toEqual({ runtime: 'claude-code', model: 'opus' });
    expect(defaultModelFor('synthesis', ['mock'])).toEqual({ runtime: 'mock', model: 'mock' });
    expect(defaultModelFor('persona', [])).toEqual({ runtime: 'claude-code', model: 'haiku' });
  });
});

describe('suggesting a cast and saved rooms', () => {
  it('asks the Chair for a cast, keeps the suggestions, and starts the room from them', async () => {
    const sug = (
      await owner(
        'POST',
        '/api/board/suggest',
        { topic: 'Should we open a second office?', format: 'open' },
        201,
      )
    ).state;
    expect(sug.config).toMatchObject({ stage: 'setup', suggestState: 'asking' });
    expect(sug.waitingFor).toBe('cast');
    expect(sug.cast).toEqual([]);
    const turn = await nextStart(sug.threadId, role('cast'));
    expect(turn.session.speaker.personaKey).toBe('chair');
    expect(turn.message).toContain('second office');
    expect(turn.message).toContain('devils-advocate');
    expect(turn.message).not.toContain('- chair:');
    expect((await call(turn.chatId, 'board.cast', { persona: 'cost-hawk', why: 'money' })).ok).toBe(true);
    expect((await call(turn.chatId, 'board.cast', { persona: 'security', why: 'risk' })).ok).toBe(true);
    expect((await call(turn.chatId, 'board.cast', { persona: 'chair', why: 'x' })).ok).toBe(false);
    expect((await call(turn.chatId, 'board.cast', { persona: 'not-a-persona', why: 'x' })).ok).toBe(false);
    expect(
      (
        await call(turn.chatId, 'board.cast', {
          name: 'Neighbour',
          brief: 'The person next door who hears the noise',
          why: 'local view',
        })
      ).ok,
    ).toBe(true);
    expect((await call(turn.chatId, 'board.add', { column: 'ideas', text: 'x' })).ok).toBe(false);
    await finish(turn, 'Here is a cast.');
    const st = await get(sug.threadId);
    expect(st.config.suggestState).toBe('done');
    expect(st.suggestions.map((s: any) => s.name)).toEqual(['Cost Hawk', 'Security', 'Neighbour']);
    expect(st.suggestions[2]).toMatchObject({
      type: 'adhoc',
      brief: 'The person next door who hears the noise',
    });
    // a boardroom in setup does not run anything
    expect((await raw('POST', `/api/board/${sug.threadId}/say`, { body: 'hi' })).status).toBe(409);
    const started = (
      await owner('POST', `/api/board/${sug.threadId}/start`, {
        topic: 'Should we open a second office?',
        roundCap: 2,
        cast: [
          { kind: 'persona', refId: 'cost-hawk' },
          { kind: 'persona', refId: 'security' },
          {
            kind: 'persona',
            refId: 'ad-hoc-neighbour',
            displayName: 'Neighbour',
            stance: 'The person next door who hears the noise',
          },
        ],
      })
    ).state;
    expect(started.config).toMatchObject({ stage: 'round', round: 1, suggestState: null });
    expect(started.cast).toHaveLength(3);
    for (let i = 0; i < 3; i++) await finish(await nextStart(sug.threadId, role('speaker')));
    await finish(await nextStart(sug.threadId, role('chair')));
    expect((await raw('POST', `/api/board/${sug.threadId}/start`, { topic: 'x', cast: CAST })).status).toBe(
      409,
    );
  });

  it('saves a cast as a room, lists it, creates a boardroom from it and deletes it; only managers may', async () => {
    const room = (
      await owner(
        'POST',
        '/api/board-rooms',
        {
          name: 'Product review',
          format: 'pre_mortem',
          roundCap: 3,
          cast: [
            { kind: 'persona', refId: 'devils-advocate' },
            { kind: 'persona', refId: 'user-advocate' },
          ],
        },
        201,
      )
    ).room;
    expect(room).toMatchObject({ name: 'Product review', format: 'pre_mortem', roundCap: 3 });
    const list = (await owner('GET', '/api/board-rooms')).rooms as any[];
    expect(list.map((x) => x.id)).toContain(room.id);
    const st = await create({
      cast: room.cast,
      format: room.format,
      roundCap: room.roundCap,
      roomId: room.id,
    });
    expect(st.cast).toHaveLength(2);
    expect(st.config.format).toBe('pre_mortem');
    for (let i = 0; i < 2; i++) await finish(await nextStart(st.threadId, role('speaker')));
    await finish(await nextStart(st.threadId, role('chair')));
    await owner('DELETE', `/api/board-rooms/${room.id}`, undefined, 204);
    expect(((await owner('GET', '/api/board-rooms')).rooms as any[]).some((x) => x.id === room.id)).toBe(
      false,
    );
    expect((await raw('DELETE', `/api/board-rooms/${room.id}`)).status).toBe(404);
    // a cast needs two seats and no chair
    expect(
      (await raw('POST', '/api/board-rooms', { name: 'x', cast: [{ kind: 'persona', refId: 'security' }] }))
        .status,
    ).toBe(400);
    expect(
      (
        await raw('POST', '/api/board', {
          topic: 'x',
          cast: [
            { kind: 'persona', refId: 'chair' },
            { kind: 'persona', refId: 'security' },
          ],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await raw('POST', '/api/board', {
          topic: 'x',
          cast: [
            { kind: 'persona', refId: 'security' },
            { kind: 'persona', refId: 'security' },
          ],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await raw('POST', '/api/board', {
          topic: 'x',
          cast: [
            { kind: 'persona', refId: 'nope-persona' },
            { kind: 'persona', refId: 'security' },
          ],
        })
      ).status,
    ).toBe(400);
    // another organization sees none of it
    const other = await w.t.userSession(`other-${randomUUID().slice(0, 6)}@example.com`);
    expect(((await w.t.req('GET', '/api/board-rooms', { cookie: other.cookie })).body as any).rooms).toEqual(
      [],
    );
  });

  it('seats a real agent next to the personas', async () => {
    const ag = await w.hire(`Rae${Math.random().toString(36).slice(2, 6)}`, 'ba', 'senior');
    const st = await create({
      cast: [
        { kind: 'agent', refId: ag.agent?.id ?? ag.id, seat: 'Business analyst' },
        { kind: 'persona', refId: 'cost-hawk' },
      ],
      roundCap: 2,
    });
    const starts = [
      await nextStart(st.threadId, role('speaker')),
      await nextStart(st.threadId, role('speaker')),
    ];
    const agent = starts.find((s) => s.session.speaker.kind === 'agent');
    expect(agent.agent.roleKey).toBe('ba');
    expect(agent.message).toContain('seated as Business analyst');
    for (const s of starts) await finish(s);
    await finish(await nextStart(st.threadId, role('chair')));
  });
});

describe('a seat that is gone', () => {
  it('drops an agent that was retired mid-session and goes on with the others', async () => {
    const ag = await w.hire(`Gil${Math.random().toString(36).slice(2, 6)}`, 'ba', 'senior');
    const agentId = ag.agent?.id ?? ag.id;
    const st = await create({
      cast: [
        { kind: 'agent', refId: agentId },
        { kind: 'persona', refId: 'cost-hawk' },
        { kind: 'persona', refId: 'user-advocate' },
      ],
      roundCap: 3,
    });
    for (let i = 0; i < 3; i++) await finish(await nextStart(st.threadId, role('speaker')));
    const chair = await nextStart(st.threadId, role('chair'));
    await q(`UPDATE agents SET status='retired' WHERE id=$1`, [agentId]);
    const agentSlug = st.cast.find((c: any) => c.refId === agentId).slug;
    const pick = await call(chair.chatId, 'board.next', {
      speakers: [agentSlug, slugOf(st, 'cost-hawk')],
      reason: 'x',
    });
    expect(pick.ok, pick.error).toBe(true);
    await finish(chair);
    const spk = await nextStart(st.threadId, role('speaker'));
    expect(speakerOf(spk)).toBe('cost-hawk');
    const mid = await get(st.threadId);
    expect(mid.cast.map((c: any) => c.refId)).toEqual(['cost-hawk', 'user-advocate']);
    const msgs = (await owner('GET', `/api/threads/${st.threadId}/messages`)).messages as any[];
    expect(
      msgs.some((m) => m.kind === 'system' && /no longer available and left the room/.test(m.body)),
    ).toBe(true);
    await finish(spk);
    await finish(await nextStart(st.threadId, role('chair')));
  });
});

describe('cost, budget, pause and restart', () => {
  it('shows a live cost meter and an estimate of the next round, and stops at the session budget until it is raised', async () => {
    const st = await create({ budgetUsd: 0.5, roundCap: 4 });
    expect(st.estimate).toMatchObject({ speakers: 3, basis: 'default' });
    expect(st.cost).toMatchObject({ turns: 0, budgetUsd: 0.5, exceeded: false });
    const starts = [];
    for (let i = 0; i < 3; i++) starts.push(await nextStart(st.threadId, role('speaker')));
    // 2M input tokens on the mock model price: well above 0.5 USD
    await finish(starts[0], 'a', { inputTokens: 2_000_000, outputTokens: 500_000 });
    let mid = await get(st.threadId);
    expect(mid.cost.turns).toBe(1);
    expect(mid.cost.costUsd).toBeGreaterThan(0.5);
    expect(mid.cost.exceeded).toBe(true);
    expect(mid.estimate.basis).toBe('average');
    await finish(starts[1]);
    await finish(starts[2]);
    // the Chair cannot be queued: the room stops and says so
    await until(async () => (await get(st.threadId)).config.budgetStopped === true);
    mid = await get(st.threadId);
    expect(mid.config.budgetStopped).toBe(true);
    const msgs = (await owner('GET', `/api/threads/${st.threadId}/messages`)).messages as any[];
    expect(msgs.filter((m) => m.kind === 'system' && /used its budget of \$0\.50/.test(m.body))).toHaveLength(
      1,
    );
    // the sweep does not repeat the message
    await w.t.app.ctx.services.board.sweep();
    expect(
      ((await owner('GET', `/api/threads/${st.threadId}/messages`)).messages as any[]).filter((m) =>
        /used its budget/.test(m.body),
      ),
    ).toHaveLength(1);
    expect(
      r.received.filter(
        (f: any) => f.type === 'chat.start' && !seen.has(f.chatId) && f.threadId === st.threadId,
      ),
    ).toHaveLength(0);
    mid = (await owner('PATCH', `/api/board/${st.threadId}`, { budgetUsd: 1000 })).state;
    expect(mid.config.budgetStopped).toBe(false);
    await finish(await nextStart(st.threadId, role('chair')));
  });

  it('keeps everything across a pause and goes on at resume; a server that missed a turn end is caught by the sweep', async () => {
    const st = await create({ roundCap: 4 });
    const starts = [];
    for (let i = 0; i < 3; i++) starts.push(await nextStart(st.threadId, role('speaker')));
    await finish(starts[0]);
    await owner('POST', `/api/board/${st.threadId}/pause`);
    await finish(starts[1]);
    await finish(starts[2]);
    let mid = await get(st.threadId);
    expect(mid.waitingFor).toBe('paused');
    expect(mid.config.stage).toBe('round');
    await new Promise((res) => setTimeout(res, 300));
    expect(
      r.received.filter(
        (f: any) => f.type === 'chat.start' && !seen.has(f.chatId) && f.threadId === st.threadId,
      ),
    ).toHaveLength(0);
    mid = (await owner('POST', `/api/board/${st.threadId}/resume`)).state;
    const chair = await nextStart(st.threadId, role('chair'));
    await finish(chair);
    // a restart that lost the follow-up of a turn: nothing is queued, the sweep does it
    const chair2 = await nextStart(st.threadId, role('chair'));
    expect(
      (await call(chair2.chatId, 'board.next', { speakers: [slugOf(st, 'cost-hawk')], reason: 'x' })).ok,
    ).toBe(true);
    const board = w.t.app.ctx.services.board;
    const original = board.onTurnEnded.bind(board);
    board.onTurnEnded = async () => undefined;
    try {
      await finish(chair2);
      await new Promise((res) => setTimeout(res, 300));
      expect(
        r.received.filter(
          (f: any) => f.type === 'chat.start' && !seen.has(f.chatId) && f.threadId === st.threadId,
        ),
      ).toHaveLength(0);
    } finally {
      board.onTurnEnded = original;
    }
    await board.sweep();
    const spk = await nextStart(st.threadId, role('speaker'));
    expect(spk.message).toContain('"kind":"discussion"');
    await finish(spk);
    const chair3 = await nextStart(st.threadId, role('chair'));
    expect(chair3.message).toContain('Round 2 is over');
    await finish(chair3);
  });

  it('refuses a boardroom turn on a runner that cannot run the board verbs', async () => {
    const old = await w.connectRunner({ capabilities: [SESSION_TURNS_CAPABILITY, SESSION_VERBS_CAPABILITY] });
    r.close();
    await until(async () => w.t.app.ctx.services.runners.isOnline(w.workstationId), 3000);
    const st = await create({ roundCap: 2 });
    await until(async () => (await get(st.threadId)).turns.some((t: any) => t.status === 'failed'), 10_000);
    const failed = (await get(st.threadId)).turns.find((t: any) => t.status === 'failed');
    expect(failed.error).toContain('runner_too_old');
    expect(failed.error).toContain('boardroom');
    old.close();
    await until(async () => !w.t.app.ctx.services.runners.isOnline(w.workstationId), 3000);
    r = await w.connectRunner({ capabilities: CAPS });
  });
});

describe('access and replay', () => {
  it('keeps a boardroom private to its participants and apart from discovery sessions', async () => {
    const st = await create({ roundCap: 2 });
    const stranger = await w.t.userSession(`stranger-${randomUUID().slice(0, 6)}@example.com`);
    const as = (m: string, u: string, body?: unknown) =>
      w.t.req(m, u, { cookie: stranger.cookie, ...(body ? { body } : {}) });
    expect((await as('GET', `/api/board/${st.threadId}`)).status).toBe(404);
    expect((await as('POST', `/api/board/${st.threadId}/say`, { body: 'hi' })).status).toBe(404);
    expect((await as('POST', `/api/board/${st.threadId}/end`)).status).toBe(404);
    expect((await as('POST', `/api/board/${st.threadId}/notes`, { column: 'ideas', text: 'x' })).status).toBe(
      404,
    );
    expect((await as('GET', `/api/threads/${st.threadId}/messages`)).status).toBe(404);
    expect((await w.t.req('GET', `/api/board/${st.threadId}`)).status).toBe(401);
    // the two kinds of session do not answer each other's routes
    expect((await raw('GET', `/api/discovery/${st.threadId}`)).status).toBe(404);
    const disc = (await owner('POST', '/api/discovery', { title: 'x', idea: 'y' }, 201)).state;
    expect((await raw('GET', `/api/board/${disc.threadId}`)).status).toBe(404);
    // a boardroom turn is not reachable through a discovery verb and the other way round
    for (let i = 0; i < 3; i++) await finish(await nextStart(st.threadId, role('speaker')));
    const facilitator = await nextStart(disc.threadId, role('facilitator'));
    expect((await call(facilitator.chatId, 'board.add', { column: 'ideas', text: 'x' })).ok).toBe(false);
    await finish(facilitator);
    await finish(await nextStart(st.threadId, role('chair')));
  });

  it('rebuilds to the same whiteboard, rounds, disagreements, decisions, rooms, minutes and costs', async () => {
    const tables = [
      'board_notes',
      'board_rounds',
      'board_disagreements',
      'board_decisions',
      'board_rooms',
      'session_turns',
      'thread_participants',
      'documents',
      'document_versions',
    ];
    const snap = async () => {
      const out: Record<string, unknown> = {};
      for (const t of tables) out[t] = await q(`SELECT * FROM ${t} ORDER BY 1, 2`);
      out.costs = await q(
        `SELECT shift_id, kind, model, cost_usd_micros, project_id FROM shift_costs WHERE kind='session' ORDER BY shift_id`,
      );
      out.threads = await q(
        `SELECT id, title, session_config FROM threads WHERE kind='boardroom' ORDER BY id`,
      );
      return JSON.parse(JSON.stringify(out));
    };
    const before = await snap();
    expect((before.board_notes as unknown[]).length).toBeGreaterThan(3);
    expect((before.board_rounds as unknown[]).length).toBeGreaterThan(3);
    expect((before.board_disagreements as unknown[]).length).toBeGreaterThan(0);
    expect((before.board_decisions as unknown[]).length).toBeGreaterThan(0);
    expect((before.board_rooms as unknown[]).length).toBeGreaterThan(0);
    expect(PROJECTION_TABLES).toEqual(
      expect.arrayContaining([
        'board_notes',
        'board_rounds',
        'board_disagreements',
        'board_decisions',
        'board_rooms',
      ]),
    );
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store, w.t.clock.now());
    expect(await snap()).toEqual(before);
  });
});

describe('Pull into PRD with a CEO', () => {
  it('starts the discovery session in joint mode when the organization has a CEO, and the CEO proposes on the seeded session', async () => {
    await appoint(w);
    // a one-round session ends at once: the minutes follow round 1
    const st = await create({ roundCap: 1 });
    await answerRound1(st.threadId);
    const min = await nextStart(st.threadId, role('minutes'));
    expect(
      (await call(min.chatId, 'board.minutes', { content: '## Positions\n\n- all three answered' })).ok,
    ).toBe(true);
    await finish(min, 'Saved.');
    await until(async () => (await get(st.threadId)).config.stage === 'ended');
    const pulled = await owner('POST', `/api/board/${st.threadId}/pull-into-prd`, undefined, 201);
    const ds = (await owner('GET', `/api/discovery/${pulled.discoveryId}`)).state;
    expect(ds.config).toMatchObject({ phase: 'capture', ceoMode: 'joint' });
    expect(ds.ceoAvailable).toBe(true);
    const fac = await nextStart(pulled.discoveryId, (f) => f.message.includes('"role":"facilitator"'));
    expect(fac.message).toContain('"phase":"capture"');
    expect(fac.message).toContain('"ceoMode":"joint"');
    await finish(fac);
  });
});

describe('review fixes: authority, decisions, minutes and pull-into-prd', () => {
  it('lets only the creator or a manager steer; a plain participant may still post', async () => {
    const st = await create({ roundCap: 3 });
    const member = await w.t.userSession(`member-${randomUUID().slice(0, 6)}@example.com`);
    await w.t.addOrgMember(w.owner.id, member.id, 'member');
    await owner(
      'POST',
      `/api/sessions/${st.threadId}/participants`,
      { kind: 'user', refId: member.id, seat: 'member' },
      201,
    );
    const as = (m: string, u: string, body?: unknown) =>
      w.t.req(m, u, { cookie: member.cookie, ...(body ? { body } : {}) });
    for (const verb of ['pause', 'resume', 'continue', 'end', 'minutes'])
      expect((await as('POST', `/api/board/${st.threadId}/${verb}`)).status, verb).toBe(403);
    expect(
      (await as('POST', `/api/board/${st.threadId}/decisions/${randomUUID()}/resolve`, { answer: 'x' }))
        .status,
    ).toBe(403);
    expect((await as('POST', `/api/board/${st.threadId}/say`, { body: 'a thought' })).status).toBe(201);
    expect((await get(st.threadId)).config.stage).toBe('round');
  });

  it('takes a decision once, refuses one after the session moved on, and withdraws it when the session ends', async () => {
    const st = await create({ roundCap: 4 });
    await answerRound1(st.threadId);
    const chair = await nextStart(st.threadId, role('chair'));
    await call(chair.chatId, 'board.pause', { question: 'Go or no go?', options: ['Go', 'No go'] });
    await finish(chair, 'Over to you.');
    const d = (await get(st.threadId)).decisions[0];
    // minutes cannot be requested while a decision is open
    expect((await raw('POST', `/api/board/${st.threadId}/minutes`)).status).toBe(409);
    const url = `/api/board/${st.threadId}/decisions/${d.id}/resolve`;
    const both = await Promise.all([
      raw('POST', url, { optionId: 'o1', answer: 'now' }),
      raw('POST', url, { optionId: 'o1', answer: 'now' }),
    ]);
    expect(both.map((x) => x.status).sort()).toEqual([200, 409]);
    const posted = await q(`SELECT 1 FROM thread_messages WHERE thread_id=$1 AND body LIKE 'Decision on%'`, [
      st.threadId,
    ]);
    expect(posted).toHaveLength(1);
    await finish(await nextStart(st.threadId, role('chair')));
  });

  it('withdraws an open decision when the owner ends the session and refuses to answer it afterwards', async () => {
    const st = await create({ roundCap: 4 });
    await answerRound1(st.threadId);
    const chair = await nextStart(st.threadId, role('chair'));
    await call(chair.chatId, 'board.pause', { question: 'Ship it?', options: ['Yes', 'No'] });
    await finish(chair, 'Over to you.');
    const d = (await get(st.threadId)).decisions[0];
    await owner('POST', `/api/board/${st.threadId}/end`);
    const after = await get(st.threadId);
    expect(after.config.stage).toBe('minutes');
    expect(after.decisions[0].status).toBe('withdrawn');
    const res = await raw('POST', `/api/board/${st.threadId}/decisions/${d.id}/resolve`, { answer: 'late' });
    expect(res.status).toBe(409);
    expect((await get(st.threadId)).config.stage).toBe('minutes');
    await finish(await nextStart(st.threadId, role('minutes')), 'x');
  });

  it('stays in the minutes stage with a block that is not the budget, instead of ending without a synthesis', async () => {
    const st = await create({ roundCap: 5, projectId: w.projectId });
    await answerRound1(st.threadId);
    const chair = await nextStart(st.threadId, role('chair'));
    await q('UPDATE projects SET paused_at=now() WHERE id=$1', [w.projectId]);
    try {
      await owner('POST', `/api/board/${st.threadId}/end`);
      await finish(chair, 'late');
      await until(
        async () =>
          (await q(`SELECT session_config->>'blocked' b FROM threads WHERE id=$1`, [st.threadId]))[0]?.b ===
          'project_paused',
      );
      await new Promise((res) => setTimeout(res, 300));
      expect((await get(st.threadId)).config.stage).toBe('minutes');
    } finally {
      await q('UPDATE projects SET paused_at=NULL WHERE id=$1', [w.projectId]);
    }
    await owner('POST', `/api/board/${st.threadId}/continue`);
    await finish(await nextStart(st.threadId, role('minutes')), 'x');
  });

  it('pulls into a PRD only once the session ended, links the discovery session to the PRD, and is repeatable', async () => {
    const st = await create({ roundCap: 1 });
    await answerRound1(st.threadId);
    const min = await nextStart(st.threadId, role('minutes'));
    // not ended yet
    expect((await raw('POST', `/api/board/${st.threadId}/pull-into-prd`)).status).toBe(409);
    await call(min.chatId, 'board.minutes', { content: '## Positions\n\n- all three answered' });
    await finish(min, 'Saved.');
    await until(async () => (await get(st.threadId)).config.stage === 'ended');
    const results = await Promise.all([
      raw('POST', `/api/board/${st.threadId}/pull-into-prd`),
      raw('POST', `/api/board/${st.threadId}/pull-into-prd`),
    ]);
    expect(results.map((x) => x.status).sort()).toEqual([201, 409]);
    const ok1 = results.find((x) => x.status === 201) as any;
    const body = ok1.body;
    const doc = (await q('SELECT source_thread_ids FROM documents WHERE id=$1', [body.docId]))[0];
    expect(doc.source_thread_ids).toContain(body.discoveryId);
    expect(doc.source_thread_ids).toContain(st.threadId);
    expect(
      await q(`SELECT 1 FROM documents WHERE kind='prd' AND source_thread_ids @> ARRAY[$1]::uuid[]`, [
        st.threadId,
      ]),
    ).toHaveLength(1);
    await finish(await nextStart(body.discoveryId, (f) => f.message.includes('"role":"facilitator"')));
  });
});
