import { randomUUID } from 'node:crypto';
import {
  BOARD_VERBS_CAPABILITY,
  DIRECT_MODEL_CAPABILITY,
  PROVIDER_KEYS_BOUND_CAPABILITY,
  type ReportedProvider,
  SESSION_TURNS_CAPABILITY,
  SESSION_VERBS_CAPABILITY,
} from '@aom/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveTurnModel } from '../src/chat/ceo-turns.ts';
import { PROJECTION_TABLES } from '../src/projections/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { defaultModelFor } from '../src/sessions/board-state.ts';
import { runtimeProblem } from '../src/sessions/offer.ts';
import { appoint } from './helpers/ceo.ts';
import { closeAdminPool, q as rawQ } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/**
 * Phase D: the direct-model runtime on the server side: what a workstation offers (merged choices, validation), provider keys
 * as sealed commands, `runtime_unavailable`, mixed providers in one boardroom, costs of unlisted models, the sealed round 1.
 */
const q = async (sql: string, params: unknown[] = []): Promise<any[]> => rawQ(sql, params) as Promise<any[]>;
let w: World;
let r: FakeRunner;
const seen = new Set<string>();
const CAPS = [
  SESSION_TURNS_CAPABILITY,
  SESSION_VERBS_CAPABILITY,
  BOARD_VERBS_CAPABILITY,
  DIRECT_MODEL_CAPABILITY,
  PROVIDER_KEYS_BOUND_CAPABILITY,
];
const KEY = { keyId: 'abcd1234abcd1234', publicKey: 'AAAA' };

const provider = (id: ReportedProvider['id'], label: string, models: string[]): ReportedProvider => ({
  id,
  label,
  models: models.map((m) => ({ id: m, label: m, tier: 'medium' as const })),
});
const OPENAI = provider('openai', 'OpenAI', ['gpt-5-mini', 'gpt-5']);
const GEMINI = provider('google', 'Google Gemini', ['gemini-2.5-flash', 'gemini-2.5-pro']);
const runtimes = (providers: ReportedProvider[]) => [
  { id: 'mock', version: '1', available: true, capabilities: ['shell', 'edit', 'web'] },
  { id: 'claude-code', version: '2', available: true, capabilities: ['shell', 'edit', 'web'] },
  {
    id: 'direct-model',
    version: 'ai-sdk-7',
    available: providers.length > 0,
    capabilities: ['skills', 'resume'],
    providers,
  },
];
/** The runner (re)reports its runtimes: what the real one does after a key is stored. */
const report = async (providers: ReportedProvider[]) => {
  r.send('runtimes.report', { runtimes: runtimes(providers) });
  await r.barrier();
  await w.t.app.ctx.notifier.flush();
};

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ hello: false });
  r.hello({ runtimes: runtimes([OPENAI, GEMINI]), capabilities: CAPS, sudoKey: KEY });
  await r.waitFor('welcome');
  await w.t.app.ctx.notifier.flush();
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

afterEach(async () => {
  for (let pass = 0; pass < 20; pass++) {
    const open = await q(
      `SELECT id, thread_id, status FROM session_turns WHERE status IN ('queued','running')`,
    );
    if (!open.length) break;
    for (const th of new Set(open.map((t) => t.thread_id as string))) {
      await w.t.req('POST', `/api/board/${th}/pause`, { cookie: w.owner.cookie });
      await w.t.req('POST', `/api/discovery/${th}/pause`, { cookie: w.owner.cookie });
    }
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
const raw = (method: string, url: string, body?: unknown, cookie = w.owner.cookie) =>
  w.t.req(method, url, { cookie, ...(body !== undefined ? { body } : {}) });
const nextStart = async (threadId: string, pred: (f: any) => boolean = () => true): Promise<any> => {
  const f = await r.waitFor(
    'chat.start',
    (x) => !seen.has(x.chatId) && x.threadId === threadId && pred(x),
    15_000,
  );
  seen.add(f.chatId);
  return f;
};
const finish = async (
  start: any,
  text = 'ok',
  usage: Record<string, unknown> = { inputTokens: 100, outputTokens: 20 },
) => {
  r.send('chat.done', {
    chatId: start.chatId,
    threadId: start.threadId,
    messageText: text,
    usage: { cacheReadTokens: 0, cacheWriteTokens: 0, ...usage },
  });
  await until(
    async () =>
      (await q('SELECT status FROM session_turns WHERE id=$1', [start.chatId]))[0]?.status === 'done',
  );
};
const persona = (key: string, seat = 'Panel') => ({ kind: 'persona', refId: key, seat });
const newSession = async () =>
  (
    await owner(
      'POST',
      '/api/sessions',
      {
        kind: 'boardroom',
        title: 'Direct models',
        participants: [persona('devils-advocate', 'Skeptic'), persona('cost-hawk')],
      },
      201,
    )
  ).session;
const participantOf = async (threadId: string, key: string): Promise<string> =>
  (await q(`SELECT id FROM thread_participants WHERE thread_id=$1 AND ref_id=$2`, [threadId, key]))[0].id;

describe('what the workstation offers', () => {
  it('stores the providers the runner reports with the workstation and lists them', async () => {
    const ws = (await owner('GET', '/api/workstations')).workstations.find(
      (x: any) => x.id === w.workstationId,
    );
    const direct = ws.runtimes.find((x: any) => x.id === 'direct-model');
    expect(direct.providers.map((p: any) => p.id)).toEqual(['openai', 'google']);
    expect(direct.capabilities).not.toContain('shell');
    const res = await owner('GET', `/api/workstations/${w.workstationId}/providers`);
    expect(res).toMatchObject({
      workstationId: w.workstationId,
      supported: true,
      online: true,
      lastResult: null,
    });
    expect(res.providers.map((p: any) => p.id)).toEqual(['openai', 'google']);
  });

  it('decides what a choice needs with runtimeProblem (pure)', () => {
    const rep = runtimes([OPENAI]);
    expect(runtimeProblem(rep, { runtime: 'direct-model', model: 'openai:gpt-5' })).toBeNull();
    expect(runtimeProblem(rep, { runtime: 'direct-model', model: 'google:gemini-2.5-pro' })).toContain(
      'Google Gemini is not set up on this workstation',
    );
    expect(runtimeProblem(rep, { runtime: 'direct-model', model: 'openai:gpt-9' })).toContain(
      'does not offer the model',
    );
    expect(runtimeProblem(rep, { runtime: 'claude-code', model: 'haiku' })).toBeNull();
    expect(runtimeProblem([{ id: 'mock' }], { runtime: 'claude-code', model: 'haiku' })).toBeNull(); // left to the runner
    expect(runtimeProblem(runtimes([]), { runtime: 'direct-model', model: 'openai:gpt-5' })).toContain(
      'not set up',
    );
    expect(runtimeProblem([], { runtime: 'direct-model', model: 'openai:gpt-5' })).toBeNull(); // nothing known yet
    expect(runtimeProblem([{ id: 'mock' }], { runtime: 'direct-model', model: 'openai:gpt-5' })).toContain(
      'direct-model runtime is not available',
    );
    // an OpenAI-compatible endpoint serves models the runner may not list
    const compat = runtimes([provider('openai-compatible', 'OpenAI-compatible endpoint', ['llama3'])]);
    expect(runtimeProblem(compat, { runtime: 'direct-model', model: 'openai-compatible:qwen3' })).toBeNull();
  });

  it('defaults a role by size across providers when the workstation has no Claude Code', () => {
    const only = ['direct-model'];
    const small = defaultModelFor('persona', only, [
      {
        ...OPENAI,
        models: [
          { id: 'big', label: 'Big', tier: 'large' },
          { id: 'tiny', label: 'Tiny', tier: 'small' },
        ],
      },
    ]);
    expect(small).toEqual({ runtime: 'direct-model', model: 'openai:tiny' });
    const strong = defaultModelFor('synthesis', only, [
      {
        ...OPENAI,
        models: [
          { id: 'big', label: 'Big', tier: 'large' },
          { id: 'tiny', label: 'Tiny', tier: 'small' },
        ],
      },
    ]);
    expect(strong.model).toBe('openai:big');
    expect(defaultModelFor('chair', ['claude-code'], [OPENAI])).toEqual({
      runtime: 'claude-code',
      model: 'sonnet',
    });
    expect(defaultModelFor('chair', ['mock'], [])).toEqual({ runtime: 'mock', model: 'mock' });
  });

  it('a conversation override whose provider key was removed falls back to the default', () => {
    const agent = { runtime: 'claude-code', model: 'sonnet', effort: null };
    const thread = { model_override: { runtime: 'direct-model', model: 'openai:gpt-5' } };
    const chat = { model: 'sonnet', effort: 'high' };
    expect(resolveTurnModel(agent, thread, chat, null, runtimes([OPENAI]))?.source).toBe('thread');
    expect(resolveTurnModel(agent, thread, chat, null, runtimes([GEMINI]))?.source).toBe('default');
    expect(resolveTurnModel(agent, thread, chat, null, [])?.source).toBe('thread');
    // an unknown direct id is refused
    expect(
      resolveTurnModel(
        agent,
        { model_override: { runtime: 'direct-model', model: 'nonsense' } },
        chat,
        null,
        [],
      ),
    ).toBeNull();
  });
});

describe('provider keys travel as sealed commands', () => {
  const commands = (type: string) => r.of('command').filter((c) => c.command === type);

  it('sends no key to a runner that cannot open one bound to its purpose (security review finding 2)', async () => {
    const caps = (
      await q('SELECT capabilities FROM workstation_capabilities WHERE workstation_id=$1', [w.workstationId])
    )[0]?.capabilities as string[];
    await q(
      `UPDATE workstation_capabilities SET capabilities = array_remove(capabilities, $2) WHERE workstation_id=$1`,
      [w.workstationId, PROVIDER_KEYS_BOUND_CAPABILITY],
    );
    try {
      const from = r.received.length;
      const res = await raw('PUT', `/api/workstations/${w.workstationId}/providers/openai`, {
        keyId: KEY.keyId,
        ciphertext: 'U0VDUkVULUtFWQ==',
      });
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body)).toContain('runner_too_old');
      expect(
        r.received.slice(from).some((f) => f.type === 'command' && f.command === 'provider.key.set'),
      ).toBe(false);
    } finally {
      await q('UPDATE workstation_capabilities SET capabilities = $2 WHERE workstation_id=$1', [
        w.workstationId,
        caps,
      ]);
    }
  });

  it('relays the ciphertext, forgets it once answered and never writes it to an event', async () => {
    const stale = await raw('PUT', `/api/workstations/${w.workstationId}/providers/openai`, {
      keyId: 'old',
      ciphertext: 'Zm9v',
    });
    expect(stale.status).toBe(409);
    const from = r.received.length;
    const res = await raw('PUT', `/api/workstations/${w.workstationId}/providers/openai`, {
      keyId: KEY.keyId,
      ciphertext: 'U0VDUkVULUtFWQ==',
      generation: 1_790_000_000,
      models: ['gpt-5.1'],
    });
    expect(res.status).toBe(202);
    const cmd = await r.waitFor('command', (c) => c.command === 'provider.key.set', 5000, from);
    // Q73: the workstation key's version is relayed to the runner (which keeps the revocation floor), not kept by the server
    expect(cmd.payload).toEqual({
      provider: 'openai',
      keyId: KEY.keyId,
      ciphertext: 'U0VDUkVULUtFWQ==',
      generation: 1_790_000_000,
      models: ['gpt-5.1'],
    });
    r.send('command.result', { commandId: cmd.commandId, ok: true, result: { stored: true } });
    await r.barrier();
    await until(
      async () =>
        (await q('SELECT payload FROM runner_commands WHERE id=$1', [cmd.commandId]))[0]?.payload?.keyId ===
        undefined,
    );
    expect((await q('SELECT payload FROM runner_commands WHERE id=$1', [cmd.commandId]))[0].payload).toEqual(
      {},
    );
    expect(await q(`SELECT 1 FROM events WHERE payload::text LIKE '%U0VDUkVULUtFWQ%'`)).toEqual([]);
    const st = await owner('GET', `/api/workstations/${w.workstationId}/providers`);
    expect(st.lastResult).toMatchObject({ provider: 'openai', stored: true });
    expect(JSON.stringify(st)).not.toContain('U0VDUkVU');
  });

  it('shows why a key was not stored, and clears one', async () => {
    const from = r.received.length;
    await raw('PUT', `/api/workstations/${w.workstationId}/providers/google`, {
      keyId: KEY.keyId,
      ciphertext: 'Zm9v',
    });
    const cmd = await r.waitFor(
      'command',
      (c) => c.command === 'provider.key.set' && c.payload.provider === 'google',
      5000,
      from,
    );
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: { stored: false, error: 'the key could not be decrypted: enter it again' },
    });
    await r.barrier();
    await until(
      async () =>
        (await owner('GET', `/api/workstations/${w.workstationId}/providers`)).lastResult?.provider ===
        'google',
    );
    expect((await owner('GET', `/api/workstations/${w.workstationId}/providers`)).lastResult).toMatchObject({
      stored: false,
      error: 'the key could not be decrypted: enter it again',
    });
    const before = r.received.length;
    expect((await raw('DELETE', `/api/workstations/${w.workstationId}/providers/google`)).status).toBe(202);
    const clear = await r.waitFor('command', (c) => c.command === 'provider.key.clear', 5000, before);
    expect(clear.payload).toEqual({ provider: 'google' });
    expect(commands('provider.key.set').length).toBeGreaterThanOrEqual(2);
  });

  it('only the workstation owner may set a key, and an unknown provider is refused', async () => {
    const other = await w.t.userSession(`other-${randomUUID().slice(0, 6)}@example.test`);
    expect(
      (await raw('GET', `/api/workstations/${w.workstationId}/providers`, undefined, other.cookie)).status,
    ).toBe(404);
    expect(
      (
        await raw(
          'PUT',
          `/api/workstations/${w.workstationId}/providers/openai`,
          { keyId: KEY.keyId, ciphertext: 'Zm9v' },
          other.cookie,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await raw('PUT', `/api/workstations/${w.workstationId}/providers/mistral`, {
          keyId: KEY.keyId,
          ciphertext: 'Zm9v',
        })
      ).status,
    ).toBe(400);
  });
});

describe('session turns on direct models', () => {
  it('sends the direct runtime and the purpose to the runner and keeps the model on the turn', async () => {
    const s = await newSession();
    const pid = await participantOf(s.threadId, 'cost-hawk');
    const t = await owner(
      'POST',
      `/api/sessions/${s.threadId}/turns`,
      {
        participantId: pid,
        message: 'Where does the money go?',
        model: { runtime: 'direct-model', model: 'openai:gpt-5-mini' },
      },
      202,
    );
    const start = await nextStart(s.threadId);
    expect(start.chatId).toBe(t.turn.id);
    expect(start.agent).toMatchObject({ runtime: 'direct-model', model: 'openai:gpt-5-mini' });
    await finish(start, 'It goes to tokens.', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      model: 'openai:gpt-5-mini',
    });
    const row = (
      await q(`SELECT cost_usd_micros, cost_unknown, model FROM shift_costs WHERE shift_id=$1`, [
        start.chatId,
      ])
    )[0];
    // $0.25 in + $2 out per million tokens
    expect(Number(row.cost_usd_micros)).toBe(2_250_000);
    expect(row.cost_unknown).toBe(false);
  });

  it('refuses a model whose provider has no key here, with runtime_unavailable', async () => {
    await report([OPENAI]);
    const s = await newSession();
    const pid = await participantOf(s.threadId, 'cost-hawk');
    const res = await raw('POST', `/api/sessions/${s.threadId}/turns`, {
      participantId: pid,
      message: 'hi',
      model: { runtime: 'direct-model', model: 'google:gemini-2.5-pro' },
    });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('runtime_unavailable');
    expect(JSON.stringify(res.body)).toContain('Google Gemini is not set up on this workstation');
    const bad = await raw('POST', `/api/sessions/${s.threadId}/turns`, {
      participantId: pid,
      message: 'hi',
      model: { runtime: 'direct-model', model: 'nonsense' },
    });
    expect(bad.status).toBe(400);
    await report([OPENAI, GEMINI]);
  });

  it('fails a queued turn at dispatch when its provider key was removed meanwhile, instead of leaving it queued', async () => {
    await report([OPENAI, GEMINI]);
    const s = await newSession();
    const pid = await participantOf(s.threadId, 'cost-hawk');
    const model = { runtime: 'direct-model', model: 'openai:gpt-5-mini' };
    // fill the workstation's four turn slots so the next one waits in the queue
    const running: any[] = [];
    for (let i = 0; i < 4; i++) {
      await owner(
        'POST',
        `/api/sessions/${s.threadId}/turns`,
        { participantId: pid, message: `fill ${i}`, model },
        202,
      );
      running.push(await nextStart(s.threadId));
    }
    const waiting = await owner(
      'POST',
      `/api/sessions/${s.threadId}/turns`,
      { participantId: pid, message: 'wait', model },
      202,
    );
    expect((await q('SELECT status FROM session_turns WHERE id=$1', [waiting.turn.id]))[0].status).toBe(
      'queued',
    );
    await report([]); // the key is gone
    await finish(running[0]);
    await until(
      async () =>
        (await q('SELECT status FROM session_turns WHERE id=$1', [waiting.turn.id]))[0]?.status === 'failed',
    );
    const row = (await q('SELECT error FROM session_turns WHERE id=$1', [waiting.turn.id]))[0];
    expect(row.error).toContain('runtime_unavailable');
    expect(row.error).toContain('OpenAI is not set up on this workstation');
    await report([OPENAI, GEMINI]);
  });

  it('flags a model without a price instead of costing it at zero silently, and a rebuild keeps it', async () => {
    const s = await newSession();
    const pid = await participantOf(s.threadId, 'cost-hawk');
    await owner(
      'POST',
      `/api/sessions/${s.threadId}/turns`,
      {
        participantId: pid,
        message: 'hi',
        model: { runtime: 'direct-model', model: 'openai:gpt-5.1' },
      },
      202,
    ).catch(() => undefined);
    // gpt-5.1 is not in the runner's list: refused. Use a listed model the price table does not know.
    await report([provider('openai', 'OpenAI', ['gpt-5-mini', 'gpt-experimental'])]);
    const t = await owner(
      'POST',
      `/api/sessions/${s.threadId}/turns`,
      {
        participantId: pid,
        message: 'hi',
        model: { runtime: 'direct-model', model: 'openai:gpt-experimental' },
      },
      202,
    );
    const start = await nextStart(s.threadId);
    await finish(start, 'fine', { inputTokens: 5000, outputTokens: 500, model: 'openai:gpt-experimental' });
    const row = (
      await q(`SELECT cost_usd_micros, cost_unknown FROM shift_costs WHERE shift_id=$1`, [t.turn.id])
    )[0];
    expect(Number(row.cost_usd_micros)).toBe(0);
    expect(row.cost_unknown).toBe(true);
    const ev = (
      await q(`SELECT payload FROM events WHERE type='SessionTurnCompleted' AND payload->>'turnId'=$1`, [
        t.turn.id,
      ])
    )[0];
    expect(ev.payload).toMatchObject({ costMicros: 0, costUnknown: true });
    const st = (await owner('GET', `/api/sessions/${s.threadId}`)).session;
    const cost = st.cost ?? (await owner('GET', `/api/board/${s.threadId}`).catch(() => ({}))).state?.cost;
    if (cost) expect(cost.unpricedTurns).toBeGreaterThanOrEqual(1);
    const snap = async () => {
      const out: Record<string, unknown> = {};
      out.shift_costs = await q(
        `SELECT shift_id, model, cost_usd_micros, cost_unknown FROM shift_costs WHERE kind='session' ORDER BY shift_id`,
      );
      return JSON.parse(JSON.stringify(out));
    };
    const before = await snap();
    expect(PROJECTION_TABLES).toContain('shift_costs');
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store, w.t.clock.now());
    expect(await snap()).toEqual(before);
    await report([OPENAI, GEMINI]);
  });
});

describe('a boardroom on mixed providers', () => {
  const CAST = [
    { kind: 'persona', refId: 'optimist' },
    {
      kind: 'persona',
      refId: 'devils-advocate',
      model: { runtime: 'direct-model', model: 'openai:gpt-5-mini' },
    },
    { kind: 'persona', refId: 'user-advocate', model: { runtime: 'claude-code', model: 'haiku' } },
    { kind: 'persona', refId: 'cost-hawk' },
    { kind: 'persona', refId: 'security' },
  ];
  const create = async (over: Record<string, unknown> = {}) =>
    (
      await owner(
        'POST',
        '/api/board',
        {
          topic: 'Which provider for what?',
          brief: 'Three seats, three vendors.',
          cast: CAST,
          roundCap: 1,
          models: {
            persona: { runtime: 'direct-model', model: 'google:gemini-2.5-flash' },
            chair: { runtime: 'direct-model', model: 'google:gemini-2.5-pro' },
            synthesis: { runtime: 'direct-model', model: 'openai:gpt-5' },
          },
          ...over,
        },
        201,
      )
    ).state;
  const call = async (turnId: string, method: string, params: Record<string, unknown> = {}) => {
    const rpcId = randomUUID();
    const from = r.received.length;
    r.send('rpc.request', { rpcId, shiftId: turnId, method, params });
    return (await r.waitFor('rpc.response', (f) => f.rpcId === rpcId, 15_000, from)) as any;
  };
  const role = (name: string) => (f: any) => f.message.includes(`"role":"${name}"`);

  it('runs each seat on its own provider, with the purpose of the turn, and hides round 1 until it is revealed', async () => {
    const st = await create();
    const starts: any[] = [];
    // a workstation runs four session turns at once: the fifth seat starts when one of the first four ends
    for (let i = 0; i < 4; i++) starts.push(await nextStart(st.threadId, role('speaker')));
    const by = (key: string) => starts.find((s) => s.session.speaker.personaKey === key);
    expect(by('devils-advocate').agent).toMatchObject({
      runtime: 'direct-model',
      model: 'openai:gpt-5-mini',
    });
    expect(by('user-advocate').agent).toMatchObject({ runtime: 'claude-code', model: 'haiku' });
    // no seat model: the room's persona model, a third provider
    expect(by('cost-hawk').agent).toMatchObject({
      runtime: 'direct-model',
      model: 'google:gemini-2.5-flash',
    });

    // two seats answer: nobody, not even the owner's own GET, sees their words yet
    await finish(by('devils-advocate'), 'DA: it is too early');
    starts.push(await nextStart(st.threadId, role('speaker')));
    for (const s of starts) expect(s.session.purpose).toBe('board_speaker');
    await finish(by('user-advocate'), 'UA: users want it');
    let msgs = (await owner('GET', `/api/threads/${st.threadId}/messages`)).messages as any[];
    expect(msgs.map((m) => m.body).join('\n')).not.toContain('too early');
    expect(msgs.map((m) => m.body).join('\n')).not.toContain('users want it');
    expect(
      msgs.some((m) => m.body.includes('Which provider') || m.kind === 'chat' || m.authorKind === 'user'),
    ).toBe(true);
    // the third answers: round 1 is revealed
    await finish(by('cost-hawk'), 'CH: watch the spend');
    await finish(by('optimist'), 'OP: it can work');
    await finish(by('security'), 'SE: lock it down');
    await until(
      async () => (await owner('GET', `/api/board/${st.threadId}`)).state.config.revealedRound >= 1,
    );
    msgs = (await owner('GET', `/api/threads/${st.threadId}/messages`)).messages as any[];
    const text = msgs.map((m) => m.body).join('\n');
    expect(text).toContain('too early');
    expect(text).toContain('users want it');
    expect(text).toContain('watch the spend');

    // a one-round session goes to the minutes, which run on the synthesis model; the verb still goes through the server's table
    const minutes = await nextStart(st.threadId, (f) => f.session.purpose === 'board_minutes');
    expect(minutes.agent).toMatchObject({ runtime: 'direct-model', model: 'openai:gpt-5' });
    const saved = await call(minutes.chatId, 'board.minutes', { content: '## Positions\n\n- three vendors' });
    expect(saved.ok, saved.error).toBe(true);
    const refusedVerb = await call(minutes.chatId, 'board.next', { speakers: ['x'], reason: 'y' });
    expect(refusedVerb.ok).toBe(false);
    expect(refusedVerb.error).toContain('not available in this turn');
  });

  it('a seat on a provider that has no key here blocks the session with the reason instead of hanging', async () => {
    await report([OPENAI]);
    const st = await create();
    await until(
      async () =>
        (await q(`SELECT session_config->>'blocked' AS b FROM threads WHERE id=$1`, [st.threadId]))[0]?.b ===
        'runtime_unavailable',
      10_000,
    );
    const sys = (await owner('GET', `/api/threads/${st.threadId}/messages`)).messages as any[];
    expect(sys.some((m) => m.kind === 'system' && /not set up on this workstation/.test(m.body))).toBe(true);
    await report([OPENAI, GEMINI]);
  });
});

describe('card work stays on Claude Code', () => {
  it('refuses to hire an agent on the direct-model runtime', async () => {
    const res = await raw('POST', '/api/agents', {
      name: 'Dina',
      roleKey: 'builder',
      seniority: 'senior',
      workstationId: w.workstationId,
      runtime: 'direct-model',
      model: 'openai:gpt-5',
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('runtime_not_for_agents');
  });
});

describe('a Discovery session with a chosen facilitator model', () => {
  it('runs the facilitator on the chosen direct model and can go back to its own', async () => {
    const created = await owner(
      'POST',
      '/api/discovery',
      {
        title: 'Direct facilitator',
        idea: 'A tool for tiny shops',
        model: { runtime: 'direct-model', model: 'openai:gpt-5' },
      },
      201,
    );
    const id = created.state.threadId;
    expect(created.state.config.model).toEqual({ runtime: 'direct-model', model: 'openai:gpt-5' });
    const start = await nextStart(id, (f) => f.session.purpose === 'facilitator');
    expect(start.agent).toMatchObject({ runtime: 'direct-model', model: 'openai:gpt-5' });
    expect(start.session.kind).toBe('discovery');
    await finish(start, 'What is the first question?');
    const patched = await owner('PATCH', `/api/discovery/${id}`, { model: null });
    expect(patched.state.config.model).toBeNull();
    const bad = await raw('PATCH', `/api/discovery/${id}`, {
      model: { runtime: 'direct-model', model: 'nonsense' },
    });
    expect(bad.status).toBe(400);
  });
});

describe('the model menu of the CEO chat', () => {
  it('offers the providers of the CEO’s workstation and refuses a direct model it does not have', async () => {
    await report([OPENAI, GEMINI]);
    await appoint(w);
    await owner('POST', '/api/ceo/chat');
    const state = await owner('GET', '/api/ceo/chat/state');
    expect(state.model.runtimes).toContain('direct-model');
    expect(state.model.providers.map((p: any) => p.id)).toEqual(['openai', 'google']);
    expect(
      (
        await raw('PUT', '/api/ceo/chat/model', {
          choice: { runtime: 'direct-model', model: 'openai:gpt-5' },
        })
      ).status,
    ).toBe(200);
    expect((await owner('GET', '/api/ceo/chat/state')).model.thread).toEqual({
      runtime: 'direct-model',
      model: 'openai:gpt-5',
    });
    expect(
      (
        await raw('PUT', '/api/ceo/chat/model', {
          choice: { runtime: 'direct-model', model: 'openai:gpt-9' },
        })
      ).status,
    ).toBe(409);
    await report([OPENAI]);
    expect(
      (
        await raw('PUT', '/api/ceo/chat/model', {
          choice: { runtime: 'direct-model', model: 'google:gemini-2.5-pro' },
        })
      ).status,
    ).toBe(409);
    expect((await raw('PUT', '/api/ceo/chat/model', { choice: null })).status).toBe(200);
    await report([OPENAI, GEMINI]);
  });
});
