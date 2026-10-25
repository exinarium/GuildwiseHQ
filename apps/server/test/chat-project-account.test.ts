import { CHAT_ACCOUNTS_CAPABILITY, CLAUDE_ACCOUNTS_CAPABILITY } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser } from './helpers/browser.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, MOCK_RUNTIME, ok, type World } from './helpers/world.ts';

/**
 * Owner decision 2026-10-25: a chat about a project's card (and an @mention on it) runs on the account the project chose, not
 * always on main. Chats that are not about a card keep main.
 */
let w: World;
let r: FakeRunner;
const CLAUDE = { id: 'claude-code', version: '2.1.299', available: true, capabilities: ['shell'] };
const acct = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  main: key === 'main',
  source: key === 'main' ? 'default' : 'config_dir',
  login: 'ok',
  usage: 'ok',
  ...over,
});
const hours = (n: number) => new Date(w.t.clock.now().getTime() + n * 3_600_000).toISOString();
async function report(accounts: unknown[]) {
  r.send('runtimes.report', { runtimes: [MOCK_RUNTIME[0], { ...CLAUDE, accounts }] });
  await r.barrier();
}
const setAccount = (accountKey: string | null, fallbackToMain = false) =>
  ok(
    w.t.req('PUT', `/api/projects/${w.projectId}/claude-account`, {
      cookie: w.owner.cookie,
      body: { accountKey, fallbackToMain },
    }),
  );
const newChat = async (agentId: string, extra: Record<string, unknown> = {}) =>
  (await ok<any>(w.t.req('POST', '/api/chats', { cookie: w.owner.cookie, body: { agentId, ...extra } }), 201))
    .chat;
const hireClaude = (name: string) =>
  w.hire(name, 'builder', 'junior', { runtime: 'claude-code', model: 'sonnet' });
const shiftAccount = async (id: string) =>
  (await q('SELECT account_key FROM shifts WHERE id=$1', [id]))[0]?.account_key ?? null;

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ capabilities: [CLAUDE_ACCOUNTS_CAPABILITY, CHAT_ACCOUNTS_CAPABILITY] });
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

describe('a chat about a project card', () => {
  it('runs on the account the project chose and says so in chat.start and the shift', async () => {
    await freshState();
    await setAccount('work');
    await report([acct('main'), acct('work')]);
    const agent = await hireClaude('Ada');
    const card = await w.card();
    const chat = await newChat(agent.id, { cardId: card.id });
    const b = await Browser.open(w.baseUrl, w.owner.cookie);
    await b.hello();
    b.send({ type: 'chat.send', threadId: chat.threadId, body: 'Hi', clientMsgId: 'a1' });
    const start = await r.waitFor('chat.start', (f) => f.threadId === chat.threadId);
    expect(start.account).toEqual({ key: 'work' });
    expect(await shiftAccount(start.chatId)).toBe('work');
  });

  it('a chat that is not about a card keeps the main account, and so does a project without a choice', async () => {
    await freshState();
    await setAccount('work');
    await report([acct('main'), acct('work')]);
    const agent = await hireClaude('Ada');
    const chat = await newChat(agent.id);
    const b = await Browser.open(w.baseUrl, w.owner.cookie);
    await b.hello();
    b.send({ type: 'chat.send', threadId: chat.threadId, body: 'Hi', clientMsgId: 'b1' });
    const start = await r.waitFor('chat.start', (f) => f.threadId === chat.threadId);
    expect(start.account).toBeUndefined();
    expect(await shiftAccount(start.chatId)).toBeNull();
    await setAccount(null);
    const card = await w.card();
    const chat2 = await newChat(agent.id, { cardId: card.id });
    b.send({ type: 'chat.send', threadId: chat2.threadId, body: 'Hi', clientMsgId: 'b2' });
    const start2 = await r.waitFor('chat.start', (f) => f.threadId === chat2.threadId);
    expect(start2.account).toBeUndefined();
  });

  it('the project account out and no fallback: the chat does not start; with fallback it runs on main', async () => {
    await freshState();
    await setAccount('work', false);
    await report([
      acct('main'),
      acct('work', { usage: 'limited', limitedUntil: hours(3), limitedLabel: '18:00' }),
    ]);
    const agent = await hireClaude('Ada');
    const card = await w.card();
    const chat = await newChat(agent.id, { cardId: card.id });
    const b = await Browser.open(w.baseUrl, w.owner.cookie);
    await b.hello();
    b.send({ type: 'chat.send', threadId: chat.threadId, body: 'Hi', clientMsgId: 'c1' });
    await b.until(() => b.of('chat.error').some((m) => m.reason === 'account_unavailable'));
    await setAccount('work', true);
    b.send({ type: 'chat.send', threadId: chat.threadId, body: 'Hi again', clientMsgId: 'c2' });
    const start = await r.waitFor('chat.start', (f) => f.threadId === chat.threadId);
    expect(start.account).toBeUndefined();
  });

  it('a runner that cannot run a chat on a named account is not asked to', async () => {
    await freshState();
    await setAccount('work');
    await report([acct('main'), acct('work')]);
    await q(
      'UPDATE workstation_capabilities SET capabilities = array_remove(capabilities,$2) WHERE workstation_id=$1',
      [w.workstationId, CHAT_ACCOUNTS_CAPABILITY],
    );
    try {
      const agent = await hireClaude('Ada');
      const card = await w.card();
      const chat = await newChat(agent.id, { cardId: card.id });
      const b = await Browser.open(w.baseUrl, w.owner.cookie);
      await b.hello();
      b.send({ type: 'chat.send', threadId: chat.threadId, body: 'Hi', clientMsgId: 'd1' });
      await b.until(() => b.of('chat.error').some((m) => m.reason === 'account_unavailable'));
    } finally {
      await q(
        'UPDATE workstation_capabilities SET capabilities = capabilities || $2::text[] WHERE workstation_id=$1',
        [w.workstationId, [CHAT_ACCOUNTS_CAPABILITY]],
      );
    }
  });
});
