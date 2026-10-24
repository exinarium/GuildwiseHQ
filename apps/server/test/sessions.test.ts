import { SESSION_TURNS_CAPABILITY } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECTION_TABLES } from '../src/projections/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { requesterIsMember } from '../src/sessions/membership.ts';
import { uniqueEmail } from './helpers/app.ts';
import { Browser } from './helpers/browser.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { FakeRunner as Runner } from './helpers/fake-runner.ts';
import { createWorld, MOCK_RUNTIME, ok, pairWorkstation, until, type World } from './helpers/world.ts';

/** Discovery and boardroom sessions: participants, durable turns, the runner round trip and replay safety. */
let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown, expected = 200) =>
  ok<any>(
    w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) }),
    expected,
  );
const raw = (method: string, url: string, body?: unknown, cookie = w.owner.cookie) =>
  w.t.req(method, url, { cookie, ...(body !== undefined ? { body } : {}) });
const persona = (key: string, seat = 'Panel') => ({ kind: 'persona', refId: key, seat });
const newSession = async (over: Record<string, unknown> = {}) =>
  (
    await owner(
      'POST',
      '/api/sessions',
      {
        kind: 'boardroom',
        title: 'Pricing debate',
        participants: [persona('devils-advocate', 'Skeptic'), persona('cost-hawk')],
        ...over,
      },
      201,
    )
  ).session;
const connect = (caps: string[] = [SESSION_TURNS_CAPABILITY]) => w.connectRunner({ capabilities: caps });
const turns = async (threadId: string) =>
  (await owner('GET', `/api/sessions/${threadId}/turns`)).turns as any[];
const messages = async (threadId: string) =>
  (await owner('GET', `/api/threads/${threadId}/messages`)).messages as any[];
const reply = (r: FakeRunner, start: { chatId: string; threadId: string }, text: string) =>
  r.send('chat.done', {
    chatId: start.chatId,
    threadId: start.threadId,
    messageText: text,
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
const startOf = async (r: FakeRunner, chatId: string): Promise<any> =>
  r.waitFor('chat.start', (f) => f.chatId === chatId);
const turnRow = async (id: string): Promise<any> =>
  (await q('SELECT * FROM session_turns WHERE id=$1', [id]))[0];
const hangUp = async (r: FakeRunner) => {
  r.close();
  await until(async () => !w.t.app.ctx.services.runners.isOnline(w.workstationId), 3000, 'runner offline');
};
const speaker = (s: any, key: string) => s.participants.find((p: any) => p.refId === key);

describe('creating a session', () => {
  it('creates a thread with its participants, the owner and the facilitator included', async () => {
    const analyst = await w.hire(`Ana${Math.random().toString(36).slice(2, 6)}`, 'analyst', 'senior');
    const analystName = analyst.name;
    const s = await newSession({
      kind: 'discovery',
      title: 'Idea: invoicing',
      facilitatorAgentId: analyst.id,
      projectId: w.projectId,
      config: { phase: 'frame', stance: 'facilitator' },
    });
    expect(s).toMatchObject({
      kind: 'discovery',
      title: 'Idea: invoicing',
      facilitatorAgentId: analyst.id,
      projectId: w.projectId,
      workstationId: w.workstationId,
      workstationOnline: false,
      config: { phase: 'frame', stance: 'facilitator' },
    });
    expect(s.participants.map((p: any) => [p.kind, p.seat, p.displayName])).toEqual([
      ['user', 'Owner', expect.any(String)],
      ['persona', 'Skeptic', "Devil's Advocate"],
      ['persona', 'Panel', 'Cost Hawk'],
      ['agent', 'Facilitator', analystName],
    ]);
    expect(
      (await owner('GET', '/api/sessions?kind=discovery')).sessions.map((x: any) => x.threadId),
    ).toContain(s.threadId);
    expect(
      (await owner('GET', '/api/sessions?kind=boardroom')).sessions.map((x: any) => x.threadId),
    ).not.toContain(s.threadId);
    expect((await owner('GET', `/api/sessions/${s.threadId}`)).session.threadId).toBe(s.threadId);
    // a session is not a chat: the chat list never shows it
    expect((await owner('GET', '/api/chats')).chats.map((c: any) => c.threadId)).not.toContain(s.threadId);
    expect(await messages(s.threadId)).toEqual([]);
  });

  it('refuses unknown personas, a persona without a brief, strangers and non-managers', async () => {
    expect(
      (
        await raw('POST', '/api/sessions', {
          kind: 'boardroom',
          title: 'x',
          participants: [persona('nobody-here')],
        })
      ).status,
    ).toBe(400);
    const adhoc = await raw('POST', '/api/sessions', {
      kind: 'boardroom',
      title: 'x',
      participants: [persona('ad-hoc-pirate')],
    });
    expect(adhoc.status).toBe(400);
    expect(JSON.stringify(adhoc.body)).toContain('ad_hoc_persona_needs_brief');
    const ok1 = await newSession({
      participants: [
        {
          kind: 'persona',
          refId: 'ad-hoc-pirate',
          seat: 'Wildcard',
          stance: 'A pirate who hates subscriptions',
          displayName: 'Pirate',
        },
      ],
    });
    expect(ok1.participants.find((p: any) => p.refId === 'ad-hoc-pirate')).toMatchObject({
      displayName: 'Pirate',
      stance: 'A pirate who hates subscriptions',
    });
    const stranger = await w.t.userSession(uniqueEmail('stranger'));
    expect((await raw('GET', `/api/sessions/${ok1.threadId}`, undefined, stranger.cookie)).status).toBe(404);
    expect(
      (await raw('GET', `/api/threads/${ok1.threadId}/messages`, undefined, stranger.cookie)).status,
    ).toBe(404);
    expect((await raw('POST', '/api/sessions', { kind: 'discovery', title: 'x' })).status).toBe(201);
    expect((await w.t.req('POST', '/api/sessions', { body: { kind: 'discovery', title: 'x' } })).status).toBe(
      401,
    );
  });

  it('updates config by merging, adds and removes participants, and keeps the creator', async () => {
    const s = await newSession();
    const p = await owner('PATCH', `/api/sessions/${s.threadId}`, {
      config: { phase: 'diverge', note: 'x' },
      title: 'Renamed',
    });
    expect(p.session).toMatchObject({ title: 'Renamed', config: { phase: 'diverge', note: 'x' } });
    const p2 = await owner('PATCH', `/api/sessions/${s.threadId}`, { config: { note: null, round: 2 } });
    expect(p2.session.config).toEqual({ phase: 'diverge', round: 2 });
    const added = await owner(
      'POST',
      `/api/sessions/${s.threadId}/participants`,
      persona('security', 'Guard'),
      201,
    );
    expect(added.participant).toMatchObject({ displayName: 'Security', seat: 'Guard' });
    expect((await raw('POST', `/api/sessions/${s.threadId}/participants`, persona('security'))).status).toBe(
      409,
    );
    const patched = await owner('PATCH', `/api/sessions/${s.threadId}/participants/${added.participant.id}`, {
      seat: 'Gatekeeper',
      stance: 'strict',
    });
    expect(patched.participant).toMatchObject({ seat: 'Gatekeeper', stance: 'strict' });
    await w.t.req('DELETE', `/api/sessions/${s.threadId}/participants/${added.participant.id}`, {
      cookie: w.owner.cookie,
    });
    const cur = (await owner('GET', `/api/sessions/${s.threadId}`)).session;
    expect(cur.participants.map((x: any) => x.refId)).not.toContain('security');
    const me = cur.participants.find((x: any) => x.kind === 'user');
    expect((await raw('DELETE', `/api/sessions/${s.threadId}/participants/${me.id}`)).status).toBe(409);
  });

  it('stores a human message without queueing a turn', async () => {
    const s = await newSession();
    const m = await owner(
      'POST',
      `/api/sessions/${s.threadId}/messages`,
      { body: 'Should we charge per seat?' },
      201,
    );
    expect(m.message).toMatchObject({ authorKind: 'user', kind: 'chat', body: 'Should we charge per seat?' });
    expect(await turns(s.threadId)).toEqual([]);
    expect((await messages(s.threadId)).map((x) => x.body)).toEqual(['Should we charge per seat?']);
  });
});

describe('durable turns', () => {
  it('waits while the workstation is offline, is sent when it connects, and stores the reply as the persona', async () => {
    const s = await newSession();
    const q1 = await owner(
      'POST',
      `/api/sessions/${s.threadId}/messages`,
      { body: 'Should we charge per seat?' },
      201,
    );
    const da = speaker(s, 'devils-advocate');
    const t = (
      await owner(
        'POST',
        `/api/sessions/${s.threadId}/turns`,
        {
          participantId: da.id,
          message: 'Attack the per-seat idea.',
          replyToMessageId: q1.message.id,
          round: 1,
        },
        202,
      )
    ).turn;
    expect(t).toMatchObject({ status: 'queued', speakerName: "Devil's Advocate", round: 1 });
    const b = await Browser.open(w.baseUrl, w.owner.cookie);
    await b.hello();
    const r = await connect();
    const start = await startOf(r, t.id);
    expect(start.session).toMatchObject({
      turnId: t.id,
      kind: 'boardroom',
      speaker: { kind: 'persona', name: "Devil's Advocate", personaKey: 'devils-advocate', seat: 'Skeptic' },
    });
    expect(start.session?.instructions).toContain('Devil');
    expect(start.session?.roster.map((x: { name: string }) => x.name)).toEqual(
      expect.arrayContaining(["Devil's Advocate", 'Cost Hawk']),
    );
    expect(start.agent).toMatchObject({ roleKey: 'persona', name: "Devil's Advocate" });
    expect(start.agent.permissions).toMatchObject({
      allowedTools: ['read'],
      mayCommit: false,
      writableGlobs: [],
    });
    expect(start.message).toContain('Should we charge per seat?');
    expect(start.message).toContain('## Your turn');
    expect(start.message).toContain('Attack the per-seat idea.');
    await until(async () => (await turnRow(t.id)).status === 'running');
    expect((await turnRow(t.id)).attempts).toBe(1);

    r.send('chat.delta', { chatId: t.id, threadId: s.threadId, text: 'Per seat ' });
    await b.until(() => b.of('chat.delta').some((m) => m.turnId === t.id));
    reply(r, start, 'Per-seat pricing punishes growth.');
    await until(async () => (await turnRow(t.id)).status === 'done');
    const msgs = await messages(s.threadId);
    const mine = msgs.find((m) => m.authorPersonaKey === 'devils-advocate');
    expect(mine).toMatchObject({
      authorKind: 'agent',
      authorAgentId: null,
      authorName: "Devil's Advocate",
      body: 'Per-seat pricing punishes growth.',
      data: {
        turnId: t.id,
        participantId: da.id,
        seat: 'Skeptic',
        round: 1,
        replyToMessageId: q1.message.id,
      },
    });
    expect((await turnRow(t.id)).message_id).toBe(mine.id);
    await b.until(() =>
      b
        .of('chat.done')
        .some((m) => m.turnId === t.id && m.participantId === da.id && m.message?.id === mine.id),
    );
    expect(b.of('session.turn').map((m) => m.status)).toEqual(expect.arrayContaining(['running', 'done']));
    b.close();
    r.close();
  });

  it('shows a persona only the messages the turn selects (independent first round)', async () => {
    const r = await connect();
    const s = await newSession();
    const question = (
      await owner('POST', `/api/sessions/${s.threadId}/messages`, { body: 'QUESTION-ONE' }, 201)
    ).message;
    await owner('POST', `/api/sessions/${s.threadId}/messages`, { body: 'SECRET-OTHER-ANSWER' }, 201);
    const t = (
      await owner(
        'POST',
        `/api/sessions/${s.threadId}/turns`,
        {
          participantId: speaker(s, 'cost-hawk').id,
          message: 'Answer alone.',
          context: { mode: 'selected', messageIds: [question.id] },
        },
        202,
      )
    ).turn;
    const start = await startOf(r, t.id);
    expect(start.message).toContain('QUESTION-ONE');
    expect(start.message).not.toContain('SECRET-OTHER-ANSWER');
    const none = (
      await owner(
        'POST',
        `/api/sessions/${s.threadId}/turns`,
        { participantId: speaker(s, 'cost-hawk').id, message: 'Blind.', context: { mode: 'none' } },
        202,
      )
    ).turn;
    const startNone = await startOf(r, none.id);
    expect(startNone.message).toBe('## Your turn\n\nBlind.');
    r.close();
  });

  it('lets an agent speak with its own spec and the registry persona of its role', async () => {
    const r = await connect();
    const analyst = await w.hire(`Ana${Math.random().toString(36).slice(2, 6)}`, 'analyst', 'senior');
    const s = await newSession({ kind: 'discovery', facilitatorAgentId: analyst.id, participants: [] });
    const t = (
      await owner(
        'POST',
        `/api/sessions/${s.threadId}/turns`,
        { participantId: speaker(s, analyst.id).id, message: 'Ask the first question.' },
        202,
      )
    ).turn;
    const start = await startOf(r, t.id);
    expect(start.agent).toMatchObject({ agentId: analyst.id, roleKey: 'analyst' });
    expect(start.session?.speaker).toMatchObject({ kind: 'agent', name: analyst.name });
    expect(start.session?.instructions).toContain('discovery session');
    reply(r, start, 'What problem are you solving?');
    await until(async () => (await turnRow(t.id)).status === 'done');
    const m = (await messages(s.threadId)).find((x) => x.authorAgentId === analyst.id);
    expect(m).toMatchObject({ authorName: analyst.name, body: 'What problem are you solving?' });
    expect(m.authorPersonaKey).toBeUndefined();
    r.close();
  });

  it('puts a turn the runner lost back in the queue and sends it again', async () => {
    let r = await connect();
    const s = await newSession();
    const t = (
      await owner(
        'POST',
        `/api/sessions/${s.threadId}/turns`,
        { participantId: speaker(s, 'cost-hawk').id, message: 'Cost?' },
        202,
      )
    ).turn;
    await startOf(r, t.id);
    await until(async () => (await turnRow(t.id)).status === 'running');
    await hangUp(r);
    // the runner comes back and no longer holds the turn (it restarted)
    r = await connect();
    const again = await startOf(r, t.id);
    await until(async () => (await turnRow(t.id)).attempts === 2);
    expect((await turnRow(t.id)).status).toBe('running');
    reply(r, again, 'Cheap enough.');
    await until(async () => (await turnRow(t.id)).status === 'done');
    r.close();
  });

  it('keeps a running turn the runner still holds', async () => {
    const r = await connect();
    const s = await newSession();
    const t = (
      await owner(
        'POST',
        `/api/sessions/${s.threadId}/turns`,
        { participantId: speaker(s, 'cost-hawk').id, message: 'Cost?' },
        202,
      )
    ).turn;
    const start = await startOf(r, t.id);
    await until(async () => (await turnRow(t.id)).status === 'running');
    await hangUp(r);
    const { FakeRunner } = await import('./helpers/fake-runner.ts');
    const held = await FakeRunner.connect(w.baseUrl, w.runnerToken);
    held.send('hello', {
      runnerVersion: '0.0.0-test',
      protocol: 1,
      platform: 'linux',
      hostname: 'fake-host',
      runtimes: [{ id: 'mock', version: '1', available: true, capabilities: [] }],
      repos: [],
      vaults: [],
      activeShifts: [],
      activeChats: [t.id],
      outboxPending: 0,
      capabilities: [SESSION_TURNS_CAPABILITY],
    });
    await held.waitFor('welcome');
    await held.barrier();
    expect((await turnRow(t.id)).status).toBe('running');
    expect((await turnRow(t.id)).attempts).toBe(1);
    expect(held.of('chat.start')).toHaveLength(0);
    // its reply is accepted after a server-side forgetting (the turn is in the database, not only in memory)
    reply(held, start, 'Still here.');
    await until(async () => (await turnRow(t.id)).status === 'done');
    held.close();
  });

  it('retries a dropped connection and ends the turn on a real error or a cancel', async () => {
    const r = await connect();
    const s = await newSession();
    const da = speaker(s, 'devils-advocate').id;
    const queue = async (message: string) =>
      (await owner('POST', `/api/sessions/${s.threadId}/turns`, { participantId: da, message }, 202)).turn;
    const t1 = await queue('one');
    const st1 = await startOf(r, t1.id);
    r.send('chat.error', {
      chatId: t1.id,
      threadId: s.threadId,
      error: 'workstation offline: the connection to the server dropped',
    });
    await until(async () => (await turnRow(t1.id)).attempts === 2);
    expect((await turnRow(t1.id)).status).toBe('running');
    expect(r.of('chat.start').filter((f) => f.chatId === t1.id)).toHaveLength(2);
    r.send('chat.error', {
      chatId: t1.id,
      threadId: s.threadId,
      error: 'the claude process exited with code 1',
    });
    await until(async () => (await turnRow(t1.id)).status === 'failed');
    expect((await turnRow(t1.id)).error).toContain('exited with code 1');
    expect(st1.chatId).toBe(t1.id);
    // a cancel of a running turn goes to the runner
    const t2 = await queue('two');
    await startOf(r, t2.id);
    await owner('POST', `/api/sessions/${s.threadId}/turns/${t2.id}/cancel`);
    await r.waitFor('chat.cancel', (f) => f.chatId === t2.id);
    r.send('chat.error', { chatId: t2.id, threadId: s.threadId, error: 'cancelled' });
    await until(async () => (await turnRow(t2.id)).status === 'failed');
    // a queued turn is cancelled at once
    await hangUp(r);
    const t3 = await queue('three');
    expect((await owner('POST', `/api/sessions/${s.threadId}/turns/${t3.id}/cancel`)).turn).toMatchObject({
      status: 'failed',
      error: 'cancelled',
    });
    expect((await raw('POST', `/api/sessions/${s.threadId}/turns/${t3.id}/cancel`)).status).toBe(409);
  });

  it('fails a turn on a runner that cannot run session turns, and refuses a person as speaker', async () => {
    const r = await connect([]);
    const s = await newSession();
    const t = (
      await owner(
        'POST',
        `/api/sessions/${s.threadId}/turns`,
        { participantId: speaker(s, 'cost-hawk').id, message: 'hi' },
        202,
      )
    ).turn;
    await until(async () => (await turnRow(t.id)).status === 'failed');
    expect((await turnRow(t.id)).error).toContain('runner_too_old');
    expect(r.of('chat.start')).toHaveLength(0);
    const me = (await owner('GET', `/api/sessions/${s.threadId}`)).session.participants.find(
      (p: any) => p.kind === 'user',
    );
    expect(
      (await raw('POST', `/api/sessions/${s.threadId}/turns`, { participantId: me.id, message: 'x' })).status,
    ).toBe(400);
    expect(
      (
        await raw('POST', `/api/sessions/${s.threadId}/turns`, {
          participantId: crypto.randomUUID(),
          message: 'x',
        })
      ).status,
    ).toBe(404);
    r.close();
  });

  it('expires a turn that waited a day for a workstation', async () => {
    const s = await newSession();
    const t = (
      await owner(
        'POST',
        `/api/sessions/${s.threadId}/turns`,
        { participantId: speaker(s, 'cost-hawk').id, message: 'hi' },
        202,
      )
    ).turn;
    w.t.clock.advance(25 * 3_600_000);
    await w.t.app.ctx.services.sessions.sweep();
    expect(await turnRow(t.id)).toMatchObject({ status: 'failed' });
    expect((await turnRow(t.id)).error).toContain('expired');
  });
});

describe('dispatch ids: a late reply is matched to its attempt (R3c)', () => {
  const queueTurn = async (r: FakeRunner, message = 'Cost?') => {
    const s = await newSession();
    const t = (
      await owner(
        'POST',
        `/api/sessions/${s.threadId}/turns`,
        { participantId: speaker(s, 'cost-hawk').id, message },
        202,
      )
    ).turn;
    const start = await startOf(r, t.id);
    await until(async () => (await turnRow(t.id)).status === 'running');
    return { s, t, start };
  };
  const replyWith = (r: FakeRunner, start: any, text: string, attemptId: string | undefined) =>
    r.send('chat.done', {
      chatId: start.chatId,
      threadId: start.threadId,
      messageText: text,
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
      ...(attemptId ? { attemptId } : {}),
    });
  /** What the server believes after a lost connection: the turn goes back to the queue (and is not sent yet). */
  const requeue = async (t: any, threadId: string) => {
    await w.t.app.ctx.store.append([
      {
        streamId: `session-turn-${t.id}`,
        event: {
          type: 'SessionTurnRequeued',
          payload: {
            turnId: t.id,
            threadId,
            reason: 'no answer from the workstation',
            workstationId: w.workstationId,
          },
        },
        actor: { kind: 'system', id: null },
        scope: { orgId: w.owner.id, projectId: null, audience: 'org' },
      } as never,
    ]);
  };

  it('puts a dispatch id in chat.start, in the turn and in the event, and a new one for each dispatch', async () => {
    let r = await connect();
    const { t, start } = await queueTurn(r);
    expect(typeof start.attemptId).toBe('string');
    expect((await turnRow(t.id)).attempt_id).toBe(start.attemptId);
    await hangUp(r);
    r = await connect();
    const again = await startOf(r, t.id);
    await until(async () => (await turnRow(t.id)).attempts === 2);
    expect(again.attemptId).toBeTruthy();
    expect(again.attemptId).not.toBe(start.attemptId);
    expect((await turnRow(t.id)).attempt_id).toBe(again.attemptId);
    replyWith(r, again, 'Cheap enough.', again.attemptId);
    await until(async () => (await turnRow(t.id)).status === 'done');
    r.close();
  });

  it('ignores a late reply and a late error of an earlier dispatch, and takes the current dispatch’s reply', async () => {
    let r = await connect();
    const { s, t, start } = await queueTurn(r);
    await hangUp(r);
    r = await connect();
    const again = await startOf(r, t.id);
    await until(async () => (await turnRow(t.id)).attempts === 2);
    // the first dispatch answers after the second began: the answer of an earlier attempt is not the one waited for
    replyWith(r, start, 'LATE FROM THE FIRST', start.attemptId);
    r.send('chat.error', { chatId: t.id, threadId: s.threadId, error: 'boom', attemptId: start.attemptId });
    r.send('chat.delta', {
      chatId: t.id,
      threadId: s.threadId,
      text: 'old words',
      attemptId: start.attemptId,
    });
    await r.barrier();
    expect(await turnRow(t.id)).toMatchObject({ status: 'running', attempts: 2 });
    expect((await messages(s.threadId)).some((m) => m.body === 'LATE FROM THE FIRST')).toBe(false);
    replyWith(r, again, 'The current answer', again.attemptId);
    await until(async () => (await turnRow(t.id)).status === 'done');
    expect((await messages(s.threadId)).map((m) => m.body)).toContain('The current answer');
    r.close();
  });

  it('accepts the late reply of the current dispatch when the turn went back to the queue meanwhile, and does not send it again', async () => {
    const r = await connect();
    const { s, t, start } = await queueTurn(r);
    await requeue(t, s.threadId);
    expect((await turnRow(t.id)).status).toBe('queued');
    replyWith(r, start, 'Finished after all', start.attemptId);
    await until(async () => (await turnRow(t.id)).status === 'done');
    expect((await messages(s.threadId)).map((m) => m.body)).toContain('Finished after all');
    // it is done: nothing is sent again
    await w.t.app.ctx.services.sessions.sweep(w.workstationId);
    expect(r.of('chat.start').filter((f: any) => f.chatId === t.id)).toHaveLength(1);
    r.close();
  });

  it('keeps the earlier rule for a runner that echoes no dispatch id: a frame for a queued turn is dropped', async () => {
    const r = await connect();
    const { s, t, start } = await queueTurn(r);
    await requeue(t, s.threadId);
    replyWith(r, start, 'OLD RUNNER LATE', undefined);
    await r.barrier();
    expect((await turnRow(t.id)).status).toBe('queued');
    expect((await messages(s.threadId)).some((m) => m.body === 'OLD RUNNER LATE')).toBe(false);
    r.close();
  });

  it('refuses the verbs of a stale dispatch and answers those of the current one', async () => {
    const r = await connect();
    const { t, start } = await queueTurn(r);
    const call = async (attemptId: string | undefined) => {
      const rpcId = `rpc-${Math.random()}`;
      const from = r.received.length;
      r.send('rpc.request', {
        rpcId,
        shiftId: t.id,
        method: 'ledger.search',
        params: { query: 'pricing' },
        ...(attemptId ? { attemptId } : {}),
      });
      return (await r.waitFor('rpc.response', (f) => f.rpcId === rpcId, 10_000, from)) as {
        ok: boolean;
        error?: string;
      };
    };
    const stale = await call('an-older-dispatch');
    expect(stale.ok).toBe(false);
    expect(stale.error).toMatch(/old attempt/);
    expect((await call(start.attemptId as string)).error ?? '').not.toMatch(/old attempt/);
    // an older runner sends none: allowed as before
    expect((await call(undefined)).error ?? '').not.toMatch(/old attempt/);
    replyWith(r, start, 'done', start.attemptId);
    r.close();
  });
});

describe('whose workstation a session may use, and who may end a turn', () => {
  let adm: { id: string; cookie: string; email: string };
  let admWs = '';
  let admToken = '';
  it('refuses a workstation of someone else when a session is created, changed or a turn is queued', async () => {
    adm = await w.t.userSession(uniqueEmail('wsadmin'));
    await w.t.addOrgMember(w.owner.id, adm.id, 'admin');
    const p = await pairWorkstation(w.t, adm, 'adm-box');
    admWs = p.workstationId;
    admToken = p.runnerToken;
    const own = await raw('POST', '/api/sessions', {
      kind: 'boardroom',
      title: 'Elsewhere',
      workstationId: admWs,
      participants: [persona('cost-hawk')],
    });
    expect(own.status).toBe(403);
    expect(JSON.stringify(own.body)).toContain('workstation_not_yours');
    const s = await newSession();
    expect((await raw('PATCH', `/api/sessions/${s.threadId}`, { workstationId: admWs })).status).toBe(403);
    // a turn may not name another person's workstation either
    const t = await raw('POST', `/api/sessions/${s.threadId}/turns`, {
      participantId: speaker(s, 'cost-hawk').id,
      message: 'hi',
      workstationId: admWs,
    });
    expect(t.status).toBe(403);
    // the admin may use their own for a session of their own
    const mine = await raw(
      'POST',
      '/api/sessions',
      { kind: 'boardroom', title: 'Mine', workstationId: admWs, participants: [persona('cost-hawk')] },
      adm.cookie,
    );
    expect(mine.status, JSON.stringify(mine.body)).toBe(201);
  });

  it('keeps a direct-model turn on the workstation of the person who queues it', async () => {
    const s = await newSession();
    await owner(
      'POST',
      `/api/sessions/${s.threadId}/participants`,
      { kind: 'user', refId: adm.id, seat: 'Guest' },
      201,
    );
    const res = await raw(
      'POST',
      `/api/sessions/${s.threadId}/turns`,
      {
        participantId: speaker(s, 'cost-hawk').id,
        message: 'spend the owner keys',
        model: { runtime: 'direct-model', model: 'openai:gpt-5' },
      },
      adm.cookie,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(JSON.stringify(res.body)).toContain('workstation_not_yours');
    expect((await q('SELECT 1 FROM session_turns WHERE thread_id=$1', [s.threadId])).length).toBe(0);
  });

  it('ignores chat.done and chat.error from a workstation the turn was not sent to', async () => {
    const r = await connect();
    const other = await Runner.connect(w.baseUrl, admToken);
    other.hello({ repos: [], runtimes: MOCK_RUNTIME, capabilities: [SESSION_TURNS_CAPABILITY] });
    await other.waitFor('welcome');
    const s = await newSession();
    const t = (
      await owner(
        'POST',
        `/api/sessions/${s.threadId}/turns`,
        { participantId: speaker(s, 'cost-hawk').id, message: 'who answers?' },
        202,
      )
    ).turn;
    const start = await startOf(r, t.id);
    reply(other, start, 'FORGED ANSWER');
    other.send('chat.error', { chatId: t.id, threadId: s.threadId, error: 'boom' });
    await other.barrier();
    expect((await turnRow(t.id)).status).toBe('running');
    expect((await messages(s.threadId)).some((m) => m.body === 'FORGED ANSWER')).toBe(false);
    reply(r, start, 'The real answer');
    await until(async () => (await turnRow(t.id)).status === 'done');
    expect((await messages(s.threadId)).map((m) => m.body)).toContain('The real answer');
    // a late frame for a turn that went back to the queue is not taken either
    const t2 = (
      await owner(
        'POST',
        `/api/sessions/${s.threadId}/turns`,
        { participantId: speaker(s, 'cost-hawk').id, message: 'again' },
        202,
      )
    ).turn;
    const start2 = await startOf(r, t2.id);
    r.send('chat.error', { chatId: t2.id, threadId: s.threadId, error: 'workstation offline' });
    // back in the queue and sent again: the second attempt is the one that counts
    await until(async () => (await turnRow(t2.id)).attempts === 2);
    reply(other, start2, 'LATE ANSWER');
    other.send('chat.error', { chatId: t2.id, threadId: s.threadId, error: 'late failure' });
    await other.barrier();
    expect(await turnRow(t2.id)).toMatchObject({ status: 'running', attempts: 2 });
    expect((await messages(s.threadId)).some((m) => m.body === 'LATE ANSWER')).toBe(false);
    other.close();
    r.close();
  });

  it('shows a session to nobody who left the organization, whatever the thread says', async () => {
    const s = await newSession();
    await owner(
      'POST',
      `/api/sessions/${s.threadId}/participants`,
      { kind: 'user', refId: adm.id, seat: 'Guest' },
      201,
    );
    const asAdm = (url: string) =>
      w.t.req('GET', url, { cookie: adm.cookie, headers: { 'x-aom-org': w.owner.id } });
    expect((await asAdm(`/api/sessions/${s.threadId}`)).status).toBe(200);
    expect((await asAdm(`/api/threads/${s.threadId}/messages`)).status).toBe(200);
    await w.t.app.ctx.store.append([
      {
        streamId: `org-${w.owner.id}`,
        event: {
          type: 'OrgMemberRemoved',
          payload: { orgId: w.owner.id, userId: adm.id, reason: 'removed' },
        },
        actor: { kind: 'system', id: null },
        scope: { orgId: w.owner.id, projectId: null, audience: 'org' },
      } as never,
    ]);
    expect((await asAdm(`/api/sessions/${s.threadId}`)).status).toBeGreaterThanOrEqual(400);
    expect((await asAdm(`/api/threads/${s.threadId}/messages`)).status).toBe(404);
    // the verbs of a turn that person queued stop with the membership, too; the owner's own turns carry on
    const ctx = w.t.app.ctx;
    const thread = { created_by: w.owner.id };
    expect(await requesterIsMember(ctx, { org_id: w.owner.id, requested_by: adm.id }, thread)).toBe(false);
    expect(
      await requesterIsMember(ctx, { org_id: w.owner.id, requested_by: null }, { created_by: adm.id }),
    ).toBe(false);
    expect(await requesterIsMember(ctx, { org_id: w.owner.id, requested_by: w.owner.id }, thread)).toBe(true);
  });
});

describe('replay', () => {
  it('rebuilds identical projection tables for sessions and turns', async () => {
    const snapshot = async () => {
      const out: Record<string, string[]> = {};
      for (const table of ['threads', 'thread_participants', 'session_turns', 'thread_messages']) {
        const rows = await q(`SELECT to_jsonb(t)::text AS j FROM "${table}" t`);
        out[table] = rows.map((r) => r.j as string).sort();
      }
      return out;
    };
    const before = await snapshot();
    expect(before.session_turns?.length).toBeGreaterThan(3);
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store, w.t.clock.now());
    expect(await snapshot()).toEqual(before);
    expect(PROJECTION_TABLES).toEqual(expect.arrayContaining(['thread_participants', 'session_turns']));
  });
});
