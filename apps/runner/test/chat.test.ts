import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_ROLES, uuidv7 } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildClaudeChatCommand } from '../src/adapters/claude-code.ts';
import {
  buildChatSettings,
  buildDevopsChatSettings,
  buildMentionWorkSettings,
} from '../src/adapters/claude-policy.ts';
import { ClaudeStreamParser } from '../src/adapters/claude-stream-parser.ts';
import { MockAdapter } from '../src/adapters/mock.ts';
import type { ChatStartInput, RuntimeEvent } from '../src/adapters/types.ts';
import { ClaudeRuntimeConfigSchema, MockRuntimeConfigSchema } from '../src/config.ts';
import { runnerPaths } from '../src/paths.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, tmp, waitUntil } from './helpers.ts';
import { ceoChatStart, FakeChatAdapter } from './owner-helpers.ts';
import { POLICY_PATHS, policyCtx } from './policy-fixtures.ts';
import { ScriptedAdapter } from './scripted-adapter.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const builder = BUILTIN_ROLES.find((r) => r.key === 'builder');
if (!builder) throw new Error('role');
const AGENT_ID = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
const THREAD_ID = '019e3f6a-7b1c-7a2d-8c3e-0123456789c1';

const agent = (over: Record<string, unknown> = {}) => ({
  agentId: AGENT_ID,
  name: 'Ada',
  roleKey: 'builder',
  seniority: 'junior',
  runtime: 'mock',
  model: 'mock',
  skills: [],
  permissions: builder.permissions,
  isDevops: false,
  ...over,
});

const chatStart = (message: string, over: Record<string, unknown> = {}) => ({
  chatId: uuidv7(),
  threadId: THREAD_ID,
  agent: agent(),
  message,
  context: {},
  ...over,
});

const deltas = (hh: Harness, chatId: string) =>
  hh.server
    .of('chat.delta')
    .filter((d) => d.chatId === chatId)
    .map((d) => d.text);

describe('chat on the runner (mock adapter)', () => {
  it('streams a deterministic echo as deltas, then chat.done with the session id and usage', async () => {
    h = await startHarness();
    const msg = chatStart('hello there');
    h.server.send('chat.start', msg);
    const done = await h.server.waitFor('chat.done', (d) => d.chatId === msg.chatId);
    expect(done.messageText).toBe('[mock] Ada heard: hello there (turn 1)');
    expect(deltas(h, msg.chatId).join('')).toBe(done.messageText);
    expect(deltas(h, msg.chatId).length).toBeGreaterThan(3); // streamed word by word
    expect(done.runtimeSessionId).toBe(`mock-${AGENT_ID}-1`);
    expect(done.usage.outputTokens).toBe(done.messageText.length);
    expect(h.server.invalid).toEqual([]);
    expect(h.runner.chat.size).toBe(0);
  });

  it('answers from the recording-only replies file when AOM_MOCK_REPLIES_FILE is set', async () => {
    const file = join(tmp('replies'), 'replies.json');
    writeFileSync(file, JSON.stringify({ 'Say Hi': 'Hello from {name}.' }));
    process.env.AOM_MOCK_REPLIES_FILE = file;
    try {
      h = await startHarness();
      const known = chatStart(' say hi ');
      h.server.send('chat.start', known);
      const d1 = await h.server.waitFor('chat.done', (d) => d.chatId === known.chatId);
      expect(d1.messageText).toBe('Hello from Ada.');
      const other = chatStart('something else');
      h.server.send('chat.start', other);
      const d2 = await h.server.waitFor('chat.done', (d) => d.chatId === other.chatId);
      expect(d2.messageText).toBe('[mock] Ada heard: something else (turn 1)');
    } finally {
      delete process.env.AOM_MOCK_REPLIES_FILE;
    }
  });

  it('resumes the session: the echo counts turns', async () => {
    h = await startHarness();
    const first = chatStart('one');
    h.server.send('chat.start', first);
    const d1 = await h.server.waitFor('chat.done', (d) => d.chatId === first.chatId);
    const second = chatStart('two', { resumeSessionId: d1.runtimeSessionId });
    h.server.send('chat.start', second);
    const d2 = await h.server.waitFor('chat.done', (d) => d.chatId === second.chatId);
    expect(d2.messageText).toBe('[mock] Ada heard: two (turn 2)');
  });

  it('is a pure function of the message: same input, same output (deterministic)', async () => {
    h = await startHarness();
    const a = chatStart('same');
    const b = chatStart('same');
    h.server.send('chat.start', a);
    h.server.send('chat.start', b);
    const [da, db] = await Promise.all([
      h.server.waitFor('chat.done', (d) => d.chatId === a.chatId),
      h.server.waitFor('chat.done', (d) => d.chatId === b.chatId),
    ]);
    expect(da.messageText).toBe(db.messageText);
  });

  it('chat.cancel stops the reply and reports error "cancelled"', async () => {
    process.env.AOM_MOCK_CHAT_TOKEN_MS = '200';
    try {
      h = await startHarness();
      const msg = chatStart('a rather long message that takes a while to echo back to the manager');
      h.server.send('chat.start', msg);
      await h.server.waitFor('chat.delta', (d) => d.chatId === msg.chatId);
      h.server.send('chat.cancel', { chatId: msg.chatId });
      const err = await h.server.waitFor('chat.error', (e) => e.chatId === msg.chatId);
      expect(err.error).toBe('cancelled');
      expect(h.server.of('chat.done')).toHaveLength(0);
    } finally {
      delete process.env.AOM_MOCK_CHAT_TOKEN_MS;
    }
  });

  it('reports a runtime this workstation does not have', async () => {
    h = await startHarness();
    const msg = chatStart('hi', { agent: agent({ runtime: 'codex' }) });
    h.server.send('chat.start', msg);
    const err = await h.server.waitFor('chat.error', (e) => e.chatId === msg.chatId, 20_000);
    expect(err.error).toMatch(/not available for chat/);
  });

  it('refuses a chat and a CEO owner turn while the main account is out, even though another account is usable', async () => {
    h = await startHarness();
    const adapter = Object.assign(new FakeChatAdapter(), {
      accountGate: (key: string) =>
        key === 'main'
          ? { state: 'limited' as const, limitedUntil: new Date(Date.now() + 3_600_000).toISOString() }
          : { state: 'ok' as const },
    });
    h.runner.chat.deps.adapters.set('mock', adapter);
    (h.runner as unknown as { opts: { config: { ceo: { fullPower: boolean } } } }).opts.config.ceo = {
      fullPower: true,
    };
    const plain = chatStart('hello');
    h.server.send('chat.start', plain);
    const e1 = await h.server.waitFor('chat.error', (e) => e.chatId === plain.chatId);
    expect(e1.error).toMatch(/not available for chat/);
    const owner = ceoChatStart('owner turn', { ceoMode: 'owner' });
    h.server.send('chat.start', owner);
    const e2 = await h.server.waitFor('chat.error', (e) => e.chatId === owner.chatId);
    expect(e2.error).toMatch(/not available/);
    expect(adapter.chats).toHaveLength(0);
    expect(adapter.ownerTurns).toHaveLength(0);
  });

  it('runs a chat about a project card on the account the server named, even while main is out; an account that is out refuses it', async () => {
    h = await startHarness();
    const out = new Set(['main']);
    const adapter = Object.assign(new FakeChatAdapter(), {
      accountGate: (key: string) =>
        out.has(key)
          ? { state: 'limited' as const, limitedUntil: new Date(Date.now() + 3_600_000).toISOString() }
          : { state: 'ok' as const },
    });
    h.runner.chat.deps.adapters.set('mock', adapter);
    const onWork = chatStart('hello', { account: { key: 'work' } });
    h.server.send('chat.start', onWork);
    await h.server.waitFor('chat.done', (d) => d.chatId === onWork.chatId);
    expect(adapter.chats.map((c) => c.account)).toEqual(['work']);
    // main is out and nothing names an account: refused, as before
    const onMain = chatStart('hello');
    h.server.send('chat.start', onMain);
    expect((await h.server.waitFor('chat.error', (e) => e.chatId === onMain.chatId)).error).toMatch(
      /not available for chat/,
    );
    // the named account is out too
    out.add('work');
    const again = chatStart('hello', { account: { key: 'work' } });
    h.server.send('chat.start', again);
    expect((await h.server.waitFor('chat.error', (e) => e.chatId === again.chatId)).error).toMatch(
      /not available for chat/,
    );
    expect(adapter.chats).toHaveLength(1);
  });

  it('a dropped connection cancels running chats; the error reaches the server from the outbox after reconnect', async () => {
    process.env.AOM_MOCK_CHAT_TOKEN_MS = '300';
    try {
      h = await startHarness({}, { backoff: { baseMs: 50, capMs: 100, resetAfterMs: 60_000 } });
      const msg = chatStart('this reply is slow enough that the connection drops while it is being written');
      h.server.send('chat.start', msg);
      await h.server.waitFor('chat.delta', (d) => d.chatId === msg.chatId);
      h.server.drop();
      const err = await h.server.waitFor('chat.error', (e) => e.chatId === msg.chatId, 20_000);
      expect(err.error).toMatch(/workstation offline/);
      expect(h.server.of('chat.done')).toHaveLength(0);
    } finally {
      delete process.env.AOM_MOCK_CHAT_TOKEN_MS;
    }
  });

  it('does not count against shift capacity and never claims cards', async () => {
    const adapter = new ScriptedAdapter(async (_i, ctl) => {
      await new Promise((r) => setTimeout(r, 1500));
      await ctl.post('/v1/report', {
        report: { kind: 'outcome', outcomeId: 'handoff', note: 'n', data: {} },
      });
    });
    h = await startHarness({ maxConcurrentShifts: 1 }, { adapters: new Map([['mock', adapter]]) });
    // The scripted adapter has no chat: use a mock adapter for chat alongside it.
    const paths = runnerPaths(h.dataDir);
    const chatAdapter = new MockAdapter(MockRuntimeConfigSchema.parse({ enabled: true }), paths);
    h.runner.chat.deps.adapters.set('mock', chatAdapter);
    const shift = h.runShift({ stage: 'build' });
    await waitUntil(() => h!.runner.supervisor.size === 1, 10_000, 'a shift is running');
    const msg = chatStart('while busy');
    h.server.send('chat.start', msg);
    const done = await h.server.waitFor('chat.done', (d) => d.chatId === msg.chatId);
    expect(done.messageText).toContain('while busy');
    expect(h.server.of('shift.rejected')).toHaveLength(0);
    await shift;
  });

  it('the chat-scoped token allows comment and ledger search, nothing else', async () => {
    const seen: any = {};
    const adapter = new ScriptedAdapter(async () => {});
    const chatAdapter = new MockAdapter(MockRuntimeConfigSchema.parse({ enabled: true }), runnerPaths(tmp()));
    // Capture the env the chat session gets by wrapping the adapter.
    const wrapped = Object.assign(Object.create(chatAdapter), {
      id: 'mock',
      capabilities: () => chatAdapter.capabilities(),
      writeInstructions: async (_s: unknown, md: string) => {
        seen.instructions = md;
      },
      startChat: async (input: ChatStartInput) => {
        seen.input = input;
        const post = async (path: string, body: unknown) => {
          const res = await fetch(`${input.env.AOM_IPC_URL}${path}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${input.env.AOM_SHIFT_TOKEN}`,
            },
            body: JSON.stringify(body),
          });
          return { status: res.status, json: (await res.json()) as any };
        };
        seen.comment = await post('/v1/report', { report: { kind: 'comment', note: 'from chat' } });
        seen.outcome = await post('/v1/report', {
          report: { kind: 'outcome', outcomeId: 'handoff', note: 'n', data: {} },
        });
        seen.search = await post('/v1/rpc', { method: 'ledger.search', params: { query: 'x' } });
        seen.card = await post('/v1/rpc', { method: 'devops.request', params: {} });
        return chatAdapter.startChat(input);
      },
    });
    void adapter;
    h = await startHarness(
      { rpc: (m) => ({ ok: true, result: { method: m.method, shiftId: m.shiftId, params: m.params } }) },
      { adapters: new Map([['mock', wrapped]]) },
    );
    const msg = chatStart('ask the ledger', {
      context: { projectKey: 'TOY', cardRef: 'TOY-9', cardId: THREAD_ID },
    });
    h.server.send('chat.start', msg);
    await h.server.waitFor('chat.done', (d) => d.chatId === msg.chatId);
    expect(seen.comment.status).toBe(200);
    expect(h.server.of('rpc.request').find((r) => r.method === 'thread.post')).toMatchObject({
      shiftId: msg.chatId,
      params: { body: 'from chat' },
    });
    expect(seen.outcome.status).toBe(422);
    expect(seen.search.json.result.method).toBe('ledger.search');
    expect(seen.card.json.ok).toBe(false);
    expect(seen.input.readOnly).toBe(false); // no worktree for TOY-9 on this workstation
    expect(seen.instructions).toContain('card TOY-9');
    expect(seen.input.cwd).toBe(seen.input.sandbox.scratch);
    // After the chat the token is dead.
    const res = await fetch(`${seen.input.env.AOM_IPC_URL}/v1/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${seen.input.env.AOM_SHIFT_TOKEN}`,
      },
      body: JSON.stringify({ method: 'ledger.search', params: { query: 'x' } }),
    });
    expect(res.status).toBe(401);
  });

  it('with the card worktree on this workstation the chat reads it, read only', async () => {
    const seen: any = {};
    h = await startHarness();
    const wt = join(h.dataDir, 'worktrees', 'TOY', 'TOY-1');
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, 'a.txt'), 'x');
    const chatAdapter = h.runner.chat.deps.adapters.get('mock') as MockAdapter;
    const orig = chatAdapter.startChat.bind(chatAdapter);
    chatAdapter.startChat = async (input: ChatStartInput) => {
      seen.input = input;
      return orig(input);
    };
    const msg = chatStart('look at the card', { context: { projectKey: 'TOY', cardRef: 'TOY-1' } });
    h.server.send('chat.start', msg);
    await h.server.waitFor('chat.done', (d) => d.chatId === msg.chatId);
    expect(seen.input.cwd).toBe(wt);
    expect(seen.input.readOnly).toBe(true);
    expect(existsSync(wt)).toBe(true);
  });
});

describe('claude code chat adapter', () => {
  const input = (over: Partial<ChatStartInput> = {}): ChatStartInput => ({
    chatId: 'c1',
    message: 'What changed?',
    cwd: '/data/agents/a1/scratch',
    sandbox: {
      home: '/data/agents/a1/home',
      configDir: '/data/agents/a1/claude',
      scratch: '/data/agents/a1/scratch',
      tmp: '/data/agents/a1/tmp',
    },
    agent: agent({ runtime: 'claude-code', model: 'sonnet', effort: 'low' }) as ChatStartInput['agent'],
    env: { AOM_IPC_URL: 'http://127.0.0.1:1', AOM_SHIFT_TOKEN: 't', PATH: '/bin' },
    readOnly: false,
    ...over,
  });

  it('builds claude -p <message> --resume <id> --output-format stream-json --verbose --include-partial-messages', () => {
    const cfg = ClaudeRuntimeConfigSchema.parse({});
    const first = buildClaudeChatCommand(input(), cfg);
    expect(first.bin).toBe('claude');
    expect(first.args).toEqual([
      '-p',
      'What changed?',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model',
      'sonnet',
      '--effort',
      'low',
      '--permission-mode',
      'dontAsk',
      '--setting-sources',
      'user',
      '--strict-mcp-config',
      '--mcp-config',
      '/data/agents/a1/claude/mcp.json',
      '--disable-slash-commands',
    ]);
    const resumed = buildClaudeChatCommand(input({ resumeSessionId: 'sess-1' }), cfg);
    expect(resumed.args.slice(-2)).toEqual(['--resume', 'sess-1']);
    expect(first.env).toMatchObject({
      CLAUDE_CONFIG_DIR: '/data/agents/a1/claude',
      HOME: '/data/agents/a1/home',
      AOM_SHIFT_TOKEN: 't',
    });
  });

  it('G-Q1: the DevOps agent chat is unsandboxed like its shifts, with the real home; other chats stay sandboxed', () => {
    const devopsRole = BUILTIN_ROLES.find((r) => r.key === 'devops');
    if (!devopsRole) throw new Error('devops role');
    const s = buildDevopsChatSettings(devopsRole.permissions, policyCtx(), POLICY_PATHS);
    expect(s.sandbox).toBeUndefined();
    expect(s.permissions.allow).toEqual(expect.arrayContaining(['Bash', 'Edit']));
    expect(s.permissions.blockReadsOutsideWorkingDirectories).toBeUndefined();
    const cfg = ClaudeRuntimeConfigSchema.parse({});
    const devopsAgent = agent({ runtime: 'claude-code', roleKey: 'devops', isDevops: true });
    const d = buildClaudeChatCommand(input({ agent: devopsAgent as ChatStartInput['agent'] }), cfg);
    expect(d.env.HOME).toBe(homedir());
    expect(d.env.CLAUDE_CONFIG_DIR).toBe('/data/agents/a1/claude');
    const o = buildClaudeChatCommand(input(), cfg);
    expect(o.env.HOME).toBe('/data/agents/a1/home');
    expect(buildChatSettings(false, [], policyCtx(), POLICY_PATHS).sandbox).toBeDefined();
  });

  it('chat tools: read and aom only; a card worktree is also denied edits', () => {
    expect(buildChatSettings(false, [], policyCtx(), POLICY_PATHS).permissions.allow).toEqual([
      'Read',
      'Glob',
      'Grep',
      'Bash(aom:*)',
      'Edit(//data/agents/a1/scratch/**)',
    ]);
    expect(buildChatSettings(false, [], policyCtx(), POLICY_PATHS).permissions.deny).toContain(
      'Bash(git push:*)',
    );
    expect(buildChatSettings(false, [], policyCtx(), POLICY_PATHS).permissions.deny).not.toContain('Edit');
    expect(buildChatSettings(true, [], policyCtx(), POLICY_PATHS).permissions.deny).toEqual(
      expect.arrayContaining([`Edit(//${policyCtx().cwd.replace(/^\//, '')}/**)`]),
    );
  });

  it('chat may write only its scratch dir (desk chat, card chat and intake chat) and never the vault or config dir', () => {
    for (const [label, readOnly, extra] of [
      ['desk chat', false, []],
      ['card chat', true, []],
      ['intake chat', false, ['mcp__atlassian']],
    ] as const) {
      const s = buildChatSettings(
        readOnly,
        [...extra],
        policyCtx({ addDirs: ['/data/vaults/v1'] }),
        POLICY_PATHS,
      );
      const edits = s.permissions.allow.filter((r) => r.startsWith('Edit') || r === 'Write');
      expect(edits, label).toEqual(['Edit(//data/agents/a1/scratch/**)']);
      expect(s.permissions.deny, label).toEqual(
        expect.arrayContaining(['Edit(//data/agents/a1/claude/**)', 'Edit(//data/vaults/v1/**)']),
      );
      // a bare Edit deny would beat the scratch allow
      expect(s.permissions.deny, label).not.toContain('Edit');
      expect(s.permissions.deny, label).not.toContain('Write');
    }
    const ro = buildChatSettings(true, [], policyCtx({ cwd: '/data/worktrees/c1' }), POLICY_PATHS);
    expect(ro.permissions.deny).toContain('Edit(//data/worktrees/c1/**)');
  });

  it('parses partial-message deltas, the session id, usage and the final text', () => {
    const parser = new ClaudeStreamParser();
    const events: RuntimeEvent[] = readFileSync(
      join(import.meta.dirname, 'fixtures/claude-stream/chat.jsonl'),
      'utf8',
    )
      .split('\n')
      .flatMap((l) => parser.parseLine(l));
    expect(events.filter((e) => e.kind === 'delta')).toEqual([
      { kind: 'delta', text: 'Hello' },
      { kind: 'delta', text: ', manager' },
    ]);
    expect(events[0]).toEqual({ kind: 'session', runtimeSessionId: 'c4a7a1de-0b53-4d4c-9d0e-5e3f1a2b3c4d' });
    expect(events.at(-1)).toEqual({ kind: 'final', text: 'Hello, manager' });
    expect(parser.usage()).toMatchObject({ inputTokens: 12, outputTokens: 4, cacheReadTokens: 100 });
  });
});

describe('an @mention that works', () => {
  const run = async (over: Record<string, unknown>, tools: string[], withWorktree = true) => {
    const seen: { input?: ChatStartInput } = {};
    h = await startHarness();
    const wt = join(h.dataDir, 'worktrees', 'TOY', 'TOY-1');
    if (withWorktree) {
      mkdirSync(wt, { recursive: true });
      writeFileSync(join(wt, 'a.txt'), 'x');
    }
    const chatAdapter = h.runner.chat.deps.adapters.get('mock') as MockAdapter;
    const orig = chatAdapter.startChat.bind(chatAdapter);
    chatAdapter.startChat = async (input: ChatStartInput) => {
      seen.input = input;
      return orig(input);
    };
    const msg = chatStart('fix the typo', {
      agent: agent({ runtime: 'claude-code', permissions: { ...builder.permissions, allowedTools: tools } }),
      context: { projectKey: 'TOY', cardRef: 'TOY-1' },
      ...over,
    });
    // the claude-code adapter is not installed here: the mock stands in for the session, the run-mode is what is checked
    h.runner.chat.deps.adapters.set('claude-code', chatAdapter);
    h.server.send('chat.start', msg);
    return { seen, msg, wt };
  };

  it('works in the card folder, writable, when the server granted edit or shell', async () => {
    const { seen, msg, wt } = await run({ mentionWork: true }, ['read', 'edit', 'shell']);
    await h?.server.waitFor('chat.done', (d) => d.chatId === msg.chatId);
    expect(seen.input?.cwd).toBe(wt);
    expect(seen.input?.work).toBe(true);
    expect(seen.input?.readOnly).toBe(false);
  });

  it('stays read only without the flag, or when the permissions hold no edit and no shell', async () => {
    const a = await run({}, ['read', 'edit', 'shell']);
    await h?.server.waitFor('chat.done', (d) => d.chatId === a.msg.chatId);
    expect(a.seen.input?.work).toBeUndefined();
    expect(a.seen.input?.readOnly).toBe(true);
    await h?.stop();
    const b = await run({ mentionWork: true }, ['read']);
    await h?.server.waitFor('chat.done', (d) => d.chatId === b.msg.chatId);
    expect(b.seen.input?.work).toBeUndefined();
    expect(b.seen.input?.readOnly).toBe(true);
  });

  it('refuses when the card folder is not on this workstation, instead of working somewhere else', async () => {
    const { msg } = await run({ mentionWork: true }, ['read', 'edit'], false);
    const err = await h?.server.waitFor('chat.error', (e) => e.chatId === msg.chatId);
    expect(err?.error).toMatch(/working folder is not on this workstation/);
  });
});

describe('the settings of an @mention that works', () => {
  const perms = (over: Partial<(typeof builder)['permissions']> = {}) => ({
    ...builder.permissions,
    allowedTools: ['read', 'edit', 'shell'],
    ...over,
  });

  it('allows edit and shell in the card folder, denies web, MCP and moving the branch, whatever the role', () => {
    const s = buildMentionWorkSettings(perms(), policyCtx(), POLICY_PATHS);
    expect(s.permissions.allow).toEqual(expect.arrayContaining(['Read', 'Bash']));
    expect(s.permissions.allow.some((r) => r.startsWith('Edit(//data/worktrees/'))).toBe(true);
    expect(s.permissions.deny).toEqual(expect.arrayContaining(['WebFetch', 'WebSearch', 'mcp__*']));
    // a builder may switch branches in its own shifts; a comment may not
    expect(s.permissions.deny.some((r) => /checkout|switch/.test(r))).toBe(true);
  });

  it('a shell-only role cannot change files (the worktree is read only to its sandbox), an edit-only role has no shell', () => {
    const shellOnly = buildMentionWorkSettings(
      perms({ allowedTools: ['read', 'shell'], mayCommit: false }),
      policyCtx(),
      POLICY_PATHS,
    );
    expect(shellOnly.permissions.deny.some((r) => r.startsWith('Edit(//data/worktrees/'))).toBe(true);
    const editOnly = buildMentionWorkSettings(
      perms({ allowedTools: ['read', 'edit'] }),
      policyCtx(),
      POLICY_PATHS,
    );
    expect(editOnly.permissions.deny).toContain('Bash');
    expect(editOnly.permissions.allow).not.toContain('Bash');
  });
});
