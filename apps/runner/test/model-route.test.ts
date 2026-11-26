import { mkdtempSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isModelApiHost, MODEL_ROUTE, modelProxyPlan } from '../src/box/launch.ts';
import {
  anthropicRequestFilter,
  type FilterLists,
  LISTS,
  listsAgainstNever,
  type ModelCaptureEvent,
  NEVER,
} from '../src/box/model-filter.ts';
import { limitResetOf, ModelLedger } from '../src/box/model-ledger.ts';
import { JsonNumber, type JsonValue, strictParse, strictStringify } from '../src/box/strict-json.ts';
import {
  MODEL_ROUTE_MAX_BUFFERED_BYTES,
  MODEL_ROUTE_MAX_IN_FLIGHT,
  setFilteredRouteBufferCapForTests,
  setPerRouteBufferCapForTests,
  startEgressProxy,
} from '../src/sandbox/egress-proxy.ts';

/**
 * runner-bare-bin (B1, B2, B4, B6, S5, S6, S7, S8, S9, S10): the model route of the boxes rebuilds every request from a
 * checked value, forwards only allowlisted headers, and its ledger (outside the box) is the runner's only source of usage,
 * login and limit state and of the DevOps audit.
 */

const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

const P = { maxDepth: 64, maxNodes: 2_000_000 };
const parse = (s: string) => strictParse(Buffer.from(s), P);

// ---------------------------------------------------------------- strict JSON

describe('strictParse / strictStringify', () => {
  it('parses ordinary JSON and writes it back with the number literals unchanged', () => {
    const src = '{"a":[1,2.5,-3e2,true,false,null,"x\\u00e9\\n"],"big":12345678901234567890,"o":{}}';
    const v = parse(src);
    expect(strictStringify(v)).toBe(src.replace('\\u00e9', 'é'));
    const big = (v as Record<string, JsonValue>).big as JsonNumber;
    expect(big).toBeInstanceOf(JsonNumber);
    expect(big.literal).toBe('12345678901234567890');
  });

  it.each([
    ['a duplicate top-level key', '{"tools":[],"tools":[]}'],
    ['a duplicate key inside a tool', '{"tools":[{"type":"a","type":"b"}]}'],
    ['a lone high surrogate', '{"a":"\\ud800"}'],
    ['a lone low surrogate', '{"a":"\\udc00x"}'],
    ['a non-finite number', '{"a":1e400}'],
    ['trailing data', '{"a":1} {}'],
    ['a trailing comma', '{"a":1,}'],
    ['a leading zero', '{"a":01}'],
    ['a control character in a string', '{"a":"\u0001"}'],
  ])('refuses %s', (_why, src) => {
    expect(() => parse(src)).toThrow();
  });

  it('refuses a byte-order mark and invalid UTF-8', () => {
    expect(() => strictParse(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), P)).toThrow(/byte-order/);
    expect(() => strictParse(Buffer.from([0x22, 0xff, 0x22]), P)).toThrow(/UTF-8/);
  });

  it('refuses depth 65 and a 100k-deep array without a stack overflow; refuses past the node cap', () => {
    expect(() => parse(`${'['.repeat(64)}${']'.repeat(64)}`)).not.toThrow();
    expect(() => parse(`${'['.repeat(65)}${']'.repeat(65)}`)).toThrow(/too deep/);
    expect(() => parse(`${'['.repeat(100_000)}${']'.repeat(100_000)}`)).toThrow(/too deep/);
    expect(() => strictParse(Buffer.from('[1,2,3,4]'), { maxDepth: 4, maxNodes: 3 })).toThrow(/too many/);
  });

  it('a "__proto__" key is an ordinary key', () => {
    const v = parse('{"__proto__":{"x":1}}') as Record<string, JsonValue>;
    expect(Object.keys(v)).toEqual(['__proto__']);
    expect(strictStringify(v)).toBe('{"__proto__":{"x":1}}');
  });
});

// ---------------------------------------------------------------- the filter

const H = (h: Record<string, string | string[]> = {}): IncomingHttpHeaders => ({
  'content-type': 'application/json',
  'anthropic-version': '2023-06-01',
  ...h,
});

const msg = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    model: 'claude-opus-5-5',
    max_tokens: 100,
    stream: true,
    system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'system', content: 'env' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 't', signature: 's' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'ok' }] }],
      },
    ],
    tools: [{ name: 'Bash', description: 'd', input_schema: { type: 'object', $defs: {}, properties: {} } }],
    metadata: { user_id: 'u' },
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
    ...extra,
  });

const run = (
  body: string,
  o: { serverTools?: 'none' | 'web_search'; headers?: IncomingHttpHeaders; testLists?: FilterLists } = {},
) => {
  const events: ModelCaptureEvent[] = [];
  const f = anthropicRequestFilter({
    serverTools: o.serverTools ?? 'none',
    capture: (e) => events.push(e),
    ...(o.testLists ? { testLists: o.testLists } : {}),
  });
  return { r: f(parse(body), o.headers ?? H(), '/v1/messages'), events };
};

describe('anthropicRequestFilter (B1, B4, B6, S10)', () => {
  it('lets a plain Claude Code request through, unchanged', () => {
    const { r } = run(msg());
    expect('body' in r && strictStringify(r.body)).toBe(strictStringify(parse(msg())));
  });

  it.each([
    ['an unknown top-level key', { foo: 1 }],
    ['mcp_servers (never)', { mcp_servers: [] }],
    ['container (never)', { container: 'x' }],
    ['an unknown block type', { messages: [{ role: 'user', content: [{ type: 'video', data: 'x' }] }] }],
    [
      'an unknown block field',
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'x', extra: 1 }] }] },
    ],
    [
      'a url source (never)',
      {
        messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'http://x' } }] }],
      },
    ],
    [
      'a file source (never)',
      {
        messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'file', file_id: 'f' } }] }],
      },
    ],
    ['an mcp block (never)', { messages: [{ role: 'user', content: [{ type: 'mcp_tool_use', id: 'x' }] }] }],
    [
      'a code execution result (never)',
      { messages: [{ role: 'user', content: [{ type: 'code_execution_tool_result', tool_use_id: 'x' }] }] },
    ],
    ['a web_fetch tool (never)', { tools: [{ type: 'web_fetch_20250910', name: 'web_fetch' }] }],
    ['a code_execution tool (never)', { tools: [{ type: 'code_execution_20250825', name: 'c' }] }],
    ['an mcp_toolset tool (never)', { tools: [{ type: 'mcp_toolset', mcp_server_name: 'x' }] }],
    ['an unknown tool type', { tools: [{ type: 'weird_20250101', name: 'w' }] }],
    ['a $ref URL in a schema', { tools: [{ name: 't', input_schema: { $ref: 'https://evil/x.json' } }] }],
    [
      'a $ref deep in a schema',
      { tools: [{ name: 't', input_schema: { properties: { a: { $ref: 'http://x' } } } }] },
    ],
    ['an unknown message role', { messages: [{ role: 'tool', content: 'x' }] }],
    ['an image in a system message', { messages: [{ role: 'system', content: [{ type: 'image' }] }] }],
    [
      'a document inside a tool_result',
      {
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'x',
                content: [
                  { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'x' } },
                ],
              },
            ],
          },
        ],
      },
    ],
    [
      'an unknown context-management edit (S10)',
      { context_management: { edits: [{ type: 'clear_everything' }] } },
    ],
    [
      'an unknown field in a listed edit (S10)',
      { context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all', extra: 1 }] } },
    ],
    [
      'a message-level field',
      { messages: [{ role: 'user', content: 'x', output_config: { effort: 'max' } }] },
    ],
    ['a thinking display field', { thinking: { type: 'adaptive', display: 'updates' } }],
  ])('refuses %s', (_why, extra) => {
    const { r, events } = run(msg(extra));
    expect('refuse' in r).toBe(true);
    expect(events[0]?.refused).toBeTruthy();
  });

  it('lists the context-management edits Claude Code sends (S10), with their fields', () => {
    const ok = run(
      msg({
        context_management: {
          edits: [
            { type: 'clear_thinking_20251015', keep: { type: 'thinking_turns', value: 1 } },
            {
              type: 'clear_tool_uses_20250919',
              trigger: { type: 'input_tokens', value: 100000 },
              keep: { type: 'tool_uses', value: 3 },
              clear_at_least: { type: 'input_tokens', value: 5000 },
              exclude_tools: ['Read'],
              clear_tool_inputs: false,
            },
          ],
        },
      }),
    ).r;
    expect('body' in ok).toBe(true);
    expect(Object.keys(LISTS.contextEdits).sort()).toEqual([
      'clear_thinking_20251015',
      'clear_tool_uses_20250919',
    ]);
  });

  it("web search is refused for 'none' and allowed for 'web_search' (tool, blocks, citations, beta)", () => {
    const tool = { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }] };
    const blocks = {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'q' } },
            { type: 'web_search_tool_result', tool_use_id: 's1', content: [] },
            { type: 'text', text: 'x', citations: [{ type: 'web_search_result_location', url: 'u' }] },
          ],
        },
      ],
    };
    expect('refuse' in run(msg(tool)).r).toBe(true);
    expect('refuse' in run(msg(blocks)).r).toBe(true);
    expect('body' in run(msg(tool), { serverTools: 'web_search' }).r).toBe(true);
    expect('body' in run(msg(blocks), { serverTools: 'web_search' }).r).toBe(true);
    const beta = H({ 'anthropic-beta': 'web-search-2025-03-05' });
    const none = run(msg(), { headers: beta }).r;
    expect('body' in none && none.headers['anthropic-beta']).toBeUndefined();
    const web = run(msg(), { headers: beta, serverTools: 'web_search' }).r;
    expect('body' in web && web.headers['anthropic-beta']).toBe('web-search-2025-03-05');
  });

  it('a beta split across two headers and commas is filtered; an unknown beta is stripped; a never beta refuses', () => {
    const { r, events } = run(msg(), {
      headers: H({
        'anthropic-beta': [
          'claude-code-20250219, made-up-2030-01-01',
          'effort-2025-11-24,,claude-code-20250219',
        ],
      }),
    });
    expect('body' in r && r.headers['anthropic-beta']).toBe('claude-code-20250219,effort-2025-11-24');
    expect(events[0]?.betas).toEqual({
      confirmed: ['claude-code-20250219', 'effort-2025-11-24'],
      stripped: ['made-up-2030-01-01'],
    });
    for (const b of [
      'mcp-client-2025-11-20',
      'advanced-tool-use-2025-11-20',
      'files-api-2025-04-14',
      'code-execution-2025-08-25',
    ])
      expect(
        'refuse' in run(msg(), { headers: H({ 'anthropic-beta': `claude-code-20250219,${b}` }) }).r,
        b,
      ).toBe(true);
  });

  it('S9: only allowlisted headers go upstream; an unknown header, a client credential and a bad version are dropped', () => {
    const { r, events } = run(msg(), {
      headers: H({
        'x-evil': '1',
        authorization: 'Bearer sk-box',
        'x-api-key': 'sk-box',
        'anthropic-version': 'x',
        'user-agent': 'claude-cli/2.1.332',
        'x-stainless-os': 'Linux',
        'x-app': 'cli',
        accept: 'application/json',
        'x-stainless-long': 'a'.repeat(300),
        cookie: 'c=1',
      }),
    });
    expect('body' in r).toBe(true);
    if (!('body' in r)) return;
    expect(Object.keys(r.headers).sort()).toEqual([
      'accept',
      'content-type',
      'user-agent',
      'x-app',
      'x-stainless-os',
    ]);
    expect(events[0]?.headers.dropped.sort()).toEqual(
      ['anthropic-version', 'authorization', 'cookie', 'x-api-key', 'x-evil', 'x-stainless-long'].sort(),
    );
  });

  it('B6: no allowlist entry matches the never-list; a listed-then-never value is still refused', () => {
    expect(listsAgainstNever()).toEqual([]);
    const evil: FilterLists = {
      ...LISTS,
      topKeys: [...LISTS.topKeys, 'mcp_servers'],
      blocks: { ...LISTS.blocks, mcp_tool_use: ['id'] },
      betas: [...LISTS.betas, 'mcp-client-2025-04-04'],
    };
    expect(listsAgainstNever(evil).sort()).toEqual([
      'beta mcp-client-2025-04-04',
      'block mcp_tool_use',
      'key mcp_servers',
    ]);
    expect('refuse' in run(msg({ mcp_servers: [] }), { testLists: evil }).r).toBe(true);
    expect(
      'refuse' in
        run(msg({ messages: [{ role: 'user', content: [{ type: 'mcp_tool_use', id: 'x' }] }] }), {
          testLists: evil,
        }).r,
    ).toBe(true);
    expect(
      'refuse' in
        run(msg(), { testLists: evil, headers: H({ 'anthropic-beta': 'mcp-client-2025-04-04' }) }).r,
    ).toBe(true);
    expect(NEVER.toolType('mcp_toolset')).toBe(true);
  });

  it('B6: the capture hook reports and the request is still refused; without the hook nothing is captured', () => {
    const { r, events } = run(msg({ mcp_servers: [] }));
    expect('refuse' in r).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]?.refused).toMatch(/mcp_servers/);
    const plain = anthropicRequestFilter({ serverTools: 'none' });
    expect('refuse' in plain(parse(msg({ mcp_servers: [] })), H())).toBe(true);
  });

  it('the nit: an integer above 2^53 in tool_use.input is forwarded with that literal unchanged', () => {
    const raw =
      '{"model":"m","messages":[{"role":"assistant","content":[{"type":"tool_use","id":"t","name":"X","input":{"n":12345678901234567890}}]}]}';
    const { r } = run(raw);
    expect('body' in r && strictStringify(r.body)).toContain('"n":12345678901234567890');
  });
});

// ---------------------------------------------------------------- the proxy

interface Seen {
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

async function upstream(
  reply: (req: Seen, res: import('node:http').ServerResponse) => void = (_q, s) => {
    s.writeHead(200, { 'content-type': 'application/json' });
    s.end(
      '{"type":"message","id":"m1","model":"x","content":[],"usage":{"input_tokens":3,"output_tokens":4}}',
    );
  },
): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const s = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const x = { url: req.url ?? '', headers: req.headers, body: b };
      seen.push(x);
      reply(x, res);
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, seen };
}

async function proxyFor(up: string, plan: ReturnType<typeof modelProxyPlan>, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aom-mr-'));
  const socketPath = join(dir, 'p.sock');
  const port = Number(new URL(up).port);
  const proxy = await startEgressProxy({
    socketPath,
    allowedHosts: [],
    routeHosts: ['127.0.0.1'],
    routes: [plan.route],
    allowPrivate: true,
    allowedPorts: [port, 443],
    refuseHost: isModelApiHost,
    ...extra,
  });
  const call = (
    path: string,
    body: string | Buffer,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; text: string; headers: IncomingHttpHeaders }> =>
    new Promise((resolve) => {
      const req = httpRequest(
        {
          socketPath,
          path,
          method: 'POST',
          headers: { 'x-api-key': plan.bearer, 'content-type': 'application/json', ...headers },
        },
        (res) => {
          let t = '';
          res.on('data', (c) => (t += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text: t, headers: res.headers }));
        },
      );
      req.on('error', () => resolve({ status: -1, text: 'socket error', headers: {} }));
      req.end(body);
    });
  return { proxy, call, socketPath };
}

const R = `${MODEL_ROUTE}/v1/messages`;

describe('the filtered model route in the egress proxy (B4, S8, S9, S5)', () => {
  it('forwards exactly strictStringify(checked) with a fresh content-length and only the allowlisted headers plus the route key', async () => {
    const up = await upstream();
    const plan = modelProxyPlan({ kind: 'api_key', apiKey: 'sk-ant-REAL' }, up.url);
    const { proxy, call } = await proxyFor(up.url, plan);
    const body = `{ "model" : "m",   "max_tokens": 10, "messages": [ {"role":"user","content":"hi"} ] }`;
    const r = await call(`${R}?beta=true`, body, {
      'x-evil': 'yes',
      'anthropic-version': '2023-06-01',
      'accept-encoding': 'gzip',
    });
    expect(r.status).toBe(200);
    expect(up.seen).toHaveLength(1);
    const s = up.seen[0] as Seen;
    expect(s.url).toBe('/v1/messages?beta=true');
    expect(s.body).toBe(strictStringify(parse(body)));
    expect(s.headers['content-length']).toBe(String(Buffer.byteLength(s.body)));
    expect(s.headers['x-api-key']).toBe('sk-ant-REAL');
    expect(s.headers['x-evil']).toBeUndefined();
    expect(s.headers['accept-encoding']).toBe('identity');
    expect(JSON.stringify(s.headers)).not.toContain(plan.bearer);
    await proxy.close();
  });

  it('OAuth: the required beta is added after the filter (S6)', async () => {
    const up = await upstream();
    const plan = modelProxyPlan({ kind: 'oauth_token', token: 'tok' }, up.url);
    const { proxy, call } = await proxyFor(up.url, plan);
    const r = await call(R, '{"model":"m"}', {
      authorization: `Bearer ${plan.bearer}`,
      'anthropic-beta': 'claude-code-20250219,unknown-x',
    });
    expect(r.status).toBe(200);
    expect(up.seen[0]?.headers['anthropic-beta']).toBe('claude-code-20250219,oauth-2025-04-20');
    expect(up.seen[0]?.headers.authorization).toBe('Bearer tok');
    await proxy.close();
  });

  it('review S1: an API-key route strips a client oauth beta; an OAuth route sends it exactly once', async () => {
    const up = await upstream();
    const key = modelProxyPlan({ kind: 'api_key', apiKey: 'sk-ant-REAL' }, up.url);
    const a = await proxyFor(up.url, key);
    expect(
      (await a.call(R, '{"model":"m"}', { 'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20' }))
        .status,
    ).toBe(200);
    expect(up.seen[0]?.headers['anthropic-beta']).toBe('claude-code-20250219');
    await a.proxy.close();
    const oauth = modelProxyPlan({ kind: 'oauth_token', token: 'tok' }, up.url);
    const o = await proxyFor(up.url, oauth);
    expect(
      (
        await o.call(R, '{"model":"m"}', {
          authorization: `Bearer ${oauth.bearer}`,
          'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219',
        })
      ).status,
    ).toBe(200);
    expect(up.seen[1]?.headers['anthropic-beta']).toBe('claude-code-20250219,oauth-2025-04-20');
    expect(LISTS.betas).not.toContain('oauth-2025-04-20');
    await o.proxy.close();
  });

  it('review S2: one route cannot take the whole buffer; another route still gets through', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const up = await upstream((_q, s) => {
      void gate.then(() => {
        s.writeHead(200, { 'content-type': 'application/json' });
        s.end('{}');
      });
    });
    const planA = modelProxyPlan({ kind: 'api_key', apiKey: 'k' }, up.url);
    const planB = modelProxyPlan({ kind: 'api_key', apiKey: 'k' }, up.url);
    const a = await proxyFor(up.url, planA);
    const b = await proxyFor(up.url, planB);
    const body = '{"model":"a-model-name-of-some-length-xxxxxxxx"}';
    setPerRouteBufferCapForTests(body.length + 10);
    try {
      const held = a.call(R, body);
      await new Promise((r) => setTimeout(r, 200));
      // route A already holds one body: a second one is over its own share
      expect((await a.call(R, body)).status).toBe(503);
      // route B (another box) is not affected
      const other = b.call(R, body);
      await new Promise((r) => setTimeout(r, 200));
      release();
      expect((await held).status).toBe(200);
      expect((await other).status).toBe(200);
      // released at the response end: route A gets through again
      expect((await a.call(R, body)).status).toBe(200);
    } finally {
      setPerRouteBufferCapForTests();
      release();
    }
    expect(MODEL_ROUTE_MAX_BUFFERED_BYTES).toBe(48 * 1024 * 1024);
    await a.proxy.close();
    await b.proxy.close();
  });

  it('400 on another query, 415 on an encoding or another type, 413 with connection: close, 400 on bad JSON, 403 on a refusal', async () => {
    const up = await upstream();
    const plan = modelProxyPlan({ kind: 'api_key', apiKey: 'k' }, up.url);
    plan.route.maxRequestBytes = 1000;
    const { proxy, call } = await proxyFor(up.url, plan);
    expect((await call(`${R}?x=1`, '{}')).status).toBe(400);
    expect((await call(`${R}?beta=true&x=1`, '{}')).status).toBe(400);
    expect((await call(R, '{}', { 'content-encoding': 'gzip' })).status).toBe(415);
    expect((await call(R, '{}', { 'content-type': 'text/plain' })).status).toBe(415);
    const big = await call(R, `{"model":"${'x'.repeat(2000)}"}`);
    expect(big.status).toBe(413);
    expect(big.headers.connection).toBe('close');
    expect((await call(R, '{"tools":[],"tools":[]}')).status).toBe(400);
    expect((await call(R, '{"a":1e400}')).status).toBe(400);
    const refused = await call(R, '{"model":"m","mcp_servers":[{"type":"url","url":"https://evil"}]}');
    expect(refused.status).toBe(403);
    expect(refused.text).toMatch(/mcp_servers/);
    expect(up.seen).toHaveLength(0);
    await proxy.close();
  });

  it('count_tokens with mcp_servers gets 403 too', async () => {
    const up = await upstream();
    const plan = modelProxyPlan({ kind: 'api_key', apiKey: 'k' }, up.url);
    const { proxy, call } = await proxyFor(up.url, plan);
    expect((await call(`${R}/count_tokens`, '{"model":"m","mcp_servers":[]}')).status).toBe(403);
    expect(up.seen).toHaveLength(0);
    await proxy.close();
  });

  it('a filter exception gives 400 and the proxy keeps serving', async () => {
    const up = await upstream();
    const plan = modelProxyPlan({ kind: 'api_key', apiKey: 'k' }, up.url);
    plan.route.requestFilter = () => {
      throw new Error('boom');
    };
    const { proxy, call } = await proxyFor(up.url, plan);
    expect((await call(R, '{}')).status).toBe(400);
    expect((await call(R, '{}')).status).toBe(400);
    await proxy.close();
  });

  it('503 at the in-flight cap and at the runner-wide byte cap', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const up = await upstream((_q, s) => {
      void gate.then(() => {
        s.writeHead(200, { 'content-type': 'application/json' });
        s.end('{}');
      });
    });
    const plan = modelProxyPlan({ kind: 'api_key', apiKey: 'k' }, up.url);
    const { proxy, call } = await proxyFor(up.url, plan);
    const held = Array.from({ length: MODEL_ROUTE_MAX_IN_FLIGHT }, () => call(R, '{"model":"m"}'));
    await new Promise((r) => setTimeout(r, 200));
    expect((await call(R, '{"model":"m"}')).status).toBe(503);
    release();
    expect((await Promise.all(held)).map((x) => x.status)).toEqual(
      Array(MODEL_ROUTE_MAX_IN_FLIGHT).fill(200),
    );
    // the slots are released
    expect((await call(R, '{"model":"m"}')).status).toBe(200);
    setFilteredRouteBufferCapForTests(10);
    try {
      expect((await call(R, '{"model":"a-longer-model-name"}')).status).toBe(503);
    } finally {
      setFilteredRouteBufferCapForTests();
    }
    expect((await call(R, '{"model":"m"}')).status).toBe(200);
    await proxy.close();
  });

  it('S5: a CONNECT or plain request to a model host is refused even when allow-listed', async () => {
    const up = await upstream();
    const plan = modelProxyPlan({ kind: 'api_key', apiKey: 'k' }, up.url);
    const { proxy, socketPath } = await proxyFor(up.url, plan, {
      allowedHosts: ['api.anthropic.com', '*.openai.com', 'registry.npmjs.org'],
    });
    const connect = (target: string) =>
      new Promise<number>((resolve) => {
        const req = httpRequest({ socketPath, method: 'CONNECT', path: target });
        req.on('connect', (res, sock) => {
          sock.destroy();
          resolve(res.statusCode ?? 0);
        });
        req.on('response', (res) => resolve(res.statusCode ?? 0));
        req.on('error', () => resolve(-1));
        req.end();
      });
    expect(await connect('api.anthropic.com:443')).toBe(403);
    expect(await connect('api.openai.com:443')).toBe(403);
    const plain = await new Promise<number>((resolve) => {
      const req = httpRequest({ socketPath, method: 'GET', path: 'http://claude.ai/x' }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.end();
    });
    expect(plain).toBe(403);
    expect(proxy.denied()).toEqual(
      expect.arrayContaining(['api.anthropic.com', 'api.openai.com', 'claude.ai']),
    );
    await proxy.close();
  });

  it('isModelApiHost covers the model services, their subdomains and wildcard entries, and nothing else', () => {
    for (const h of [
      'api.anthropic.com',
      'anthropic.com',
      '*.anthropic.com',
      'claude.ai',
      'console.claude.com',
      'api.openai.com',
      'generativelanguage.googleapis.com',
      'us-central1-aiplatform.googleapis.com'.replace('us-central1-', ''),
      'bedrock-runtime.us-east-1.amazonaws.com',
      'openrouter.ai',
    ])
      expect(isModelApiHost(h), h).toBe(true);
    for (const h of ['registry.npmjs.org', 'github.com', 'storage.googleapis.com', 'notanthropic.com'])
      expect(isModelApiHost(h), h).toBe(false);
  });
});

// ---------------------------------------------------------------- the ledger

const sse = (e: Record<string, unknown>) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`;

function bashStream(id: string, command: string, usage = { input_tokens: 10, output_tokens: 1 }): string {
  const input = JSON.stringify({ command });
  return [
    sse({ type: 'message_start', message: { id: `msg_${id}`, model: 'claude-opus-5-5', usage } }),
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'authentication_error usage limit rate_limit_error' },
    }),
    sse({ type: 'content_block_stop', index: 0 }),
    sse({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id, name: 'Bash', input: {} },
    }),
    sse({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: input.slice(0, 7) },
    }),
    sse({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: input.slice(7) },
    }),
    sse({ type: 'content_block_stop', index: 1 }),
    sse({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 25 } }),
    sse({ type: 'message_stop' }),
  ].join('');
}

function feed(l: ModelLedger, status: number, headers: IncomingHttpHeaders, text: string, chunk = 17): void {
  const sink = l.observer().response?.(status, headers);
  if (!sink) return;
  const b = Buffer.from(text);
  for (let i = 0; i < b.length; i += chunk) sink.write(b.subarray(i, i + chunk));
  sink.end();
}

describe('ModelLedger (B2, S6, S7)', () => {
  const now = new Date('2026-11-26T20:00:00.000Z');

  it('usage and a Bash tool_use come from the SSE deltas; the text of a 200 sets no auth or limit state', () => {
    const entries: unknown[] = [];
    const l = new ModelLedger({
      audit: (e) => entries.push(...e),
      sessionRef: 'shift-1',
      shiftKind: 'devops',
      now: () => now,
    });
    feed(
      l,
      200,
      { 'content-type': 'text/event-stream' },
      bashStream('toolu_A', 'echo box-bash-ok > bash.txt'),
    );
    feed(
      l,
      200,
      { 'content-type': 'text/event-stream' },
      bashStream('toolu_B', 'ls', { input_tokens: 5, output_tokens: 1 }),
      3,
    );
    expect(l.usage()).toEqual({
      inputTokens: 15,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      model: 'claude-opus-5-5',
    });
    expect(l.authFailed).toBe(false);
    expect(l.usageLimit()).toBeUndefined();
    expect(entries).toEqual([
      {
        at: now.toISOString(),
        sessionRef: 'shift-1',
        kind: 'shift',
        shiftKind: 'devops',
        decision: 'allowed',
        rule: 'proxy:requested toolu_A',
        command: 'echo box-bash-ok > bash.txt',
      },
      expect.objectContaining({ rule: 'proxy:requested toolu_B', command: 'ls' }),
    ]);
  });

  it('result-seen follows a later request that carries the tool_result (once); an unknown id adds nothing', () => {
    const entries: Array<{ rule: string }> = [];
    const l = new ModelLedger({ audit: (e) => entries.push(...e), sessionRef: 's' });
    feed(l, 200, { 'content-type': 'text/event-stream' }, bashStream('toolu_A', 'echo hi'));
    const req = (id: string) =>
      parse(
        JSON.stringify({
          messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }],
        }),
      );
    l.observer().request?.(req('toolu_A'), '/v1/messages');
    l.observer().request?.(req('toolu_A'), '/v1/messages');
    l.observer().request?.(req('toolu_X'), '/v1/messages');
    expect(entries.map((e) => e.rule)).toEqual(['proxy:requested toolu_A', 'proxy:result-seen toolu_A']);
  });

  it('401 sets authFailed, 429 sets usageLimit from retry-after or the reset headers (default 5 minutes)', () => {
    const a = new ModelLedger({ now: () => now });
    feed(a, 401, {}, '{"type":"error"}');
    expect(a.authFailed).toBe(true);
    const b = new ModelLedger({ now: () => now });
    feed(b, 429, { 'retry-after': '120' }, '');
    expect(b.usageLimit()).toEqual({ until: new Date(now.getTime() + 120_000), parsed: true });
    expect(
      limitResetOf({ 'anthropic-ratelimit-tokens-reset': '2026-11-26T21:00:00Z' }, now).until.toISOString(),
    ).toBe('2026-11-26T21:00:00.000Z');
    expect(limitResetOf({}, now)).toEqual({ until: new Date(now.getTime() + 300_000), parsed: false });
  });

  it('a JSON body is read the same way; an oversized tool input is recorded as [too long]; garbage never throws', () => {
    const entries: Array<{ rule: string; command: string }> = [];
    const l = new ModelLedger({ audit: (e) => entries.push(...e), sessionRef: 's' });
    feed(
      l,
      200,
      { 'content-type': 'application/json' },
      JSON.stringify({
        type: 'message',
        id: 'm9',
        model: 'x',
        content: [{ type: 'tool_use', id: 'toolu_J', name: 'Bash', input: { command: 'whoami' } }],
        usage: { input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 3 },
      }),
    );
    const huge = 'x'.repeat(1024 * 1024 + 10);
    feed(l, 200, { 'content-type': 'text/event-stream' }, bashStream('toolu_H', huge), 65536);
    feed(l, 200, { 'content-type': 'text/event-stream' }, 'data: {not json\n\nevent: x\ndata: [\n\n');
    expect(entries.map((e) => [e.rule, e.command.slice(0, 20)])).toEqual([
      ['proxy:requested toolu_J', 'whoami'],
      ['proxy:requested toolu_H', '[too long]'],
    ]);
    expect(l.usage().cacheReadTokens).toBe(3);
  });

  it('end to end through the proxy: the ledger sees the real response and the box gets it unchanged', async () => {
    const stream = bashStream('toolu_E', 'echo e2e');
    const up = await upstream((_q, s) => {
      s.writeHead(200, { 'content-type': 'text/event-stream' });
      s.end(stream);
    });
    const entries: Array<{ rule: string }> = [];
    const l = new ModelLedger({ audit: (e) => entries.push(...e), sessionRef: 's' });
    const plan = modelProxyPlan({ kind: 'api_key', apiKey: 'k' }, up.url, { observe: l.observer() });
    const { proxy, call } = await proxyFor(up.url, plan);
    const r = await call(R, '{"model":"m","stream":true}');
    expect(r.text).toBe(stream);
    expect(entries.map((e) => e.rule)).toEqual(['proxy:requested toolu_E']);
    expect(l.usage().outputTokens).toBe(25);
    await proxy.close();
  });
});
