import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnthropicLike } from '../src/assistant/service.ts';
import { createTestApp, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';

/** A scripted stand-in for the Anthropic SDK: records the request and streams the raw events the SDK would. */
function fakeClient(opts: { text?: string[]; usage?: Record<string, number>; fail?: boolean } = {}) {
  const calls: Array<Record<string, any>> = [];
  const usage = {
    input_tokens: 40,
    cache_creation_input_tokens: 8000,
    cache_read_input_tokens: 0,
    ...opts.usage,
  };
  const client: AnthropicLike = {
    messages: {
      stream(params) {
        calls.push(params);
        return (async function* () {
          yield { type: 'message_start', message: { usage: { ...usage, output_tokens: 1 } } };
          if (opts.fail) throw new Error('upstream exploded');
          for (const t of opts.text ?? ['Guildwise HQ ', 'is a management layer.'])
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } };
          yield { type: 'message_delta', delta: {}, usage: { output_tokens: 20 } };
        })();
      },
    },
  };
  return { client, calls };
}

let t: TestApp;
let fake: ReturnType<typeof fakeClient>;
const KEY = 'sk-ant-test-0000000000';

async function boot(env: Record<string, string> = {}, f = fakeClient()) {
  fake = f;
  t = await createTestApp({ env: { ANTHROPIC_API_KEY: KEY, ...env }, assistantClient: f.client });
}
afterEach(async () => {
  await t?.close();
});

const user = (text: string) => ({ role: 'user' as const, content: text });
const ask = (body: unknown, ip = '10.0.0.1') =>
  t.app.inject({
    method: 'POST',
    url: '/api/public/assistant/chat',
    headers: { origin: 'http://aom.test', 'content-type': 'application/json', 'x-forwarded-for': ip },
    payload: JSON.stringify(body),
  });
const events = (payload: string) =>
  payload
    .split('\n\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l.replace(/^data: /, '')));

function solve(challenge: string, bits: number): string {
  for (let n = 0; ; n++) {
    const d = createHash('sha256').update(`${challenge}:${n}`).digest();
    let z = 0;
    for (const b of d) {
      if (b === 0) z += 8;
      else {
        z += Math.clz32(b) - 24;
        break;
      }
    }
    if (z >= bits) return String(n);
  }
}
async function pow() {
  const c = (await t.req('GET', '/api/public/assistant/challenge')).body;
  return { challenge: c.challenge as string, nonce: solve(c.challenge, c.bits) };
}

describe('switches', () => {
  it('is off without an API key (no client), and says so', async () => {
    t = await createTestApp({ assistantClient: null });
    expect((await t.req('GET', '/api/public/assistant/status')).body).toEqual({ available: false });
    const r = await ask({ messages: [user('hi')] });
    expect(r.statusCode).toBe(503);
    expect(JSON.parse(r.payload).error.code).toBe('unavailable');
  });

  it('is on with a key, and the AOM_ASSISTANT kill switch turns it off', async () => {
    await boot();
    expect((await t.req('GET', '/api/public/assistant/status')).body).toEqual({ available: true });
    await t.close();
    await boot({ AOM_ASSISTANT: 'off' });
    expect((await t.req('GET', '/api/public/assistant/status')).body).toEqual({ available: false });
    expect((await ask({ messages: [user('hi')] })).statusCode).toBe(503);
    expect(fake.calls).toHaveLength(0);
  });

  it('the super admin can switch it off and on; nobody else can', async () => {
    await boot();
    const admin = await t.superAdminSession();
    const get = () => t.req('GET', '/api/platform/assistant', { cookie: admin.cookie });
    expect((await get()).body).toMatchObject({
      enabled: true,
      mode: 'public',
      keyConfigured: true,
      live: true,
    });
    const off = await t.req('PUT', '/api/platform/assistant', {
      cookie: admin.cookie,
      body: { enabled: false },
    });
    expect(off.body).toMatchObject({ enabled: false, live: false });
    expect((await t.req('GET', '/api/public/assistant/status')).body.available).toBe(false);
    expect((await ask({ messages: [user('hi')] })).statusCode).toBe(503);
    await t.req('PUT', '/api/platform/assistant', { cookie: admin.cookie, body: { enabled: true } });
    expect((await t.req('GET', '/api/public/assistant/status')).body.available).toBe(true);

    const member = await t.userSession('someone@example.test');
    const refused = await t.req('PUT', '/api/platform/assistant', {
      cookie: member.cookie,
      body: { enabled: false },
    });
    expect([403, 404]).toContain(refused.status);
    expect([401, 404]).toContain((await t.req('GET', '/api/platform/assistant')).status);
  });
});

describe('a conversation', () => {
  beforeEach(async () => {
    await boot();
  });

  it('streams the answer over SSE and calls the model with Haiku, a cached system prompt and no tools', async () => {
    const r = await ask({ messages: [user('What is Guildwise HQ?')] });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/event-stream');
    expect(events(r.payload)).toEqual([
      { type: 'delta', text: 'Guildwise HQ ' },
      { type: 'delta', text: 'is a management layer.' },
      { type: 'done' },
    ]);
    const [call] = fake.calls;
    expect(call).toMatchObject({ model: 'claude-haiku-4-5', max_tokens: 600 });
    expect(call?.tools).toBeUndefined();
    expect(call?.thinking).toBeUndefined();
    expect(call?.system).toHaveLength(1);
    expect(call?.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(call?.system[0].text).toContain('<product_facts>');
    expect(call?.system[0].text).toContain('Starter: $19');
    expect(call?.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'What is Guildwise HQ?', cache_control: { type: 'ephemeral' } }],
      },
    ]);
  });

  it('sends the same system text every time (a stable cache prefix)', async () => {
    await ask({ messages: [user('one')] });
    await ask({ messages: [user('one'), { role: 'assistant', content: 'ok' }, user('two')] });
    expect(fake.calls[0]?.system[0].text).toBe(fake.calls[1]?.system[0].text);
    // only the newest turn carries the second breakpoint
    const last = fake.calls[1]?.messages;
    expect(last.map((m: any) => !!m.content[0].cache_control)).toEqual([false, false, true]);
  });

  it('keeps no conversation: no events, and only counters in the database', async () => {
    const before = (await q('SELECT count(*)::int AS n FROM events'))[0]?.n;
    await ask({ messages: [user('my secret plan is purple')] });
    expect((await q('SELECT count(*)::int AS n FROM events'))[0]?.n).toBe(before);
    const rows = await q('SELECT * FROM assistant_counters');
    expect(JSON.stringify(rows)).not.toContain('purple');
    expect(rows.some((r: any) => r.key === 'all' && Number(r.n) === 1)).toBe(true);
    expect(rows.some((r: any) => r.key.startsWith('ip:') && !r.key.includes('10.0.0.1'))).toBe(true);
  });

  it('refuses a malformed conversation and over-long messages, and a foreign origin', async () => {
    expect((await ask({ messages: [{ role: 'assistant', content: 'hi' }] })).statusCode).toBe(400);
    expect((await ask({ messages: [user('a'), user('b')] })).statusCode).toBe(400);
    expect((await ask({ messages: [user('x'.repeat(1001))] })).statusCode).toBe(400);
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/public/assistant/chat',
      headers: { origin: 'http://evil.test', 'content-type': 'application/json' },
      payload: JSON.stringify({ messages: [user('hi')] }),
    });
    expect(r.statusCode).toBe(403);
    expect(fake.calls).toHaveLength(0);
  });

  it('turns a model failure into an error event (no stack, no key) and still ends the stream', async () => {
    await t.close();
    await boot({}, fakeClient({ fail: true }));
    const r = await ask({ messages: [user('hi')] });
    expect(r.statusCode).toBe(200);
    expect(events(r.payload)).toEqual([{ type: 'error', code: 'model_error' }]);
    expect(r.payload).not.toContain(KEY);
  });
});

describe('limits', () => {
  it('records the spend from the usage the model reports, and refuses once the daily cap is reached', async () => {
    // $0.01 cap: one answer with 8,000 cache-write tokens costs 40 + 8000 x 1.25 + 20 x 5 = 10,140 micro-dollars
    await boot({ AOM_ASSISTANT_PUBLIC_DAILY_USD: '0.01' });
    expect((await t.req('GET', '/api/public/assistant/status')).body.available).toBe(true);
    expect((await ask({ messages: [user('hi')] })).statusCode).toBe(200);
    const spend = (await q(`SELECT n FROM assistant_counters WHERE key='spend'`))[0]?.n;
    expect(Number(spend)).toBe(10_140);
    expect((await t.req('GET', '/api/public/assistant/status')).body).toEqual({
      available: false,
      reason: 'busy',
    });
    const r = await ask({ messages: [user('again')] }, '10.0.0.2');
    expect(r.statusCode).toBe(503);
    expect(JSON.parse(r.payload).error.code).toBe('busy');
    expect(fake.calls).toHaveLength(1);
    const admin = await t.superAdminSession();
    expect((await t.req('GET', '/api/platform/assistant', { cookie: admin.cookie })).body).toMatchObject({
      spentTodayUsd: 0.01014,
      messagesToday: 1,
      live: false,
    });
  });

  it('defaults to $2 a day; the super admin overrides it and can go back to the default', async () => {
    await boot();
    const admin = await t.superAdminSession();
    const get = async () => (await t.req('GET', '/api/platform/assistant', { cookie: admin.cookie })).body;
    expect(await get()).toMatchObject({ dailyCapUsd: 2, defaultCapUsd: 2, capOverridden: false });
    const put = (body: unknown, cookie = admin.cookie) =>
      t.req('PUT', '/api/platform/assistant', { cookie, body });
    expect((await put({ dailyCapUsd: 0.01 })).body).toMatchObject({ dailyCapUsd: 0.01, capOverridden: true });
    // the override beats the environment: one answer spends more than $0.01, then the chat is busy
    expect((await ask({ messages: [user('hi')] })).statusCode).toBe(200);
    expect((await t.req('GET', '/api/public/assistant/status')).body).toEqual({
      available: false,
      reason: 'busy',
    });
    expect((await put({ dailyCapUsd: 5 })).body).toMatchObject({ dailyCapUsd: 5, live: true });
    expect((await put({ enabled: false })).body).toMatchObject({ enabled: false, dailyCapUsd: 5 });
    expect((await put({ dailyCapUsd: null })).body).toMatchObject({ dailyCapUsd: 2, capOverridden: false });
    expect((await put({ dailyCapUsd: -1 })).status).toBe(400);
  });

  it('only the super admin can change the daily cap', async () => {
    await boot();
    const user1 = await t.userSession(uniqueEmail('plain'));
    const r = await t.req('PUT', '/api/platform/assistant', {
      cookie: user1.cookie,
      body: { dailyCapUsd: 99 },
    });
    expect([403, 404]).toContain(r.status);
    const admin = await t.superAdminSession();
    expect((await t.req('GET', '/api/platform/assistant', { cookie: admin.cookie })).body.dailyCapUsd).toBe(
      2,
    );
  });

  it('asks for a proof of work from the sixth message, and each solution works once', async () => {
    await boot();
    for (let i = 0; i < 5; i++) expect((await ask({ messages: [user(`q${i}`)] })).statusCode).toBe(200);
    const blocked = await ask({ messages: [user('q5')] });
    expect(blocked.statusCode).toBe(403);
    expect(JSON.parse(blocked.payload).error.code).toBe('pow_required');
    expect(fake.calls).toHaveLength(5);

    const bad = await pow();
    expect((await ask({ messages: [user('q5')], pow: { ...bad, nonce: 'nope' } })).statusCode).toBe(403);
    expect(
      (await ask({ messages: [user('q5')], pow: { challenge: 'forged.abc.def', nonce: '1' } })).statusCode,
    ).toBe(403);
    const good = await pow();
    expect((await ask({ messages: [user('q5')], pow: good })).statusCode).toBe(200);
    expect((await ask({ messages: [user('q6')], pow: good })).statusCode).toBe(403); // replayed
    // a different visitor is not asked
    expect((await ask({ messages: [user('hello')] }, '10.9.9.9')).statusCode).toBe(200);
  });

  it('also asks after a few turns in one conversation, whatever the visitor claims', async () => {
    await boot();
    const long: any[] = [];
    for (let i = 0; i < 6; i++) {
      long.push(user(`q${i}`));
      if (i < 5) long.push({ role: 'assistant', content: 'a' });
    }
    const r = await ask({ messages: long }, '10.1.1.1');
    expect(JSON.parse(r.payload).error.code).toBe('pow_required');
  });

  it('limits a visitor address to 20 messages an hour and 40 a day, with the message to use Contact us', async () => {
    await boot();
    for (let i = 0; i < 20; i++) {
      const r = await ask({ messages: [user(`q${i}`)], pow: i >= 5 ? await pow() : undefined });
      expect(r.statusCode).toBe(200);
    }
    const r = await ask({ messages: [user('one more')], pow: await pow() });
    expect(r.statusCode).toBe(429);
    expect(JSON.parse(r.payload).error.code).toBe('rate_limited');
    expect(fake.calls).toHaveLength(20);
    // the day limit: pretend the hours before were full
    await q(`UPDATE assistant_counters SET n = 40 WHERE key LIKE 'ip:%' AND bucket LIKE 'd:%'`);
    await q(`DELETE FROM assistant_counters WHERE bucket LIKE 'h:%'`);
    const d = await ask({ messages: [user('tomorrow?')], pow: await pow() });
    expect(d.statusCode).toBe(429);
    expect(JSON.parse(d.payload).error.message).toContain('today');
  });
});

describe('the committed knowledge pack', () => {
  it('has no private names and keeps the refusal rules in the system prompt', async () => {
    const { publicSystemText } = await import('../src/assistant/prompt.ts');
    const text = publicSystemText();
    expect(text).not.toMatch(/ExampleCo/i);
    expect(text).toContain('Contact us');
    expect(text).toContain('English');
  });
});

afterEach(async () => {
  await closeAdminPool().catch(() => undefined);
});
