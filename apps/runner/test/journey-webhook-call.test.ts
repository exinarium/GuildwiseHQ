import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JourneyWebhookCaller, webhookStore } from '../src/outbound-delivery/journey-webhook.ts';
import { redact } from '../src/secrets/redact.ts';

/** `journey.webhook.call` against a local HTTP server that fails twice and then answers 200. */
const KEY = randomBytes(32);
const keyOf = () => KEY;
const SECRET = 'crm-key-SECRETVALUE-91ac';
const SIGN = 'sign-secret-3f2b';
let dir = '';
let server: Server;
let port = 0;
let answers: Array<{ status: number; location?: string }> = [];
let seen: Array<{ headers: IncomingMessage['headers']; body: string; method: string }> = [];
const lines: string[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gw-jwh-'));
  webhookStore(dir, keyOf).save({ credentials: { crm: { value: `Bearer ${SECRET}` }, sign: { value: SIGN } } });
  answers = [];
  seen = [];
  lines.length = 0;
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ headers: req.headers, body, method: req.method ?? '' });
      const a = answers.shift() ?? { status: 200 };
      res.writeHead(a.status, a.location ? { location: a.location } : {});
      res.end('SECRET-RESPONSE-BODY');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

const caller = () => new JourneyWebhookCaller({ secretsDir: dir, keyOf, now: () => 1_800_000_000_000, log: (l) => lines.push(l) });
const payload = (over: Record<string, unknown> = {}) => ({
  callId: '0198f2a0-0000-7000-8000-0000000000aa',
  attempt: 1,
  url: `http://127.0.0.1:${port}/hook`,
  method: 'POST' as const,
  headers: [{ name: 'X-Source', value: 'journeys' }],
  credentialHeaders: [{ name: 'Authorization', credential: 'crm' }],
  signWith: 'sign',
  contentType: 'application/json',
  body: '{"client":"Ann"}',
  ...over,
});

describe('journey.webhook.call', () => {
  it('sends the body with the plain headers, the credential header from the sealed store and the signature', async () => {
    const r = await caller().run(payload());
    expect(r).toEqual({ ok: true, httpStatus: 200, retryable: false });
    const s = seen[0]!;
    expect(s.method).toBe('POST');
    expect(s.body).toBe('{"client":"Ann"}');
    expect(s.headers['x-source']).toBe('journeys');
    expect(s.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(s.headers['x-guildwise-delivery']).toBe('0198f2a0-0000-7000-8000-0000000000aa');
    expect(s.headers['x-guildwise-signature']).toBe(
      `sha256=${createHmac('sha256', SIGN).update('1800000000.{"client":"Ann"}').digest('hex')}`,
    );
  });

  it('answers retryable for 5xx and 429, final for other 4xx, and the response body is discarded', async () => {
    answers = [{ status: 503 }, { status: 429 }, { status: 404 }];
    const out = [await caller().run(payload()), await caller().run(payload()), await caller().run(payload())];
    expect(out.map((r) => [r.ok, r.httpStatus, r.retryable])).toEqual([
      [false, 503, true],
      [false, 429, true],
      [false, 404, false],
    ]);
    expect(JSON.stringify(out)).not.toContain('SECRET-RESPONSE-BODY');
  });

  it('fails twice and then succeeds on the third try (the server schedules the tries)', async () => {
    answers = [{ status: 500 }, { status: 502 }, { status: 200 }];
    const results = [];
    for (let attempt = 1; attempt <= 3; attempt++) results.push(await caller().run(payload({ attempt })));
    expect(results.map((r) => r.ok)).toEqual([false, false, true]);
    expect(seen).toHaveLength(3);
  });

  it('does not follow a redirect', async () => {
    answers = [{ status: 302, location: `http://127.0.0.1:${port}/elsewhere` }];
    const r = await caller().run(payload());
    expect(r).toMatchObject({ ok: false, httpStatus: 302, retryable: false });
    expect(seen).toHaveLength(1);
  });

  it('an unreachable address is retryable', async () => {
    const r = await caller().run(payload({ url: 'http://127.0.0.1:9/nothing' }));
    expect(r).toMatchObject({ ok: false, retryable: true });
  });

  it('a credential that is not stored is a final failure that names the credential, never its value', async () => {
    const r = await caller().run(payload({ credentialHeaders: [{ name: 'Authorization', credential: 'missing' }] }));
    expect(r).toMatchObject({ ok: false, retryable: false });
    expect(r.error).toContain('missing');
    expect(seen).toHaveLength(0);
  });

  it('a GET carries no body and no content type', async () => {
    await caller().run(payload({ method: 'GET', body: '' }));
    expect(seen[0]!.body).toBe('');
    expect(seen[0]!.headers['content-type']).toBeUndefined();
  });

  it('the log line holds the call id, status and duration, never the URL, a header value or the body', async () => {
    await caller().run(payload());
    const log = lines.join('\n');
    expect(log).toContain('0198f2a0-0000-7000-8000-0000000000aa');
    for (const s of [SECRET, SIGN, '/hook', 'Ann', String(port)]) expect(log).not.toContain(s);
    expect(redact(`x Bearer ${SECRET}`)).not.toContain(SECRET);
  });
});
