import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { orderVersionHash, selectChatProfile, shiftProfile } from '../src/ceo/profile.ts';
import { makeShiftStart } from './fixtures.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp } from './helpers.ts';
import { ceoAgent, ceoChatStart, FakeChatAdapter } from './owner-helpers.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const order = (over: Record<string, unknown> = {}) => {
  const title = 'Auto-fix flagged bugs';
  const body = 'Specify every flagged bug for P4.';
  return {
    entryId: '019e3f6a-7b1c-7a2d-8c3e-0123456789d1',
    versionHash: createHash('sha256').update(`${title}\n${body}`).digest('hex'),
    title,
    body,
    ownerMarked: true,
    covers: [],
    ...over,
  };
};

describe('profile selection (pure)', () => {
  it('owner turn: full only with the CEO agent and the local opt-in', () => {
    const agent = { roleKey: 'ceo' };
    expect(selectChatProfile({ ceoMode: 'owner', agent }, { fullPower: true })).toEqual({
      kind: 'full',
      mode: 'owner',
    });
    expect(selectChatProfile({ ceoMode: 'owner', agent }, { fullPower: false })).toEqual({
      kind: 'degraded',
      degraded: 'full_power_off',
    });
    expect(selectChatProfile({ agent }, { fullPower: true })).toEqual({ kind: 'restricted' });
  });

  it('a non-CEO agent never gets full power, whatever the server says', () => {
    for (const roleKey of ['builder', 'devops', 'ba'])
      expect(selectChatProfile({ ceoMode: 'owner', agent: { roleKey } }, { fullPower: true })).toEqual({
        kind: 'restricted',
      });
  });

  it('order turn: refused without the owner mark, on a hash mismatch, or without the opt-in', () => {
    const agent = { roleKey: 'ceo' };
    expect(selectChatProfile({ ceoMode: 'order', agent, order: order() }, { fullPower: true })).toEqual({
      kind: 'full',
      mode: 'order',
    });
    expect(selectChatProfile({ ceoMode: 'order', agent }, { fullPower: true })).toEqual({
      kind: 'refuse',
      error: 'order_not_authorized',
    });
    expect(
      selectChatProfile(
        { ceoMode: 'order', agent, order: order({ ownerMarked: false }) },
        { fullPower: true },
      ),
    ).toEqual({
      kind: 'refuse',
      error: 'order_not_authorized',
    });
    expect(
      selectChatProfile({ ceoMode: 'order', agent, order: order({ body: 'tampered' }) }, { fullPower: true }),
    ).toEqual({
      kind: 'refuse',
      error: 'order_not_authorized',
    });
    expect(selectChatProfile({ ceoMode: 'order', agent, order: order() }, { fullPower: false })).toEqual({
      kind: 'refuse',
      error: 'full_power_off',
    });
  });

  it('a shift is always restricted', () => {
    expect(shiftProfile()).toEqual({ kind: 'restricted' });
    expect(orderVersionHash('a', 'b')).toHaveLength(64);
  });
});

async function runnerWith(fullPower: boolean) {
  h = await startHarness();
  const adapter = new FakeChatAdapter();
  h.runner.chat.deps.adapters.set('mock', adapter);
  (h.runner as unknown as { opts: { config: { ceo: { fullPower: boolean } } } }).opts.config.ceo = {
    fullPower,
  };
  return adapter;
}

describe('the runner picks the profile', () => {
  it('opt-in on: an owner turn runs the full-power builder, in the fixed cwd, with the brief file, and reports tool counts', async () => {
    const adapter = await runnerWith(true);
    adapter.tools = [
      { name: 'Bash', summary: 'ls -la' },
      { name: 'Bash', summary: 'curl -H "Authorization: Bearer abcdefghijkl" x' },
      { name: 'Bash', summary: 'aom graph find PaymentGateway --in /srv/customers/acme/src/ledger.ts' },
      { name: 'Edit', summary: '/x' },
      { name: 'mcp__github__list', summary: '{}' },
      { name: 'mcp__aom_permission__ask', summary: '{}' },
    ];
    const msg = ceoChatStart('install the thing', {
      ceoMode: 'owner',
      cwd: '/tmp',
      briefDelta: 'rule: be brief',
      resumeSessionId: 'sess-0',
    });
    h!.server.send('chat.start', msg);
    const done = await h!.server.waitFor('chat.done', (d) => d.chatId === msg.chatId);
    expect(adapter.ownerTurns).toHaveLength(1);
    expect(adapter.chats).toHaveLength(0);
    const t = adapter.ownerTurns[0]!;
    expect(t.cwd).toBe('/tmp');
    expect(t.mode).toBe('owner');
    expect(t.resumeSessionId).toBe('sess-0');
    expect(t.message).toContain('<guildwise-context>');
    expect(t.message).toContain('install the thing');
    expect(t.env.AOM_SHIFT_TOKEN).toBeTruthy();
    expect(done.toolCounts).toEqual({ bash: 3, edit: 1, mcp: 1, other: 0 });
    // S4: the server gets each command's first word and counts, never arguments, queries or paths
    expect(done.commands).toEqual(['ls*1', 'curl*1', 'aom*1']);
    expect(done.commands?.join(' ')).not.toMatch(/abcdefghijkl|PaymentGateway|customers|ledger/);
    // the full (redacted) text stays in a local audit file
    const audit = readFileSync(join(h!.dataDir, 'logs', 'ceo-turns', `${msg.chatId}.commands.log`), 'utf8');
    expect(audit).toContain('aom graph find PaymentGateway --in /srv/customers/acme/src/ledger.ts');
    expect(audit).not.toContain('abcdefghijkl');
    expect(done.degraded).toBeUndefined();
    expect(done.model).toBe('claude-sonnet-x');
    expect(done.runtimeSessionId).toBe('sess-1');
    // the turn directory is gone once it is over
    expect(existsSync(join(h!.dataDir, 'ceo-turns', msg.chatId))).toBe(false);
  });

  it('opt-in off: an owner turn runs restricted and says so on chat.done', async () => {
    const adapter = await runnerWith(false);
    const msg = ceoChatStart('hello', { ceoMode: 'owner' });
    h!.server.send('chat.start', msg);
    const done = await h!.server.waitFor('chat.done', (d) => d.chatId === msg.chatId);
    expect(adapter.ownerTurns).toHaveLength(0);
    expect(adapter.chats).toHaveLength(1);
    expect(done.degraded).toBe('full_power_off');
  });

  it('refuses an order turn without the Owner mark, on a hash mismatch, and without the opt-in', async () => {
    const adapter = await runnerWith(true);
    const bad = [
      ceoChatStart('o', { ceoMode: 'order' }),
      ceoChatStart('o', { ceoMode: 'order', order: order({ ownerMarked: false }) }),
      ceoChatStart('o', { ceoMode: 'order', order: order({ title: 'other' }) }),
    ];
    for (const m of bad) {
      h!.server.send('chat.start', m);
      const e = await h!.server.waitFor('chat.error', (x) => x.chatId === m.chatId);
      expect(e.error).toBe('order_not_authorized');
    }
    (h!.runner as unknown as { opts: { config: { ceo: { fullPower: boolean } } } }).opts.config.ceo = {
      fullPower: false,
    };
    const m = ceoChatStart('o', { ceoMode: 'order', order: order() });
    h!.server.send('chat.start', m);
    expect((await h!.server.waitFor('chat.error', (x) => x.chatId === m.chatId)).error).toBe(
      'full_power_off',
    );
    expect(adapter.ownerTurns).toHaveLength(0);
    expect(adapter.chats).toHaveLength(0);
  });

  it('a valid order turn runs full power', async () => {
    const adapter = await runnerWith(true);
    const m = ceoChatStart('run the order', { ceoMode: 'order', order: order() });
    h!.server.send('chat.start', m);
    await h!.server.waitFor('chat.done', (x) => x.chatId === m.chatId);
    expect(adapter.ownerTurns[0]?.mode).toBe('order');
  });

  it('an owner turn on a non-CEO agent is a plain restricted chat', async () => {
    const adapter = await runnerWith(true);
    const m = ceoChatStart('hi', { ceoMode: 'owner', agent: ceoAgent({ roleKey: 'builder' }) });
    h!.server.send('chat.start', m);
    const done = await h!.server.waitFor('chat.done', (x) => x.chatId === m.chatId);
    expect(adapter.ownerTurns).toHaveLength(0);
    expect(done.degraded).toBeUndefined();
  });

  it('shift.start never gets the owner builder, even when the payload carries ceoMode-like fields and the opt-in is on', async () => {
    const adapter = await runnerWith(true);
    const msg = makeShiftStart({ stage: 'build', remoteNormalized: h!.repo.remoteNormalized }) as Record<
      string,
      unknown
    >;
    msg.ceoMode = 'owner';
    msg.order = order();
    (msg.agent as Record<string, unknown>).roleKey = 'ceo';
    h!.server.send('shift.start', msg as never);
    await new Promise((r) => setTimeout(r, 500));
    expect(adapter.ownerTurns).toHaveLength(0);
  });

  it('redelivery: a chat.start of a finished or running chat id is ignored', async () => {
    const adapter = await runnerWith(true);
    const m = ceoChatStart('once', { ceoMode: 'owner' });
    h!.server.send('chat.start', m);
    await h!.server.waitFor('chat.done', (x) => x.chatId === m.chatId);
    h!.server.send('chat.start', m);
    await new Promise((r) => setTimeout(r, 300));
    expect(adapter.ownerTurns).toHaveLength(1);
  });

  it('hello announces the full-power capability only with the opt-in, and the active chats', async () => {
    h = await startHarness();
    const hello = (await (
      h.runner as unknown as { buildHello(): Promise<Record<string, unknown>> }
    ).buildHello()) as {
      capabilities: string[];
      activeChats: string[];
    };
    expect(hello.capabilities).not.toContain('ceo-full-power:1');
    expect(hello.activeChats).toEqual([]);
    (h.runner as unknown as { opts: { config: { ceo: { fullPower: boolean } } } }).opts.config.ceo = {
      fullPower: true,
    };
    const on = (await (
      h.runner as unknown as { buildHello(): Promise<Record<string, unknown>> }
    ).buildHello()) as {
      capabilities: string[];
    };
    expect(on.capabilities).toContain('ceo-full-power:1');
  });
});
