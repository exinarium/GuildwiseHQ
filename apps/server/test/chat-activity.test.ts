import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser } from './helpers/browser.ts';
import { closeAdminPool } from './helpers/db.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const newChat = async (agentId: string) =>
  (await ok<any>(w.t.req('POST', '/api/chats', { cookie: w.owner.cookie, body: { agentId } }), 201)).chat;
const messages = async (threadId: string) =>
  (await ok<any>(w.t.req('GET', `/api/threads/${threadId}/messages`, { cookie: w.owner.cookie })))
    .messages as any[];

describe('chat activity', () => {
  it('announces chat-activity in welcome, forwards activity, stores the segments and returns the message in chat.done', async () => {
    await freshState();
    const r = await w.connectRunner();
    const welcome = r.received.find((f) => f.type === 'welcome') as any;
    expect(welcome.features).toContain('chat-activity:1');
    const agent = await w.hire('Act', 'builder', 'senior');
    const chat = await newChat(agent.id);
    const b = await Browser.open(w.baseUrl, w.owner.cookie);
    await b.hello();
    b.send({ type: 'chat.send', threadId: chat.threadId, body: 'look', clientMsgId: 'a1' });
    const start = await r.waitFor('chat.start');

    const tool = { type: 'tool', id: 't1', name: 'Read', summary: 'a.ts', status: 'running' };
    r.send('chat.activity', { chatId: start.chatId, threadId: start.threadId, seq: 1, segment: tool });
    r.send('chat.activity', {
      chatId: start.chatId,
      threadId: start.threadId,
      seq: 1,
      segment: { ...tool, status: 'ok' },
      replace: true,
    });
    await b.until(() => b.of('chat.activity').length === 2);
    expect(b.of('chat.activity')[0]).toEqual({
      type: 'chat.activity',
      threadId: chat.threadId,
      seq: 1,
      segment: tool,
    });
    expect(b.of('chat.activity')[1]).toMatchObject({ replace: true, segment: { status: 'ok' } });

    const segments = [
      { type: 'text', text: 'Let me look.' },
      { ...tool, status: 'ok' },
      { type: 'tool', name: 'Bash', status: 'refused' },
      { type: 'text', text: 'Found it.' },
    ];
    r.send('chat.done', {
      chatId: start.chatId,
      threadId: start.threadId,
      messageText: 'Found it.',
      usage,
      segments,
    });
    await b.until(() => b.of('chat.done').length === 1);
    const stored = (await messages(chat.threadId)).at(-1);
    expect(stored.data.segments).toEqual(segments);
    expect(stored.body).toBe('Let me look.\n\nFound it.');
    expect(b.of('chat.done')[0].message).toEqual(stored);
  });

  it('keeps messageText as the body when an older runner sends no segments', async () => {
    await freshState();
    const r = await w.connectRunner();
    const agent = await w.hire('Old', 'builder', 'senior');
    const chat = await newChat(agent.id);
    const b = await Browser.open(w.baseUrl, w.owner.cookie);
    await b.hello();
    b.send({ type: 'chat.send', threadId: chat.threadId, body: 'hi', clientMsgId: 'b1' });
    const start = await r.waitFor('chat.start');
    r.send('chat.done', { chatId: start.chatId, threadId: start.threadId, messageText: 'plain', usage });
    await b.until(() => b.of('chat.done').length === 1);
    const stored = (await messages(chat.threadId)).at(-1);
    expect(stored.body).toBe('plain');
    expect(stored.data.segments).toBeUndefined();
    expect(b.of('chat.done')[0].message.id).toBe(stored.id);
  });

  it('ignores activity of a chat that is not in flight', async () => {
    await freshState();
    const r = await w.connectRunner();
    r.send('chat.activity', {
      chatId: 'nope',
      threadId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c1',
      seq: 0,
      segment: { type: 'thinking' },
    });
    // no crash and the runner stays connected
    expect(w.t.app.ctx.services.runners.isOnline(w.workstationId)).toBe(true);
  });
});

describe('POST /api/chats/archive-all', () => {
  it('archives every open chat of the caller, except the listed ones, in one call', async () => {
    await freshState();
    const agent = await w.hire('Bulk', 'builder', 'senior');
    const a = await newChat(agent.id);
    const keep = await newChat(agent.id);
    const c = await newChat(agent.id);
    const res = await ok<any>(
      w.t.req('POST', '/api/chats/archive-all', {
        cookie: w.owner.cookie,
        body: { exceptThreadIds: [keep.threadId] },
      }),
    );
    expect(res).toEqual({ archived: 2 });
    const list = (await ok<any>(w.t.req('GET', '/api/chats', { cookie: w.owner.cookie }))).chats;
    const flag = (id: string) => list.find((x: any) => x.threadId === id).archived;
    expect([flag(a.threadId), flag(keep.threadId), flag(c.threadId)]).toEqual([true, false, true]);
    // nothing left to archive: zero, not an error
    expect(
      await ok<any>(
        w.t.req('POST', '/api/chats/archive-all', {
          cookie: w.owner.cookie,
          body: { exceptThreadIds: [keep.threadId] },
        }),
      ),
    ).toEqual({ archived: 0 });
    expect((await w.t.req('POST', '/api/chats/archive-all', { body: {} })).status).toBe(401);
  });

  it('lists chats with the newest message as a plain-text preview', async () => {
    await freshState();
    const r = await w.connectRunner();
    const agent = await w.hire('Prev', 'builder', 'senior');
    const chat = await newChat(agent.id);
    const list = async () =>
      (await ok<any>(w.t.req('GET', '/api/chats', { cookie: w.owner.cookie }))).chats.find(
        (c: any) => c.threadId === chat.threadId,
      );
    expect((await list()).lastMessage).toBeNull();
    const b = await Browser.open(w.baseUrl, w.owner.cookie);
    await b.hello();
    b.send({ type: 'chat.send', threadId: chat.threadId, body: 'hello', clientMsgId: 'p1' });
    const start = await r.waitFor('chat.start');
    r.send('chat.done', {
      chatId: start.chatId,
      threadId: start.threadId,
      messageText: '**Toy app**: 3 cards\n\n- one',
      usage,
    });
    await b.until(() => b.of('chat.done').length === 1);
    const c = await list();
    expect(c.lastMessage).toMatchObject({ authorKind: 'agent', body: 'Toy app: 3 cards one' });
    expect(c.lastMessage.at).toBe(c.lastMessageAt);
  });
});
