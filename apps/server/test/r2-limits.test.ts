import { BOARD_VERBS_CAPABILITY, SESSION_TURNS_CAPABILITY, SESSION_VERBS_CAPABILITY } from '@aom/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { kit, q } from './helpers/sessions-r2.ts';
import { createWorld, until, type World } from './helpers/world.ts';

/**
 * Revision R2, session limits: the optional time limit (warning, time is up, extend, wrap up; paused time does not count;
 * durable and replay-safe) for Discovery and Boardroom, and the cost limit at minutes time (ask the creator, never write
 * the minutes silently without the Chair's summary).
 */
let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({
    capabilities: [SESSION_TURNS_CAPABILITY, SESSION_VERBS_CAPABILITY, BOARD_VERBS_CAPABILITY],
  });
  K = kit(w, () => r);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});
let K: ReturnType<typeof kit>;
afterEach(async () => {
  await K.cleanup();
});
const boardSvc = () => w.t.app.ctx.services.board;
const discSvc = () => w.t.app.ctx.services.discovery;
const sweeps = [() => boardSvc().sweep(), () => discSvc().sweep()];
const messages = async (id: string) =>
  (await K.owner('GET', `/api/threads/${id}/messages`)).messages as any[];

describe('Boardroom time limit', () => {
  it('counts only running time, warns with five minutes left, and stops new turns at time-up until the creator extends', async () => {
    const st = await K.createBoard({ timeLimitMinutes: 15 });
    expect(st.time).toMatchObject({ limitMinutes: 15, running: true, up: false, warned: false });
    const starts = [];
    for (let i = 0; i < 4; i++) starts.push(await K.nextStart(st.threadId, K.role('speaker')));

    await K.tickMinutes(3, sweeps);
    let s = await K.board(st.threadId);
    expect(s.time.elapsedMs).toBeGreaterThanOrEqual(2 * 60_000);
    expect(s.time.elapsedMs).toBeLessThanOrEqual(3 * 60_000 + 1000);
    expect(s.time.warned).toBe(false);

    // paused time does not count
    await K.owner('POST', `/api/board/${st.threadId}/pause`);
    const atPause = (await K.board(st.threadId)).time.elapsedMs;
    await K.tickMinutes(20, sweeps);
    s = await K.board(st.threadId);
    expect(s.time.running).toBe(false);
    expect(s.time.elapsedMs).toBe(atPause);
    await K.owner('POST', `/api/board/${st.threadId}/resume`);
    s = await K.board(st.threadId);
    expect(Math.abs(s.time.elapsedMs - atPause)).toBeLessThan(3000);
    expect(s.time.running).toBe(true);

    // the warning comes once, in the last five minutes
    await K.tickMinutes(8, sweeps);
    s = await K.board(st.threadId);
    expect(s.time.warned).toBe(true);
    expect(s.time.up).toBe(false);
    await K.tickMinutes(1, sweeps);
    expect(
      (await messages(st.threadId)).filter((m) => m.kind === 'system' && /minutes? left/.test(m.body)),
    ).toHaveLength(1);

    // the clock is durable: a replay of the events gives the same state
    const before = (await q('SELECT session_config FROM threads WHERE id=$1', [st.threadId]))[0]
      .session_config;
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store, w.t.clock.now());
    const after = (await q('SELECT session_config FROM threads WHERE id=$1', [st.threadId]))[0]
      .session_config;
    expect(after).toEqual(before);

    // time is up
    await K.tickMinutes(5, sweeps);
    s = await K.board(st.threadId);
    expect(s.time).toMatchObject({ up: true, running: false });
    expect(s.waitingFor).toBe('time');
    // the turns of the round in flight finish (all five were queued before), but the Chair does not start the next round
    for (const x of starts) await K.finish(x);
    await K.finish(await K.nextStart(st.threadId, K.role('speaker')));
    expect(await K.quiet(st.threadId)).toHaveLength(0);
    expect((await K.board(st.threadId)).config.stage).toBe('round');

    // a member who is not the creator cannot decide
    const member = await w.t.userSession('r2-limit-member@example.test');
    await w.t.addOrgMember(w.owner.id, member.id, 'member');
    await K.owner(
      'POST',
      `/api/sessions/${st.threadId}/participants`,
      { kind: 'user', refId: member.id, seat: 'guest' },
      201,
    );
    expect(
      (await K.as(member.cookie)('POST', `/api/board/${st.threadId}/time`, { action: 'extend', minutes: 10 }))
        .status,
    ).toBe(403);
    // an odd amount is refused
    expect(
      (await K.raw('POST', `/api/board/${st.threadId}/time`, { action: 'extend', minutes: 7 })).status,
    ).toBe(400);

    // extend: the session goes on from where it stopped, and the warning will come again
    s = (await K.owner('POST', `/api/board/${st.threadId}/time`, { action: 'extend', minutes: 15 })).state;
    expect(s.time).toMatchObject({ up: false, warned: false, running: true });
    expect(s.time.limitMinutes).toBeGreaterThanOrEqual(15 + 15);
    // the round that was waiting is completed: the Chair now picks the next speakers
    await K.nextStart(st.threadId, K.role('chair'));
  });

  it('wraps up on request: the Chair writes the minutes, ended by the time limit', async () => {
    const st = await K.createBoard({ timeLimitMinutes: 5 });
    const running: any[] = [];
    for (let i = 0; i < 4; i++) running.push(await K.nextStart(st.threadId, K.role('speaker')));
    await K.tickMinutes(6, sweeps);
    let s = await K.board(st.threadId);
    expect(s.time.up).toBe(true);
    for (const x of running) await K.finish(x);
    await K.finish(await K.nextStart(st.threadId, K.role('speaker')));
    s = (await K.owner('POST', `/api/board/${st.threadId}/time`, { action: 'wrap_up' })).state;
    expect(s.config.stage).toBe('minutes');
    expect(s.config.endReason).toBe('time');
    expect(s.time.up).toBe(false);
    const min = await K.nextStart(st.threadId, K.role('minutes'));
    expect(min.message).toContain('time limit reached');
    await K.call(min.chatId, 'board.minutes', {
      content: '## Positions\n\n- all\n## Agreements\n\n- none\n## Open questions\n\n- x',
    });
    await K.finish(min);
    await until(async () => (await K.board(st.threadId)).config.stage === 'ended');
  });

  it('steers to a final round after the warning: the Chair is told, speakers conclude, then the minutes follow', async () => {
    const st = await K.createBoard({ timeLimitMinutes: 15, roundCap: 6 });
    const first: any[] = [];
    for (let i = 0; i < 4; i++) first.push(await K.nextStart(st.threadId, K.role('speaker')));
    await K.tickMinutes(11, sweeps);
    expect((await K.board(st.threadId)).time.warned).toBe(true);
    await K.finish(first[0]);
    first.push(await K.nextStart(st.threadId, K.role('speaker')));
    for (const x of first.slice(1)) await K.finish(x);
    const chair = await K.nextStart(st.threadId, K.role('chair'));
    expect(chair.message).toContain('TIME: about');
    const slug = (await K.board(st.threadId)).cast.find((c: any) => c.refId === 'security').slug;
    expect((await K.call(chair.chatId, 'board.next', { speakers: [slug], reason: 'Wrap up' })).ok).toBe(true);
    await K.finish(chair);
    const last = await K.nextStart(st.threadId, K.role('speaker'));
    expect(last.message).toContain('This is the final round');
    await K.finish(last);
    const s = await until(async () => (await K.board(st.threadId)).config.stage === 'minutes', 15_000).then(
      () => K.board(st.threadId),
    );
    expect(s.config.endReason).toBe('time');
    await K.nextStart(st.threadId, K.role('minutes'));
  });

  it('keeps the clock running while the room waits for the creator at a decision (Q51), and warns and times out there', async () => {
    const st = await K.createBoard({ timeLimitMinutes: 20, roundCap: 4 });
    for (let i = 0; i < 5; i++) await K.finish(await K.nextStart(st.threadId, K.role('speaker')));
    const chair = await K.nextStart(st.threadId, K.role('chair'));
    expect(
      (await K.call(chair.chatId, 'board.pause', { question: 'Pilot first?', options: ['Yes', 'No'] })).ok,
    ).toBe(true);
    await K.finish(chair, 'Over to you.');
    let s = await K.board(st.threadId);
    expect(s.config.stage).toBe('decision');
    expect(s.time.running).toBe(true);
    const at = s.time.elapsedMs;
    await K.tickMinutes(16, sweeps);
    s = await K.board(st.threadId);
    expect(s.time.elapsedMs - at).toBeGreaterThanOrEqual(15 * 60_000);
    expect(s.time.warned).toBe(true);
    // a pause still stops it
    await K.owner('POST', `/api/board/${st.threadId}/pause`);
    const atPause = (await K.board(st.threadId)).time.elapsedMs;
    await K.tickMinutes(5, sweeps);
    expect((await K.board(st.threadId)).time.elapsedMs).toBe(atPause);
    await K.owner('POST', `/api/board/${st.threadId}/resume`);
    await K.tickMinutes(5, sweeps);
    s = await K.board(st.threadId);
    expect(s.time).toMatchObject({ up: true, running: false });
    expect(s.config.stage).toBe('decision');
  });

  it('sets, changes and removes the limit from the settings', async () => {
    const st = await K.createBoard();
    expect(st.time.limitMinutes).toBeNull();
    let s = (await K.owner('PATCH', `/api/board/${st.threadId}`, { timeLimitMinutes: 30 })).state;
    expect(s.time.limitMinutes).toBe(30);
    expect(s.time.elapsedMs).toBeLessThan(3000);
    s = (await K.owner('PATCH', `/api/board/${st.threadId}`, { timeLimitMinutes: null })).state;
    expect(s.time.limitMinutes).toBeNull();
  });
});

describe('Archiving a running boardroom (Q53)', () => {
  it('is refused without endFirst; with it the boardroom ends, the minutes are written, and it is archived after', async () => {
    const st = await K.createBoard({ roundCap: 3 });
    for (let i = 0; i < 5; i++) await K.finish(await K.nextStart(st.threadId, K.role('speaker')));
    const first = await K.nextStart(st.threadId, K.role('chair'));
    // the server refuses to archive a running session by itself
    const refused = await K.raw('POST', `/api/sessions/${st.threadId}/archive`, { archived: true });
    expect(refused.status).toBe(409);
    expect((await K.board(st.threadId)).config.archived).toBeFalsy();
    // a member who does not manage the session cannot do it either
    const member = await w.t.userSession('r2-archive-member@example.test');
    await w.t.addOrgMember(w.owner.id, member.id, 'member');
    expect(
      (
        await K.as(member.cookie)('POST', `/api/sessions/${st.threadId}/archive`, {
          archived: true,
          endFirst: true,
        })
      ).status,
    ).toBeGreaterThanOrEqual(403);
    // with endFirst: it goes to the minutes (as on End) and is archived once they are written
    const res = await K.owner('POST', `/api/sessions/${st.threadId}/archive`, {
      archived: true,
      endFirst: true,
    });
    expect(res.session.config.archived).toBeFalsy();
    let s = await K.board(st.threadId);
    expect(s.config.stage).toBe('minutes');
    expect(s.config.endReason).toBe('owner');
    expect(s.config.archiveAfterEnd).toBe(true);
    // a second click while the minutes are written changes nothing
    await K.owner('POST', `/api/sessions/${st.threadId}/archive`, { archived: true, endFirst: true });
    await K.finish(first);
    const min = await K.nextStart(st.threadId, K.role('minutes'));
    await K.call(min.chatId, 'board.minutes', {
      content: '## Positions\n\n- all\n## Agreements\n\n- none\n## Open questions\n\n- x',
    });
    await K.finish(min);
    await until(async () => (await K.board(st.threadId)).config.archived === true);
    s = await K.board(st.threadId);
    expect(s.config).toMatchObject({ stage: 'ended', archived: true });
    expect(s.config.archiveAfterEnd).toBeFalsy();
    expect(s.config.minutesDocId).toBeTruthy();
    // it survives a replay
    const before = (await q('SELECT session_config FROM threads WHERE id=$1', [st.threadId]))[0]
      .session_config;
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store, w.t.clock.now());
    expect(
      (await q('SELECT session_config FROM threads WHERE id=$1', [st.threadId]))[0].session_config,
    ).toEqual(before);
    // an unstarted or finished boardroom archives plainly (no endFirst needed): this one is over
    await K.owner('POST', `/api/sessions/${st.threadId}/archive`, { archived: false });
    expect(
      (await K.owner('POST', `/api/sessions/${st.threadId}/archive`, { archived: true })).session.config
        .archived,
    ).toBe(true);
  });
});

describe('Discovery time limit', () => {
  it('warns, then holds every new question at time-up until the creator extends; paused time does not count', async () => {
    const s = await K.createDiscovery({ timeBoxMinutes: 15 });
    const start = await K.nextStart(s.threadId, K.role('facilitator'));
    const a = await K.call(start.chatId, 'session.ask', {
      question: 'Who is it for?',
      options: ['A', 'B'],
      allowFreeText: true,
    });
    await K.finish(start, 'Hello');
    expect((await K.discovery(s.threadId)).time).toMatchObject({ limitMinutes: 15, running: true });

    await K.owner('POST', `/api/discovery/${s.threadId}/pause`);
    const atPause = (await K.discovery(s.threadId)).time.elapsedMs;
    w.t.clock.advance(30 * 60_000);
    await discSvc().sweep();
    await K.owner('POST', `/api/discovery/${s.threadId}/resume`);
    expect(Math.abs((await K.discovery(s.threadId)).time.elapsedMs - atPause)).toBeLessThan(3000);

    w.t.clock.advance(11 * 60_000);
    await discSvc().sweep();
    let st = await K.discovery(s.threadId);
    expect(st.time.warned).toBe(true);
    expect(st.time.up).toBe(false);
    expect((await messages(s.threadId)).filter((m) => /minutes? left/.test(m.body))).toHaveLength(1);
    await discSvc().sweep();
    expect((await messages(s.threadId)).filter((m) => /minutes? left/.test(m.body))).toHaveLength(1);

    w.t.clock.advance(5 * 60_000);
    await discSvc().sweep();
    st = await K.discovery(s.threadId);
    expect(st.time.up).toBe(true);
    expect(st.waitingFor).toBe('time');

    // the answer is kept, but the facilitator is not asked for a new question
    const qid = a.result.questionId as string;
    await K.owner('POST', `/api/discovery/${s.threadId}/questions/${qid}/answer`, {
      kind: 'pick',
      optionId: 'o1',
    });
    await discSvc().sweep();
    expect(await K.quiet(s.threadId)).toHaveLength(0);

    // a member cannot decide
    const member = await w.t.userSession('r2-disc-limit@example.test');
    await w.t.addOrgMember(w.owner.id, member.id, 'member');
    await K.owner(
      'POST',
      `/api/sessions/${s.threadId}/participants`,
      { kind: 'user', refId: member.id, seat: 'guest' },
      201,
    );
    expect(
      (await K.as(member.cookie)('POST', `/api/discovery/${s.threadId}/time`, { action: 'wrap_up' })).status,
    ).toBe(403);

    st = (await K.owner('POST', `/api/discovery/${s.threadId}/time`, { action: 'extend', minutes: 10 }))
      .state;
    expect(st.time).toMatchObject({ up: false, warned: false });
    const next = await K.nextStart(s.threadId, K.role('facilitator'));
    expect(next.message).toContain('Answer to');
  });

  it('wraps up: the phase moves to capture and the facilitator is told to capture, with no more questions', async () => {
    const s = await K.createDiscovery({ timeBoxMinutes: 5 });
    await K.finish(await K.nextStart(s.threadId, K.role('facilitator')));
    w.t.clock.advance(6 * 60_000);
    await discSvc().sweep();
    expect((await K.discovery(s.threadId)).time.up).toBe(true);
    const st = (await K.owner('POST', `/api/discovery/${s.threadId}/time`, { action: 'wrap_up' })).state;
    expect(st.config.phase).toBe('capture');
    expect(st.config.timeUp).toBe(false);
    const fac = await K.nextStart(s.threadId, K.role('facilitator'));
    expect(fac.message).toContain('creator chose to wrap up');
    expect(fac.message).toContain('"phase":"capture"');
    // the limit is no longer enforced after the creator chose to wrap up
    await K.finish(fac);
    w.t.clock.advance(10 * 60_000);
    await discSvc().sweep();
    expect((await K.discovery(s.threadId)).time.up).toBe(false);
  });

  it('puts the same limit in the settings (set, change, remove)', async () => {
    const s = await K.createDiscovery();
    await K.finish(await K.nextStart(s.threadId, K.role('facilitator')));
    expect(s.time.limitMinutes).toBeNull();
    let st = (await K.owner('PATCH', `/api/discovery/${s.threadId}`, { timeBoxMinutes: 45 })).state;
    expect(st.time.limitMinutes).toBe(45);
    st = (await K.owner('PATCH', `/api/discovery/${s.threadId}`, { timeBoxMinutes: null })).state;
    expect(st.time.limitMinutes).toBeNull();
  });
});

describe('Boardroom cost limit at minutes time', () => {
  const budgetOut = async () => {
    const st = await K.createBoard({ budgetUsd: 0.5, roundCap: 3 });
    const starts: any[] = [];
    for (let i = 0; i < 4; i++) starts.push(await K.nextStart(st.threadId, K.role('speaker')));
    await K.finish(starts[0], 'a', { inputTokens: 2_000_000, outputTokens: 500_000 });
    starts.push(await K.nextStart(st.threadId, K.role('speaker')));
    for (const x of starts.slice(1)) await K.finish(x);
    await until(async () => (await K.board(st.threadId)).config.budgetStopped === true);
    await K.owner('POST', `/api/board/${st.threadId}/end`);
    return st;
  };

  it('is unlimited by default', async () => {
    const st = await K.createBoard();
    expect(st.cost.budgetUsd).toBeNull();
    expect(st.cost.exceeded).toBe(false);
  });

  it('asks the creator instead of silently writing the minutes: without the summary, after a click', async () => {
    const st = await budgetOut();
    await until(async () => (await K.board(st.threadId)).config.minutesAsk === 'budget');
    const s = await K.board(st.threadId);
    expect(s.config.stage).toBe('minutes');
    expect(s.waitingFor).toBe('budget');
    expect(s.config.minutesDocId).toBeNull();
    // the sweep does not write them either, nor repeat the question
    await boardSvc().sweep();
    expect(
      (await messages(st.threadId)).filter((m) => /cannot write the minutes' summary/.test(m.body)),
    ).toHaveLength(1);
    expect((await K.board(st.threadId)).config.minutesDocId).toBeNull();
    // a member cannot choose
    const member = await w.t.userSession('r2-budget-member@example.test');
    await w.t.addOrgMember(w.owner.id, member.id, 'member');
    await K.owner(
      'POST',
      `/api/sessions/${st.threadId}/participants`,
      { kind: 'user', refId: member.id, seat: 'guest' },
      201,
    );
    expect(
      (
        await K.as(member.cookie)('POST', `/api/board/${st.threadId}/minutes-choice`, {
          choice: 'without_summary',
        })
      ).status,
    ).toBe(403);
    const done = (
      await K.owner('POST', `/api/board/${st.threadId}/minutes-choice`, { choice: 'without_summary' })
    ).state;
    expect(done.config.stage === 'ended' || done.config.minutesDocId).toBeTruthy();
    await until(async () => (await K.board(st.threadId)).config.stage === 'ended');
    const fin = await K.board(st.threadId);
    expect(fin.config.minutesAsk).toBeNull();
    const doc = (await K.owner('GET', `/api/documents/${fin.config.minutesDocId}`)).document;
    expect(doc.content).toContain('The synthesis could not be written');
    // no second choice is pending
    expect(
      (await K.raw('POST', `/api/board/${st.threadId}/minutes-choice`, { choice: 'without_summary' })).status,
    ).toBe(409);
  });

  it('raising the limit retries the Chair summary', async () => {
    const st = await budgetOut();
    await until(async () => (await K.board(st.threadId)).config.minutesAsk === 'budget');
    const s = (await K.owner('PATCH', `/api/board/${st.threadId}`, { budgetUsd: 1000 })).state;
    expect(s.config.minutesAsk).toBeNull();
    const min = await K.nextStart(st.threadId, K.role('minutes'));
    await K.call(min.chatId, 'board.minutes', {
      content: '## Positions\n\n- all\n## Agreements\n\n- none\n## Open questions\n\n- x',
    });
    await K.finish(min);
    await until(async () => (await K.board(st.threadId)).config.stage === 'ended');
  });
});
