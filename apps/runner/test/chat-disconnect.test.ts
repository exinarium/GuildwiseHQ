import { afterEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, waitUntil } from './helpers.ts';
import { ceoChatStart, FakeChatAdapter } from './owner-helpers.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

async function setup() {
  h = await startHarness({}, { backoff: { baseMs: 50, capMs: 100, resetAfterMs: 60_000 } });
  const adapter = new FakeChatAdapter();
  h.runner.chat.deps.adapters.set('mock', adapter);
  (h.runner as unknown as { opts: { config: { ceo: { fullPower: boolean } } } }).opts.config.ceo = {
    fullPower: true,
  };
  adapter.holdSessions();
  return adapter;
}

describe('a dropped connection', () => {
  it('does not cancel a CEO owner turn: its chat.done reaches the server after the reconnect', async () => {
    const adapter = await setup();
    const msg = ceoChatStart('long job', { ceoMode: 'owner' });
    h!.server.send('chat.start', msg);
    await waitUntil(() => adapter.ownerTurns.length === 1, 10_000, 'the turn runs');
    expect(h!.runner.chat.activeIds()).toContain(msg.chatId);
    const hellos = h!.server.helloCount;
    h!.server.drop();
    await waitUntil(() => h!.server.helloCount > hellos, 20_000, 'reconnect');
    expect(h!.runner.chat.activeIds()).toContain(msg.chatId); // still running
    adapter.release();
    const done = await h!.server.waitFor('chat.done', (d) => d.chatId === msg.chatId, 20_000);
    expect(done.messageText).toBe('owner reply');
    expect(h!.server.of('chat.error').filter((e) => e.chatId === msg.chatId)).toHaveLength(0);
  });

  it('a reply finished while offline waits in the outbox and arrives on reconnect', async () => {
    const adapter = await setup();
    const msg = ceoChatStart('job', { ceoMode: 'owner' });
    h!.server.send('chat.start', msg);
    await waitUntil(() => adapter.ownerTurns.length === 1, 10_000, 'the turn runs');
    const hellos = h!.server.helloCount;
    h!.server.drop();
    adapter.release();
    await waitUntil(() => h!.server.helloCount > hellos, 20_000, 'reconnect');
    const done = await h!.server.waitFor('chat.done', (d) => d.chatId === msg.chatId, 20_000);
    expect(done.chatId).toBe(msg.chatId);
  });

  it('a normal chat is still cancelled', async () => {
    const adapter = await setup();
    const msg = ceoChatStart('plain', {}); // no ceoMode: the restricted profile
    h!.server.send('chat.start', msg);
    await waitUntil(() => adapter.chats.length === 1, 10_000, 'the chat runs');
    h!.server.drop();
    const err = await h!.server.waitFor('chat.error', (e) => e.chatId === msg.chatId, 20_000);
    expect(err.error).toMatch(/workstation offline/);
    adapter.release();
  });
});
