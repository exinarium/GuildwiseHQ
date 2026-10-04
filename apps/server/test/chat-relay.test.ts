import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { Browser } from './helpers/browser.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { addMember } from './helpers/members.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

/** Closes the fake runner and waits until the server has noticed. */
const hangUp = async (r: FakeRunner) => {
  r.close();
  await until(async () => !w.t.app.ctx.services.runners.isOnline(w.workstationId), 3000, 'runner offline');
};

const newChat = async (agentId: string, extra: Record<string, unknown> = {}, cookie = w.owner.cookie) =>
  (await ok<any>(w.t.req('POST', '/api/chats', { cookie, body: { agentId, ...extra } }), 201)).chat;
const messages = async (threadId: string, cookie = w.owner.cookie) =>
  (await ok<any>(w.t.req('GET', `/api/threads/${threadId}/messages`, { cookie }))).messages as any[];
const reply = (r: FakeRunner, start: any, text: string, extra: Record<string, unknown> = {}, id?: string) =>
  r.send(
    'chat.done',
    {
      chatId: start.chatId,
      threadId: start.threadId,
      messageText: text,
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
      ...extra,
    },
    id,
  );

describe('chat with an agent', () => {
  it('creates a chat only for agents the user may direct', async () => {
    await freshState();
    const agent = await w.hire('Una', 'builder', 'junior');
    const chat = await newChat(agent.id);
    expect(chat).toMatchObject({
      agentName: 'Una',
      agentRole: 'builder',
      cardId: null,
      workstationOnline: false,
    });
    expect(
      (await ok<any>(w.t.req('GET', '/api/chats', { cookie: w.owner.cookie }))).chats.map(
        (c: any) => c.threadId,
      ),
    ).toEqual([chat.threadId]);
    const stranger = await w.t.userSession(uniqueEmail('stranger'));
    expect(
      (await w.t.req('POST', '/api/chats', { cookie: stranger.cookie, body: { agentId: agent.id } })).status,
    ).toBe(404);
    expect((await w.t.req('GET', `/api/chats/${chat.threadId}`, { cookie: stranger.cookie })).status).toBe(
      404,
    );
    expect(
      (await w.t.req('GET', `/api/threads/${chat.threadId}/messages`, { cookie: stranger.cookie })).status,
    ).toBe(404);
    expect((await w.t.req('GET', '/api/chats')).status).toBe(401);
    // Retired agents cannot be chatted with.
    await ok(w.t.req('POST', `/api/agents/${agent.id}/fire`, { cookie: w.owner.cookie }));
    expect(
      (await w.t.req('POST', '/api/chats', { cookie: w.owner.cookie, body: { agentId: agent.id } })).status,
    ).toBe(404);
  });

  it('streams a reply through the runner, saves the conversation to the thread, and resumes the session', async () => {
    await freshState();
    const r = await w.connectRunner();
    const agent = await w.hire('Vic', 'builder', 'senior');
    const chat = await newChat(agent.id, { projectId: w.projectId });
    expect(chat.workstationOnline).toBe(true);
    const b = await Browser.open(w.baseUrl, w.owner.cookie);
    await b.hello();

    b.send({ type: 'chat.send', threadId: chat.threadId, body: 'Hello Vic', clientMsgId: 'm1' });
    const start = await r.waitFor('chat.start');
    expect(start).toMatchObject({
      threadId: chat.threadId,
      message: 'Hello Vic',
      agent: { name: 'Vic', roleKey: 'builder' },
      context: { projectId: w.projectId, projectKey: 'TOY' },
    });
    expect(start.resumeSessionId).toBeUndefined();

    r.send('chat.delta', { chatId: start.chatId, threadId: start.threadId, text: 'Hi ' });
    r.send('chat.delta', { chatId: start.chatId, threadId: start.threadId, text: 'there' });
    await b.until(() => b.of('chat.delta').length === 2);
    expect(
      b
        .of('chat.delta')
        .map((m) => m.text)
        .join(''),
    ).toBe('Hi there');
    reply(r, start, 'Hi there', { runtimeSessionId: 'sess-1' });
    await b.until(() => b.of('chat.done').length === 1);
    expect(b.of('chat.done')[0]).toMatchObject({ threadId: chat.threadId });

    const thread = await messages(chat.threadId);
    expect(thread.map((m) => [m.authorKind, m.kind, m.body])).toEqual([
      ['user', 'chat', 'Hello Vic'],
      ['agent', 'chat', 'Hi there'],
    ]);
    expect(thread[1]).toMatchObject({ authorName: 'Vic', data: { runtimeSessionId: 'sess-1' } });
    expect(b.of('chat.done')[0].messageId).toBe(thread[1].id);
    // The chat is a shift of kind chat: tokens count toward the agent, no card claimed.
    const shift = (await q('SELECT * FROM shifts WHERE id=$1', [start.chatId]))[0]!;
    expect(shift).toMatchObject({
      kind: 'chat',
      status: 'ended',
      outcome: 'reported',
      agent_id: agent.id,
      card_id: null,
    });
    expect(Number(shift.tokens_input)).toBe(100);

    // Next message resumes the runtime session.
    b.send({ type: 'chat.send', threadId: chat.threadId, body: 'And again', clientMsgId: 'm2' });
    const second = await r.waitFor('chat.start', (f) => f.message === 'And again');
    expect(second.resumeSessionId).toBe('sess-1');
    expect(second.chatId).not.toBe(start.chatId);
    reply(r, second, 'Again!', { runtimeSessionId: 'sess-1' });
    await b.until(() => b.of('chat.done').length === 2);
    expect(await messages(chat.threadId)).toHaveLength(4);
    expect(
      (
        await ok<any>(
          w.t.req('GET', `/api/threads/${chat.threadId}/messages?limit=1`, { cookie: w.owner.cookie }),
        )
      ).hasMore,
    ).toBe(true);
    b.close();
    await hangUp(r);
  });

  it('says so when the workstation is offline and queues nothing', async () => {
    await freshState();
    const agent = await w.hire('Wes', 'builder', 'junior');
    const chat = await newChat(agent.id);
    const b = await Browser.open(w.baseUrl, w.owner.cookie);
    await b.hello();
    b.send({ type: 'chat.send', threadId: chat.threadId, body: 'Anyone there?', clientMsgId: 'm1' });
    await b.until(() => b.of('chat.error').length === 1);
    expect(b.of('chat.error')[0]).toMatchObject({ threadId: chat.threadId, reason: 'workstation_offline' });
    expect(await messages(chat.threadId)).toEqual([]);
    expect(await q(`SELECT 1 FROM shifts WHERE kind='chat'`)).toHaveLength(0);
    expect(await q(`SELECT 1 FROM runner_commands`)).toHaveLength(0);
    // Nothing is delivered when the runner connects later.
    const r = await w.connectRunner();
    await r.barrier();
    expect(r.of('chat.start')).toHaveLength(0);
    b.close();
    await hangUp(r);
  });

  it('reports runner errors and dropped runner connections to the browser and ends the chat shift', async () => {
    await freshState();
    const r = await w.connectRunner();
    const agent = await w.hire('Xan', 'builder', 'junior');
    const chat = await newChat(agent.id);
    const b = await Browser.open(w.baseUrl, w.owner.cookie);
    await b.hello();

    b.send({ type: 'chat.send', threadId: chat.threadId, body: 'one', clientMsgId: 'm1' });
    const s1 = await r.waitFor('chat.start');
    // A second message while one is running is refused.
    b.send({ type: 'chat.send', threadId: chat.threadId, body: 'two', clientMsgId: 'm2' });
    await b.until(() => b.of('chat.error').some((m) => m.reason === 'busy'));
    r.send('chat.error', { chatId: s1.chatId, threadId: s1.threadId, error: 'claude exited with code 1' });
    await b.until(() => b.of('chat.error').some((m) => m.reason === 'claude exited with code 1'));
    expect((await q('SELECT outcome FROM shifts WHERE id=$1', [s1.chatId]))[0]!.outcome).toBe('crashed');

    b.send({ type: 'chat.send', threadId: chat.threadId, body: 'three', clientMsgId: 'm3' });
    const s2 = await r.waitFor('chat.start', (f) => f.message === 'three');
    await hangUp(r);
    await b.until(() => b.of('chat.error').filter((m) => m.reason === 'workstation_offline').length === 1);
    await until(
      async () => (await q('SELECT outcome FROM shifts WHERE id=$1', [s2.chatId]))[0]?.outcome === 'lost',
      3000,
      'lost',
    );
    // Only the user's messages were saved; no agent reply.
    expect((await messages(chat.threadId)).map((m) => m.body)).toEqual(['one', 'three']);
    b.close();
  });

  it('passes cancel to the runner and ignores strangers and unknown threads', async () => {
    await freshState();
    const r = await w.connectRunner();
    const agent = await w.hire('Yul', 'builder', 'junior');
    const chat = await newChat(agent.id);
    const b = await Browser.open(w.baseUrl, w.owner.cookie);
    await b.hello();
    b.send({ type: 'chat.send', threadId: chat.threadId, body: 'long task', clientMsgId: 'm1' });
    const start = await r.waitFor('chat.start');

    const stranger = await w.t.userSession(uniqueEmail('stranger'));
    const sb = await Browser.open(w.baseUrl, stranger.cookie);
    await sb.hello();
    sb.send({ type: 'chat.send', threadId: chat.threadId, body: 'hijack', clientMsgId: 'x' });
    sb.send({ type: 'chat.cancel', threadId: chat.threadId });
    sb.send({ type: 'chat.send', threadId: randomUUID(), body: 'nowhere', clientMsgId: 'y' });
    await sb.until(() => sb.of('chat.error').length === 2);
    expect(sb.of('chat.error').map((m) => m.reason)).toEqual(['unknown_thread', 'unknown_thread']);
    await r.barrier();
    expect(r.of('chat.cancel')).toHaveLength(0);
    expect(b.of('chat.delta')).toHaveLength(0);

    b.send({ type: 'chat.cancel', threadId: chat.threadId });
    const cancel = await r.waitFor('chat.cancel');
    expect(cancel.chatId).toBe(start.chatId);
    r.send('chat.error', { chatId: start.chatId, threadId: start.threadId, error: 'cancelled' });
    await b.until(() => b.of('chat.error').some((m) => m.reason === 'cancelled'));
    expect((await q('SELECT outcome FROM shifts WHERE id=$1', [start.chatId]))[0]!.outcome).toBe('stopped');
    b.close();
    sb.close();
    await hangUp(r);
  });

  it('applies a redelivered chat.done once', async () => {
    await freshState();
    const r = await w.connectRunner();
    const agent = await w.hire('Zed', 'builder', 'junior');
    const chat = await newChat(agent.id);
    const b = await Browser.open(w.baseUrl, w.owner.cookie);
    await b.hello();
    b.send({ type: 'chat.send', threadId: chat.threadId, body: 'ping', clientMsgId: 'm1' });
    const start = await r.waitFor('chat.start');
    const id = randomUUID();
    reply(r, start, 'pong', {}, id);
    reply(r, start, 'pong', {}, id);
    await b.until(() => b.of('chat.done').length >= 1);
    await r.barrier(); // both redeliveries are handled by now
    expect(b.of('chat.done')).toHaveLength(1);
    expect((await messages(chat.threadId)).map((m) => m.body)).toEqual(['ping', 'pong']);
    b.close();
    await hangUp(r);
  });

  it('with a card in context the agent can comment on the card and search the ledger (chat-scoped token)', async () => {
    await freshState();
    const r = await w.connectRunner();
    const agent = await w.hire('Abe', 'builder', 'junior');
    const card = await w.card({ title: 'Chat context' });
    await ok(
      w.t.req('POST', '/api/ledger', {
        cookie: w.owner.cookie,
        body: { scope: 'standing_order', title: 'Never push', body: 'Agents never push to remote branches.' },
      }),
      201,
    );
    const chat = await newChat(agent.id, { cardId: card.id });
    expect(chat).toMatchObject({ cardRef: card.ref, projectId: w.projectId });
    const b = await Browser.open(w.baseUrl, w.owner.cookie);
    await b.hello();
    b.send({ type: 'chat.send', threadId: chat.threadId, body: 'what is up', clientMsgId: 'm1' });
    const start = await r.waitFor('chat.start');
    expect(start.context).toMatchObject({ cardId: card.id, cardRef: card.ref, projectKey: 'TOY' });

    r.send('rpc.request', {
      rpcId: 'r1',
      shiftId: start.chatId,
      method: 'ledger.search',
      params: { query: 'push' },
    });
    const found = await r.waitFor('rpc.response', (f) => f.rpcId === 'r1');
    expect(found.ok).toBe(true);
    expect((found.result as any).entries.map((e: any) => e.title)).toEqual(['Never push']);
    r.send('rpc.request', {
      rpcId: 'r2',
      shiftId: start.chatId,
      method: 'thread.post',
      params: { body: 'a note from chat' },
    });
    expect((await r.waitFor('rpc.response', (f) => f.rpcId === 'r2')).ok).toBe(true);
    const detail = await ok<any>(w.t.req('GET', `/api/cards/${card.id}`, { cookie: w.owner.cookie }));
    expect(detail.thread.some((m: any) => m.body === 'a note from chat' && m.authorName === 'Abe')).toBe(
      true,
    );
    b.close();
    await hangUp(r);
  });
});

describe('chats tied to a shared project', () => {
  it('are visible to the project members (project audience); chats without a project stay private', async () => {
    await freshState();
    const agent = await w.hire('Shared', 'builder', 'junior');
    const m = await addMember(w, 'chatmember');
    const outsider = await w.t.userSession(uniqueEmail('outsider'));
    const inProject = await newChat(agent.id, { projectId: w.projectId });
    const priv = await newChat(agent.id);

    const events = await q(
      `SELECT audience, project_id FROM events WHERE type='ChatThreadCreated' AND payload->>'threadId' = ANY($1)`,
      [[inProject.threadId, priv.threadId]],
    );
    expect(events.map((e: any) => e.audience).sort()).toEqual(['org', 'project']);

    const listFor = async (cookie: string) =>
      (await ok<any>(w.t.req('GET', '/api/chats', { cookie }))).chats.map((c: any) => c.threadId);
    expect(await listFor(m.cookie)).toEqual([inProject.threadId]);
    expect(await listFor(outsider.cookie)).toEqual([]);
    expect((await w.t.req('GET', `/api/chats/${inProject.threadId}`, { cookie: m.cookie })).status).toBe(200);
    expect((await w.t.req('GET', `/api/chats/${priv.threadId}`, { cookie: m.cookie })).status).toBe(404);
    expect(
      (await w.t.req('GET', `/api/threads/${inProject.threadId}/messages`, { cookie: m.cookie })).status,
    ).toBe(200);
    expect(
      (await w.t.req('GET', `/api/threads/${inProject.threadId}/messages`, { cookie: outsider.cookie }))
        .status,
    ).toBe(404);
  });
});

describe('chat rights are re-checked on every send (review M6)', () => {
  it('a removed manager cannot keep talking to a project agent through an old thread', async () => {
    await freshState();
    const r = await w.connectRunner();
    const agent = await w.hire('Quin', 'builder', 'junior', { projectId: w.projectId });
    const m = await addMember(w, 'chatty');
    const chat = await newChat(agent.id, { projectId: w.projectId }, m.cookie);
    await ok(w.t.req('DELETE', `/api/projects/${w.projectId}/members/${m.id}`, { cookie: w.owner.cookie }));
    const b = await Browser.open(w.baseUrl, m.cookie);
    await b.hello();
    const before = r.received.length;
    b.send({ type: 'chat.send', threadId: chat.threadId, body: 'still there?', clientMsgId: 'x1' });
    await until(async () => b.of('chat.error').length >= 1, 3000, 'chat.error');
    await r.barrier();
    expect(r.received.slice(before).filter((f) => f.type === 'chat.start')).toHaveLength(0);
    expect((await messages(chat.threadId)).map((x) => x.body)).not.toContain('still there?');
    b.close();
    await hangUp(r);
  });
});
