import { webcrypto } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { costUsdMicros, isCostUnknown, type ReportedProvider, type Usage } from '@aom/shared';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { DIRECT_MODEL_VERSION, DirectModelAdapter } from '../src/adapters/direct-model.ts';
import type { ChatStartInput, RuntimeEvent, RuntimeSession } from '../src/adapters/types.ts';
import { ModelLister } from '../src/direct/models.ts';
import { ProviderStore } from '../src/direct/store.ts';
import { IpcServer } from '../src/ipc/server.ts';
import type { RunnerKeys } from '../src/secrets/keys.ts';
import { redact, unregisterSecret } from '../src/secrets/redact.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

// ------------------------------------------------------------------------------------------------- fixtures

/** Fake keys: the "ciphertext" is `sealed:<base64 plain>`, so tests need no RSA but go through the same decrypt call. */
const fakeKeys = {
  publicKey: { keyId: 'key-1' },
  decrypt: (c: string) => {
    if (!c.startsWith('sealed:')) throw new Error('bad ciphertext');
    return Buffer.from(c.slice('sealed:'.length), 'base64').toString('utf8');
  },
} as unknown as RunnerKeys;

const S = (plain: string): string => `sealed:${Buffer.from(plain).toString('base64')}`;

const usage = (input: number, output: number, cacheRead = 0) => ({
  inputTokens: { total: input, noCache: input - cacheRead, cacheRead, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
});
const textStep = (text: string, u = usage(10, 5)): never =>
  ({
    stream: convertArrayToReadableStream([
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't' },
      ...text.split(' ').map((w, i) => ({ type: 'text-delta', id: 't', delta: i ? ` ${w}` : w })),
      { type: 'text-end', id: 't' },
      { type: 'finish', usage: u, finishReason: { unified: 'stop', raw: undefined } },
    ] as never),
  }) as never;
const toolStep = (name: string, input: unknown, say = ''): never =>
  ({
    stream: convertArrayToReadableStream([
      { type: 'stream-start', warnings: [] },
      ...(say
        ? [
            { type: 'text-start', id: 's' },
            { type: 'text-delta', id: 's', delta: say },
            { type: 'text-end', id: 's' },
          ]
        : []),
      { type: 'tool-call', toolCallId: `call-${name}`, toolName: name, input: JSON.stringify(input) },
      { type: 'finish', usage: usage(20, 8), finishReason: { unified: 'tool-calls', raw: undefined } },
    ] as never),
  }) as never;

interface Rig {
  adapter: DirectModelAdapter;
  store: ProviderStore;
  rpcs: Array<{ method: string; params: Record<string, unknown> }>;
  ipc: IpcServer;
  root: string;
  input(over?: Partial<ChatStartInput>): ChatStartInput;
}
const stoppers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(stoppers.splice(0).map((f) => f()));
  unregisterSecret('sk-test-key-123456');
});

async function rig(
  model: MockLanguageModelV4,
  o: {
    rpc?: (m: string, p: Record<string, unknown>) => { ok: boolean; result?: unknown; error?: string };
    options?: ConstructorParameters<typeof DirectModelAdapter>[0]['options'];
  } = {},
): Promise<Rig> {
  const root = tmp('aom-direct-');
  const store = new ProviderStore({ file: join(root, 'secrets', 'providers.json'), keys: fakeKeys });
  expect(
    store.set({ provider: 'openai', keyId: 'key-1', ciphertext: S('sk-test-key-123456'), models: [] }).stored,
  ).toBe(true);
  const rpcs: Rig['rpcs'] = [];
  const ipc = new IpcServer();
  await ipc.start();
  stoppers.push(() => ipc.stop());
  const token = ipc.registerShift({
    report: async () => ({ accepted: false, message: 'no' }) as never,
    rpc: async (r) => {
      rpcs.push({ method: r.method, params: r.params });
      return o.rpc?.(r.method, r.params) ?? { ok: true, result: { text: `did ${r.method}` } };
    },
  });
  const adapter = new DirectModelAdapter({
    store,
    root,
    modelFactory: () => model,
    ...(o.options ? { options: o.options } : {}),
  });
  return {
    adapter,
    store,
    rpcs,
    ipc,
    root,
    input: (over = {}) => ({
      chatId: 'turn-1',
      message: 'What do you think?',
      cwd: root,
      sandbox: { home: root, configDir: root, scratch: root, tmp: root, cacheRoot: root },
      agent: {
        agentId: '00000000-0000-4000-8000-0000000000b0',
        name: 'Cost Hawk',
        roleKey: 'persona',
        seniority: 'senior',
        runtime: 'direct-model',
        model: 'openai:gpt-5-mini',
        skills: [],
        permissions: {} as never,
        isDevops: false,
      },
      env: { AOM_IPC_URL: ipc.url, AOM_SHIFT_TOKEN: token },
      readOnly: true,
      instructions: '# Who you are\nYou are the Cost Hawk.',
      sessionTurn: {
        kind: 'boardroom',
        speakerKind: 'persona',
        personaKey: 'cost-hawk',
        purpose: 'board_speaker',
      },
      ...over,
    }),
  };
}

async function collect(s: RuntimeSession): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = [];
  for await (const e of s.events()) out.push(e);
  return out;
}
const exitOf = (evs: RuntimeEvent[]) =>
  evs.find((e) => e.kind === 'exit') as Extract<RuntimeEvent, { kind: 'exit' }>;
const toolNames = (m: MockLanguageModelV4, call = 0): string[] =>
  ((m.doStreamCalls[call]?.tools ?? []) as Array<{ name: string }>).map((t) => t.name).sort();

// ------------------------------------------------------------------------------------------------- tests

describe('direct-model adapter: streaming and usage', () => {
  it('streams text deltas, ends with the final text, usage and exit 0', async () => {
    const model = new MockLanguageModelV4({ doStream: [textStep('Cheap is not free', usage(100, 30, 40))] });
    const r = await rig(model);
    const evs = await collect(await r.adapter.startChat(r.input()));
    expect(
      evs
        .filter((e) => e.kind === 'delta')
        .map((e) => (e as { text: string }).text)
        .join(''),
    ).toBe('Cheap is not free');
    expect(evs.find((e) => e.kind === 'final')).toEqual({ kind: 'final', text: 'Cheap is not free' });
    expect(exitOf(evs)).toEqual({ kind: 'exit', code: 0 });
    const u = evs.find((e) => e.kind === 'usage') as { usage: Usage };
    // input excludes the cached part, which is priced on its own
    expect(u.usage).toMatchObject({
      inputTokens: 60,
      outputTokens: 30,
      cacheReadTokens: 40,
      model: 'openai:gpt-5-mini',
    });
    // the system prompt and the message reach the provider
    const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt);
    expect(prompt).toContain('You are the Cost Hawk.');
    expect(prompt).toContain('What do you think?');
  });

  it('prices usage from the table and flags a model without a price instead of pricing it at zero', () => {
    const u = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 };
    // gpt-5-mini: $0.25 in, $2 out, $0.025 cache read per million
    expect(costUsdMicros('openai:gpt-5-mini', u)).toBe(2_275_000);
    expect(costUsdMicros('openai:gpt-5-mini-2025-08-07', u)).toBe(2_275_000);
    expect(costUsdMicros('google:gemini-2.5-flash', u)).toBeGreaterThan(0);
    expect(costUsdMicros('anthropic:claude-sonnet-5-5', u)).toBe(costUsdMicros('claude-sonnet-5-5', u));
    expect(isCostUnknown('openai:gpt-5-mini')).toBe(false);
    expect(isCostUnknown('openai:gpt-99')).toBe(true);
    expect(costUsdMicros('openai:gpt-99', u)).toBe(0);
    expect(isCostUnknown('openai-compatible:llama3')).toBe(true);
    expect(isCostUnknown('haiku')).toBe(false);
  });
});

describe('direct-model adapter: prompt caching', () => {
  const agentOf = (r: Rig, model: string) => ({ ...r.input().agent, model });
  it('marks the system prompt as a cache breakpoint on Anthropic, and books cache reads and writes', async () => {
    const u = {
      inputTokens: { total: 1500, noCache: 100, cacheRead: 1000, cacheWrite: 400 },
      outputTokens: { total: 50, text: 50, reasoning: 0 },
    };
    const model = new MockLanguageModelV4({ doStream: [textStep('Fine', u)] });
    const r = await rig(model);
    expect(
      r.store.set({ provider: 'anthropic', keyId: 'key-1', ciphertext: S('sk-ant-test-1234'), models: [] })
        .stored,
    ).toBe(true);
    const evs = await collect(
      await r.adapter.startChat(r.input({ agent: agentOf(r, 'anthropic:claude-sonnet-5-5') })),
    );
    const sys = (model.doStreamCalls[0]?.prompt ?? [])[0] as { role: string; providerOptions?: unknown };
    expect(sys.role).toBe('system');
    expect(sys.providerOptions).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } });
    const usage = (evs.find((e) => e.kind === 'usage') as { usage: Usage }).usage;
    expect(usage).toMatchObject({ inputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 400 });
    // cache reads are priced below input, writes above it (the Claude table)
    const cached = costUsdMicros('anthropic:claude-sonnet-5-5', usage);
    const plain = costUsdMicros('anthropic:claude-sonnet-5-5', {
      ...usage,
      inputTokens: 1500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(cached).toBeGreaterThan(0);
    expect(cached).not.toBe(plain);
  });
  it('gives OpenAI a stable cache key per instructions text and keeps the stable prefix first', async () => {
    const model = new MockLanguageModelV4({ doStream: [textStep('One'), textStep('Two')] });
    const r = await rig(model);
    await collect(await r.adapter.startChat(r.input()));
    await collect(await r.adapter.startChat(r.input({ message: 'And now?' })));
    const key = (i: number) =>
      (model.doStreamCalls[i]?.providerOptions as { openai?: { promptCacheKey?: string } } | undefined)
        ?.openai?.promptCacheKey;
    expect(key(0)).toMatch(/^aom-[0-9a-f]{24}$/);
    expect(key(1)).toBe(key(0));
    const prompt = model.doStreamCalls[1]?.prompt ?? [];
    expect(prompt[0]?.role).toBe('system');
    expect(prompt[prompt.length - 1]?.role).toBe('user');
  });
});

describe('direct-model adapter: the tool loop', () => {
  it('calls an allowed verb through the runner IPC and gives the answer back to the model', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        toolStep('board_add', { column: 'risks', text: 'Adoption is assumed' }, 'Noting a risk. '),
        textStep('I put the risk on the board.'),
      ],
    });
    const r = await rig(model, { rpc: () => ({ ok: true, result: { text: 'Added to the whiteboard.' } }) });
    const evs = await collect(await r.adapter.startChat(r.input()));
    expect(r.rpcs).toEqual([
      { method: 'board.add', params: { column: 'risks', text: 'Adoption is assumed' } },
    ]);
    expect(evs.find((e) => e.kind === 'tool')).toMatchObject({ name: 'board_add', id: 'call-board_add' });
    expect(evs.find((e) => e.kind === 'toolresult')).toMatchObject({ id: 'call-board_add' });
    // a new text block after the tool call is announced
    expect(evs.some((e) => e.kind === 'textstart')).toBe(true);
    // the second model call saw the tool result
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('Added to the whiteboard.');
    expect(evs.find((e) => e.kind === 'final')).toEqual({
      kind: 'final',
      text: 'I put the risk on the board.',
    });
    expect(exitOf(evs).code).toBe(0);
  });

  it('adds the fixed parameters of a verb (session note add sends op add)', async () => {
    const model = new MockLanguageModelV4({
      doStream: [toolStep('session_note_add', { section: 'ideas', text: 'Try a pilot' }), textStep('Done.')],
    });
    const r = await rig(model);
    await collect(
      await r.adapter.startChat(
        r.input({ sessionTurn: { kind: 'discovery', speakerKind: 'agent', purpose: 'facilitator' } }),
      ),
    );
    expect(r.rpcs).toEqual([
      { method: 'session.note', params: { section: 'ideas', text: 'Try a pilot', op: 'add' } },
    ]);
  });

  it('offers exactly the tools the turn purpose allows (the table the server enforces)', async () => {
    const run = async (purpose: string, kind: 'discovery' | 'boardroom') => {
      const model = new MockLanguageModelV4({ doStream: [textStep('ok')] });
      const r = await rig(model);
      await collect(
        await r.adapter.startChat(r.input({ sessionTurn: { kind, speakerKind: 'persona', purpose } })),
      );
      return toolNames(model);
    };
    const common = ['ledger_search', 'skill_list', 'skill_show'];
    expect(await run('board_speaker', 'boardroom')).toEqual(
      [...common, 'board_add', 'board_disagreement', 'board_score', 'board_show'].sort(),
    );
    expect(await run('board_chair', 'boardroom')).toEqual(
      [
        ...common,
        'board_add',
        'board_converge',
        'board_disagreement',
        'board_next',
        'board_pause',
        'board_show',
        'delegate',
      ].sort(),
    );
    expect(await run('board_minutes', 'boardroom')).toEqual(
      [...common, 'board_minutes', 'board_show'].sort(),
    );
    expect(await run('ceo_answer', 'discovery')).toEqual(
      [
        ...common,
        'session_answer',
        'session_note_add',
        'session_note_remove',
        'session_note_update',
        'session_show',
      ].sort(),
    );
    const facilitator = await run('facilitator', 'discovery');
    expect(facilitator).toContain('session_ask');
    expect(facilitator).not.toContain('session_answer');
    expect(facilitator.some((n) => n.startsWith('board_'))).toBe(false);
    // a turn with no purpose can only read the registry and the ledger
    expect(await run('', 'discovery')).toEqual(common);
  });

  it('does not run a verb the turn was not offered, and tells the model', async () => {
    const model = new MockLanguageModelV4({
      doStream: [toolStep('board_next', { speakers: ['a'], reason: 'x' }), textStep('I will just answer.')],
    });
    const r = await rig(model);
    const evs = await collect(await r.adapter.startChat(r.input()));
    expect(r.rpcs).toEqual([]); // nothing reached the IPC
    expect(evs.find((e) => e.kind === 'toolresult')).toMatchObject({ isError: true });
    expect(exitOf(evs).code).toBe(0);
  });

  it('reports a refusal of the server as a refused tool result and goes on', async () => {
    const model = new MockLanguageModelV4({
      doStream: [toolStep('board_add', { column: 'ideas', text: 'one more' }), textStep('Understood.')],
    });
    const r = await rig(model, {
      rpc: () => ({ ok: false, error: '`aom board add` is not available in this turn' }),
    });
    const evs = await collect(await r.adapter.startChat(r.input()));
    expect(evs.find((e) => e.kind === 'toolresult')).toMatchObject({ isError: true, refused: true });
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('is not available in this turn');
    expect(exitOf(evs).code).toBe(0);
  });

  it('rejects input that does not match the verb schema without calling the server', async () => {
    const model = new MockLanguageModelV4({
      doStream: [toolStep('board_add', { column: 'nonsense', text: 'x' }), textStep('Fixed.')],
    });
    const r = await rig(model);
    const evs = await collect(await r.adapter.startChat(r.input()));
    expect(r.rpcs).toEqual([]);
    expect(evs.find((e) => e.kind === 'toolresult')).toMatchObject({ isError: true });
  });

  it('stops the loop at the step cap', async () => {
    const loop = Array.from({ length: 6 }, () => toolStep('skill_list', {}));
    const model = new MockLanguageModelV4({ doStream: loop });
    const r = await rig(model, { options: { maxSteps: 3 } });
    const evs = await collect(await r.adapter.startChat(r.input()));
    expect(model.doStreamCalls).toHaveLength(3);
    expect(r.rpcs).toHaveLength(3);
    expect(exitOf(evs).code).toBe(0);
  });
});

describe('direct-model adapter: failures', () => {
  it('fails clearly when the provider has no key on this workstation', async () => {
    const r = await rig(new MockLanguageModelV4({ doStream: [textStep('x')] }));
    const evs = await collect(
      await r.adapter.startChat(r.input({ agent: { ...r.input().agent, model: 'google:gemini-2.5-pro' } })),
    );
    expect(exitOf(evs)).toMatchObject({
      code: 1,
      error: expect.stringContaining('Google Gemini is not set up on this workstation'),
    });
  });

  it('refuses a model id that is not provider:model', async () => {
    const r = await rig(new MockLanguageModelV4({ doStream: [textStep('x')] }));
    const evs = await collect(
      await r.adapter.startChat(r.input({ agent: { ...r.input().agent, model: 'haiku' } })),
    );
    expect(exitOf(evs).error).toContain('not a direct-model id');
  });

  it('never lets the key into an error message', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error('Incorrect API key provided: sk-test-key-123456. You can find your key at ...');
      },
    });
    const r = await rig(model);
    const evs = await collect(await r.adapter.startChat(r.input()));
    const e = exitOf(evs);
    expect(e.code).toBe(1);
    expect(e.error).not.toContain('sk-test-key-123456');
    expect(e.error).toContain('***');
    expect(redact('the key sk-test-key-123456 is here')).toBe('the key *** is here');
  });

  it('times out a turn that never answers', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({ stream: new ReadableStream({ start() {} }) as never }),
    });
    const r = await rig(model, { options: { turnTimeoutMs: 150 } });
    const evs = await collect(await r.adapter.startChat(r.input()));
    expect(exitOf(evs)).toMatchObject({ code: 1, error: expect.stringContaining('timed out') });
  });

  it('can be stopped, and says so', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({ stream: new ReadableStream({ start() {} }) as never }),
    });
    const r = await rig(model);
    const s = await r.adapter.startChat(r.input());
    setTimeout(() => void s.stop('chat.cancelled'), 50);
    const evs = await collect(s);
    expect(exitOf(evs)).toMatchObject({ code: 1, error: 'chat.cancelled' });
  });

  it('cannot work cards: it has no shift entry point and declares no shell or edit', async () => {
    const r = await rig(new MockLanguageModelV4({ doStream: [textStep('x')] }));
    await expect(r.adapter.start({} as never)).rejects.toThrow(/cannot work cards/);
    const caps = await r.adapter.capabilities();
    expect(caps.capabilities).not.toContain('shell');
    expect(caps.capabilities).not.toContain('edit');
    expect(caps.available).toBe(true);
    expect(caps.providers?.map((p) => p.id)).toEqual(['openai']);
  });
});

describe('direct-model adapter: plain chat memory', () => {
  it('remembers earlier messages through the runtime session id', async () => {
    const model = new MockLanguageModelV4({
      doStream: [textStep('First answer'), textStep('Second answer')],
    });
    const r = await rig(model);
    const first = await collect(
      await r.adapter.startChat(r.input({ sessionTurn: undefined, message: 'Hello' })),
    );
    const sid = (first.find((e) => e.kind === 'session') as { runtimeSessionId: string }).runtimeSessionId;
    expect(sid).toMatch(/^direct-/);
    // only the registry and ledger tools in a plain chat
    expect(toolNames(model, 0)).toEqual(['ledger_search', 'skill_list', 'skill_show']);
    await collect(
      await r.adapter.startChat(
        r.input({ sessionTurn: undefined, message: 'And then?', resumeSessionId: sid }),
      ),
    );
    const prompt = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(prompt).toContain('Hello');
    expect(prompt).toContain('First answer');
    expect(prompt).toContain('And then?');
    const file = join(r.root, 'direct-chats', `${sid}.json`);
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o077).toBe(0);
  });

  it('a session turn keeps no memory of its own', async () => {
    const model = new MockLanguageModelV4({ doStream: [textStep('one')] });
    const r = await rig(model);
    const evs = await collect(await r.adapter.startChat(r.input()));
    expect(evs.some((e) => e.kind === 'session')).toBe(false);
    expect(existsSync(join(r.root, 'direct-chats'))).toBe(false);
  });
});

describe('provider store', () => {
  const mk = () => {
    const root = tmp('aom-prov-');
    const file = join(root, 'secrets', 'providers.json');
    return { file, store: new ProviderStore({ file, keys: fakeKeys }) };
  };

  it('keeps the ciphertext at mode 0600, never the plain key, and registers it for redaction', () => {
    const { file, store } = mk();
    expect(
      store.set({ provider: 'anthropic', keyId: 'key-1', ciphertext: S('sk-ant-secret-987654'), models: [] }),
    ).toEqual({ stored: true });
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('sk-ant-secret-987654');
    expect(statSync(file).mode & 0o077).toBe(0);
    expect(redact('x sk-ant-secret-987654 y')).toBe('x *** y');
    store.clear('anthropic');
    expect(redact('x sk-ant-secret-987654 y')).toBe('x sk-ant-secret-987654 y');
    expect(store.configured()).toEqual([]);
  });

  it('re-registers keys after a restart', () => {
    const { file, store } = mk();
    store.set({ provider: 'openai', keyId: 'key-1', ciphertext: S('sk-restart-key-111'), models: [] });
    unregisterSecret('sk-restart-key-111');
    new ProviderStore({ file, keys: fakeKeys });
    expect(redact('sk-restart-key-111')).toBe('***');
    unregisterSecret('sk-restart-key-111');
  });

  it('refuses a key sealed for another runner key, an empty key and a missing key', () => {
    const { store } = mk();
    expect(store.set({ provider: 'openai', keyId: 'old', ciphertext: S('abc'), models: [] }).error).toContain(
      'another runner key',
    );
    expect(
      store.set({ provider: 'openai', keyId: 'key-1', ciphertext: 'garbage', models: [] }).error,
    ).toContain('could not be decrypted');
    expect(store.set({ provider: 'openai', keyId: 'key-1', models: [] }).error).toContain('needs an API key');
  });

  it('an OpenAI-compatible endpoint needs a clean base URL and may be keyless', () => {
    const { store } = mk();
    expect(store.set({ provider: 'openai-compatible', keyId: 'key-1', models: [] }).error).toContain(
      'endpoint',
    );
    expect(
      store.set({ provider: 'openai-compatible', keyId: 'key-1', baseUrl: 'ftp://x', models: [] }).error,
    ).toContain('http');
    expect(
      store.set({ provider: 'openai-compatible', keyId: 'key-1', baseUrl: 'http://u:p@host/v1', models: [] })
        .error,
    ).toContain('not in the URL');
    expect(
      store.set({
        provider: 'openai-compatible',
        keyId: 'key-1',
        baseUrl: 'http://localhost:11434/v1/',
        models: ['llama3.2'],
      }),
    ).toEqual({ stored: true });
    const rep = store.report({ 'openai-compatible': ['qwen3', 'llama3.2'] });
    expect(rep).toEqual<ReportedProvider[]>([
      {
        id: 'openai-compatible',
        label: 'OpenAI-compatible endpoint',
        models: [
          { id: 'llama3.2', label: 'llama3.2' },
          { id: 'qwen3', label: 'qwen3' },
        ],
        endpointHost: 'localhost:11434',
        keySource: 'workstation',
      },
    ]);
    expect(store.get('openai-compatible')?.baseUrl).toBe('http://localhost:11434/v1');
  });

  it('reports built-in models plus the owner’s extra ids, names only', () => {
    const { store } = mk();
    store.set({
      provider: 'openai',
      keyId: 'key-1',
      ciphertext: S('sk-names-only-1234'),
      models: ['gpt-5.1', ' gpt-5.1 ', ''],
    });
    const rep = store.report();
    expect(rep[0]?.models.map((m) => m.id)).toEqual([
      'gpt-5-nano',
      'gpt-5-mini',
      'gpt-4.1',
      'gpt-5',
      'gpt-5.1',
    ]);
    expect(JSON.stringify(rep)).not.toContain('sk-names-only-1234');
    unregisterSecret('sk-names-only-1234');
  });
});

describe('the model list of an OpenAI-compatible endpoint', () => {
  it('lists, caches and reports a refusal without the key', async () => {
    let calls = 0;
    let status = 200;
    const lister = new ModelLister({
      fetch: async (url, init) => {
        calls++;
        expect(url).toBe('http://ollama.local/v1/models');
        expect(((init?.headers ?? {}) as Record<string, string>).authorization).toBe('Bearer k-123');
        return status === 200
          ? new Response(JSON.stringify({ data: [{ id: 'llama3' }, { id: 'qwen3' }, { nope: 1 }] }))
          : new Response('no', { status });
      },
    });
    const cfg = {
      id: 'openai-compatible' as const,
      apiKey: 'k-123',
      baseUrl: 'http://ollama.local/v1',
      models: [],
    };
    expect((await lister.refresh(cfg)).ids).toEqual(['llama3', 'qwen3']);
    await lister.refresh(cfg);
    expect(calls).toBe(1);
    status = 401;
    const bad = await lister.refresh(cfg, true);
    expect(bad).toEqual({ ids: [], problem: 'the endpoint refused the key' });
    expect(JSON.stringify(bad)).not.toContain('k-123');
  });
});

describe('the pinned AI SDK', () => {
  it('pins ai and the provider packages exactly and reports the ai version', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    for (const name of [
      'ai',
      '@ai-sdk/anthropic',
      '@ai-sdk/openai',
      '@ai-sdk/google',
      '@ai-sdk/openai-compatible',
    ])
      expect(pkg.dependencies[name], name).toMatch(/^\d+\.\d+\.\d+$/);
    expect(DIRECT_MODEL_VERSION).toBe(`ai-sdk-${pkg.dependencies.ai}`);
  });
});

describe('the capabilities of the runtime', () => {
  it('does not wait for an endpoint’s model list: reports what is cached and reports again when the list arrives', async () => {
    const root = tmp('aom-direct-caps-');
    const store = new ProviderStore({ file: join(root, 'p.json'), keys: fakeKeys });
    store.set({
      provider: 'openai-compatible',
      keyId: 'key-1',
      baseUrl: 'http://ollama.local/v1',
      models: [],
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let changed = 0;
    const adapter = new DirectModelAdapter({
      store,
      root,
      onModelsChanged: () => {
        changed++;
      },
      fetch: async () => {
        await gate;
        return new Response(JSON.stringify({ data: [{ id: 'llama3' }] }));
      },
    });
    const first = await adapter.capabilities(); // returns at once, although the fetch is pending
    expect(first.available).toBe(true);
    expect(first.providers?.[0]?.models).toEqual([]);
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(changed).toBe(1);
    expect((await adapter.capabilities()).providers?.[0]?.models.map((m) => m.id)).toEqual(['llama3']);
  });

  it('is unavailable with no provider and says so with an empty provider list', async () => {
    const root = tmp('aom-direct-caps2-');
    const adapter = new DirectModelAdapter({
      store: new ProviderStore({ file: join(root, 'p.json'), keys: fakeKeys }),
      root,
    });
    expect(await adapter.capabilities()).toMatchObject({
      runtime: 'direct-model',
      available: false,
      providers: [],
    });
  });
});

describe('direct-model adapter against an OpenAI-compatible HTTP server (no mocks of the SDK)', () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });
  const sse = (chunks: unknown[]) =>
    `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
  const chunk = (delta: unknown, finish: string | null = null, extra: Record<string, unknown> = {}) => ({
    id: 'c1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'local-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  });

  async function fake(
    handler: (
      body: Record<string, unknown>,
      auth: string | undefined,
      res: import('node:http').ServerResponse,
    ) => void,
  ): Promise<string> {
    server = createServer((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => handler(b ? JSON.parse(b) : {}, req.headers.authorization, res));
    });
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
    const a = server.address();
    return `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/v1`;
  }
  async function compatRig(baseUrl: string) {
    const root = tmp('aom-direct-http-');
    const store = new ProviderStore({ file: join(root, 'p.json'), keys: fakeKeys });
    store.set({
      provider: 'openai-compatible',
      keyId: 'key-1',
      ciphertext: S('sk-local-key-777777'),
      baseUrl,
      models: [],
    });
    const adapter = new DirectModelAdapter({ store, root });
    const base: ChatStartInput = {
      chatId: 'c',
      message: 'Hi there',
      cwd: root,
      sandbox: { home: root, configDir: root, scratch: root, tmp: root, cacheRoot: root },
      agent: {
        agentId: 'a',
        name: 'P',
        roleKey: 'persona',
        seniority: 'senior',
        runtime: 'direct-model',
        model: 'openai-compatible:local-model',
        skills: [],
        permissions: {} as never,
        isDevops: false,
      } as never,
      env: {},
      readOnly: true,
      instructions: 'You are P.',
      sessionTurn: { kind: 'boardroom', speakerKind: 'persona', purpose: '' },
    };
    return { adapter, base };
  }

  it('streams a real completion, sends the key as a bearer token and reports usage', async () => {
    let auth: string | undefined;
    let body: Record<string, unknown> = {};
    const url = await fake((b, a, res) => {
      auth = a;
      body = b;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        sse([
          chunk({ role: 'assistant', content: 'Hel' }),
          chunk({ content: 'lo!' }, 'stop'),
          {
            id: 'c1',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'local-model',
            choices: [],
            usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
          },
        ]),
      );
    });
    const { adapter, base } = await compatRig(url);
    const evs = await collect(await adapter.startChat(base));
    expect(
      evs
        .filter((e) => e.kind === 'delta')
        .map((e) => (e as { text: string }).text)
        .join(''),
    ).toBe('Hello!');
    expect(auth).toBe('Bearer sk-local-key-777777');
    expect(body.model).toBe('local-model');
    expect(body.stream).toBe(true);
    const u = evs.find((e) => e.kind === 'usage') as { usage: Usage };
    expect(u.usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 3,
      model: 'openai-compatible:local-model',
    });
    // a local model has no price: flagged, not zero
    expect(isCostUnknown(u.usage.model ?? '')).toBe(true);
    expect(exitOf(evs).code).toBe(0);
    unregisterSecret('sk-local-key-777777');
  });

  it('turns an HTTP 401 into a plain sentence without the key', async () => {
    const url = await fake((_b, _a, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid key sk-local-key-777777' } }));
    });
    const { adapter, base } = await compatRig(url);
    const evs = await collect(await adapter.startChat(base));
    const e = exitOf(evs);
    expect(e.code).toBe(1);
    expect(e.error).toContain('refused the API key');
    expect(e.error).not.toContain('sk-local-key-777777');
    unregisterSecret('sk-local-key-777777');
  });
});

// ------------------------------------------------------------------------------------------------- the runner

async function seal(publicKeyB64: string, text: string): Promise<string> {
  const key = await webcrypto.subtle.importKey(
    'spki',
    Buffer.from(publicKeyB64, 'base64'),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  );
  return Buffer.from(
    await webcrypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, new TextEncoder().encode(text)),
  ).toString('base64');
}

describe('the runner with the direct-model runtime', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.stop();
    h = undefined;
  });

  it('announces direct-model:1, reports the runtime unavailable until a key is stored, then reports the provider', async () => {
    h = await startHarness();
    expect(h.server.of('hello')[0]?.capabilities).toContain('direct-model:1');
    const hello = h.server.of('hello')[0];
    expect(hello?.runtimes.find((r) => r.id === 'direct-model')).toMatchObject({
      available: false,
      providers: [],
    });
    const runner = h.runner as unknown as { keys: RunnerKeys };
    const key = 'sk-runner-test-key-424242';
    h.server.send('command', {
      commandId: 'c-prov',
      command: 'provider.key.set',
      payload: {
        provider: 'openai',
        keyId: runner.keys.publicKey.keyId,
        ciphertext: await seal(runner.keys.publicKey.publicKey, key),
        models: ['gpt-5.1'],
      },
    });
    const done = await h.server.waitFor('command.result', (m) => m.commandId === 'c-prov');
    expect(done).toMatchObject({ ok: true, result: { stored: true } });
    expect(JSON.stringify(done)).not.toContain(key);
    const rep = await h.server.waitFor(
      'runtimes.report',
      (m) => !!m.runtimes.find((r) => r.id === 'direct-model' && r.available),
    );
    const direct = rep.runtimes.find((r) => r.id === 'direct-model');
    expect(direct?.providers?.[0]).toMatchObject({ id: 'openai', label: 'OpenAI' });
    expect(direct?.providers?.[0]?.models.map((m) => m.id)).toContain('gpt-5.1');
    expect(JSON.stringify(rep)).not.toContain(key);
    expect(direct?.capabilities).not.toContain('shell');
    h.server.send('command', {
      commandId: 'c-clear',
      command: 'provider.key.clear',
      payload: { provider: 'openai' },
    });
    expect(await h.server.waitFor('command.result', (m) => m.commandId === 'c-clear')).toMatchObject({
      ok: true,
    });
    await h.server.waitFor(
      'runtimes.report',
      (m) => !!m.runtimes.find((r) => r.id === 'direct-model' && !r.available),
    );
    unregisterSecret(key);
  });

  it('runs a session turn on the direct runtime end to end: chat frames, a verb over rpc, usage', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        toolStep('board_add', { column: 'ideas', text: 'Pilot first' }),
        textStep('I added an idea.'),
      ],
    });
    const root = tmp('aom-direct-e2e-');
    const store = new ProviderStore({ file: join(root, 'p.json'), keys: fakeKeys });
    store.set({ provider: 'openai', keyId: 'key-1', ciphertext: S('sk-e2e-key-5555'), models: [] });
    const adapter = new DirectModelAdapter({ store, root, modelFactory: () => model });
    const rpcs: string[] = [];
    h = await startHarness(
      {
        rpc: (m) => {
          rpcs.push(m.method);
          return { ok: true, result: { text: 'Added.' } };
        },
      },
      { adapters: new Map([['direct-model', adapter]]) },
    );
    const turnId = '019e3f6a-7b1c-7a2d-8c3e-0123456789d1';
    h.server.send('chat.start', {
      chatId: turnId,
      threadId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c1',
      agent: {
        agentId: '00000000-0000-4000-8000-0000000000b0',
        name: 'Cost Hawk',
        roleKey: 'persona',
        seniority: 'senior',
        runtime: 'direct-model',
        model: 'openai:gpt-5-mini',
        skills: [],
        permissions: {
          allowedTools: ['read'],
          deniedShellPatterns: [],
          writableGlobs: [],
          mayCommit: false,
          browser: false,
          readOrgRepos: false,
          riskTiers: ['small', 'large'],
          repoIds: [],
        },
        isDevops: false,
      },
      message: '## Your turn\n\nRisks?',
      context: { orgId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a9' },
      session: {
        turnId,
        kind: 'boardroom',
        purpose: 'board_speaker',
        speaker: { kind: 'persona', name: 'Cost Hawk', personaKey: 'cost-hawk', seat: 'Panel' },
        instructions: 'You are the Cost Hawk.',
        roster: [{ name: 'Pieter', kind: 'user', seat: 'Owner' }],
      },
    });
    const done = await h.server.waitFor('chat.done', (d) => d.chatId === turnId);
    expect(done.messageText).toBe('I added an idea.');
    expect(done.usage).toMatchObject({ model: 'openai:gpt-5-mini' });
    expect(rpcs).toEqual(['board.add']);
    // the system prompt is the direct rendering: tools, not the shell
    const system = JSON.stringify(model.doStreamCalls[0]?.prompt);
    expect(system).toContain('call the matching tool');
    expect(system).toContain('aom board add');
    expect(system).not.toContain('The only command you may run is');
    expect(JSON.stringify(done.segments)).toContain('board_add');
    expect(h.server.invalid).toEqual([]);
    unregisterSecret('sk-e2e-key-5555');
  });

  it('refuses a verb that is not a session verb even from a direct tool call (the runner handler is the same)', async () => {
    const model = new MockLanguageModelV4({ doStream: [toolStep('skill_list', {}), textStep('ok')] });
    const root = tmp('aom-direct-e2e2-');
    const store = new ProviderStore({ file: join(root, 'p.json'), keys: fakeKeys });
    store.set({ provider: 'openai', keyId: 'key-1', ciphertext: S('sk-e2e-key-6666'), models: [] });
    const adapter = new DirectModelAdapter({ store, root, modelFactory: () => model });
    h = await startHarness({}, { adapters: new Map([['direct-model', adapter]]) });
    const chatId = '019e3f6a-7b1c-7a2d-8c3e-0123456789d2';
    h.server.send('chat.start', {
      chatId,
      threadId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c1',
      agent: {
        agentId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
        name: 'Ana',
        roleKey: 'ba',
        seniority: 'senior',
        runtime: 'direct-model',
        model: 'openai:gpt-5-mini',
        skills: [],
        permissions: {
          allowedTools: ['read'],
          deniedShellPatterns: [],
          writableGlobs: [],
          mayCommit: false,
          browser: false,
          readOrgRepos: false,
          riskTiers: ['small', 'large'],
          repoIds: [],
        },
        isDevops: false,
      },
      message: 'hello',
      context: { orgId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a9' },
    });
    const done = await h.server.waitFor('chat.done', (d) => d.chatId === chatId);
    expect(done.messageText).toBe('ok');
    expect(done.runtimeSessionId).toMatch(/^direct-/);
    // the instructions of a plain chat say what the model cannot do
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain('without a shell or files');
    unregisterSecret('sk-e2e-key-6666');
  });
});
