import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { pipeline, Readable } from 'node:stream';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMediaLimiter, mediaTarget, registerMediaProxy } from '../src/media-proxy.ts';
import { createTestApp, type TestApp } from './helpers/app.ts';
import { closeAdminPool } from './helpers/db.ts';

const BODY = Buffer.alloc(10_000, 7);
let seen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders }> = [];
let fake: http.Server;
let fakeUrl: string;
let withMedia: TestApp;
let withoutMedia: TestApp;
let deadMedia: TestApp;

beforeAll(async () => {
  fake = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    if (req.url?.startsWith('/videos/gone')) {
      res.writeHead(404).end('nope');
      return;
    }
    if (req.url?.startsWith('/videos/broken')) {
      res.writeHead(500).end('boom');
      return;
    }
    if (req.url?.startsWith('/videos/slow-body')) {
      // headers at once, the body trickles: the proxy must already be answering
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(BODY.length) });
      res.write(BODY.subarray(0, 100));
      setTimeout(() => res.end(BODY.subarray(100)), 300);
      return;
    }
    if (req.headers['if-none-match'] === '"v1"') {
      res.writeHead(304, { etag: '"v1"' }).end();
      return;
    }
    const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''));
    const common = {
      'content-type': 'video/mp4',
      'accept-ranges': 'bytes',
      etag: '"v1"',
      'cache-control': 'public, max-age=300',
      'x-secret-internal': 'must-not-leak',
    };
    if (range) {
      const from = Number(range[1]);
      const to = range[2] ? Number(range[2]) : BODY.length - 1;
      res.writeHead(206, {
        ...common,
        'content-range': `bytes ${from}-${to}/${BODY.length}`,
        'content-length': String(to - from + 1),
      });
      res.end(req.method === 'HEAD' ? undefined : BODY.subarray(from, to + 1));
      return;
    }
    res.writeHead(200, { ...common, 'content-length': String(BODY.length) });
    res.end(req.method === 'HEAD' ? undefined : BODY);
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  withMedia = await createTestApp({ env: { AOM_MEDIA_URL: fakeUrl } });
  withoutMedia = await createTestApp({});
  // nothing listens on port 1: connection refused
  deadMedia = await createTestApp({ env: { AOM_MEDIA_URL: 'http://127.0.0.1:1' } });
});
afterAll(async () => {
  await withMedia.close();
  await withoutMedia.close();
  await deadMedia.close();
  await new Promise((r) => fake.close(r));
  await closeAdminPool();
});

describe('mediaTarget', () => {
  it('accepts plain file names under /videos/ only', () => {
    expect(mediaTarget('/videos/desk.mp4')).toBe('/videos/desk.mp4');
    expect(mediaTarget('/videos/manifest.json')).toBe('/videos/manifest.json');
    expect(mediaTarget('/videos/desk.mp4?v=abc123')).toBe('/videos/desk.mp4?v=abc123');
    expect(mediaTarget('/videos/desk.mp4?x=<script>')).toBe('/videos/desk.mp4');
    for (const bad of [
      '/videos/',
      '/videos/../etc/passwd',
      '/videos/..%2f..%2fetc/passwd',
      '/videos/%2e%2e/x',
      '/videos//desk.mp4',
      '/videos/a/b.mp4',
      '/videos/.hidden',
      '/videos\\desk.mp4',
      '/other/desk.mp4',
      '/videos',
      '/videos/a b.mp4',
    ])
      expect(mediaTarget(bad), bad).toBeNull();
  });
});

describe('the /videos proxy', () => {
  it('passes a Range request through and answers 206 with the range headers', async () => {
    seen = [];
    const r = await withMedia.app.inject({
      method: 'GET',
      url: '/videos/desk.mp4',
      headers: { range: 'bytes=100-199', 'if-none-match': '"zzz"', cookie: 'aom_session=secret' },
    });
    expect(r.statusCode).toBe(206);
    expect(r.rawPayload.length).toBe(100);
    expect(r.headers['content-range']).toBe('bytes 100-199/10000');
    expect(r.headers['accept-ranges']).toBe('bytes');
    expect(r.headers['content-type']).toBe('video/mp4');
    expect(r.headers.etag).toBe('"v1"');
    expect(r.headers['cache-control']).toBe('public, max-age=300');
    expect(r.headers['x-secret-internal']).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.range).toBe('bytes=100-199');
    expect(seen[0]?.headers['if-none-match']).toBe('"zzz"');
    // nothing else of the browser request (cookies) reaches the media service
    expect(seen[0]?.headers.cookie).toBeUndefined();
    // the app's security headers still apply
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });

  it('answers a full GET, a conditional GET (304) and a HEAD', async () => {
    const full = await withMedia.app.inject({ method: 'GET', url: '/videos/desk.mp4' });
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-length']).toBe('10000');
    expect(full.rawPayload.equals(BODY)).toBe(true);
    const cond = await withMedia.app.inject({
      method: 'GET',
      url: '/videos/desk.mp4',
      headers: { 'if-none-match': '"v1"' },
    });
    expect(cond.statusCode).toBe(304);
    seen = [];
    const head = await withMedia.app.inject({ method: 'HEAD', url: '/videos/desk.mp4' });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-length']).toBe('10000');
    expect(head.rawPayload.length).toBe(0);
    expect(seen[0]?.method).toBe('HEAD');
  });

  it('forwards the versioned query', async () => {
    seen = [];
    await withMedia.app.inject({ method: 'GET', url: '/videos/desk.mp4?v=abc' });
    expect(seen[0]?.url).toBe('/videos/desk.mp4?v=abc');
  });

  it('streams: the response starts before the upstream body is complete', async () => {
    await withMedia.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (withMedia.app.server.address() as AddressInfo).port;
    const t0 = Date.now();
    const res = await fetch(`http://127.0.0.1:${port}/videos/slow-body.mp4`);
    const headersAt = Date.now() - t0;
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(first.value?.length).toBeGreaterThan(0);
    expect(first.value?.length).toBeLessThan(BODY.length);
    expect(Date.now() - t0).toBeLessThan(250); // first bytes long before the upstream finishes (300 ms)
    expect(headersAt).toBeLessThan(250);
    let total = first.value?.length ?? 0;
    for (;;) {
      const n = await reader.read();
      if (n.done) break;
      total += n.value.length;
    }
    expect(total).toBe(BODY.length);
  });

  it('answers 404 quickly for a file the media service does not have, 503 for an upstream error', async () => {
    expect((await withMedia.app.inject({ method: 'GET', url: '/videos/gone.mp4' })).statusCode).toBe(404);
    const broken = await withMedia.app.inject({ method: 'GET', url: '/videos/broken.mp4' });
    expect(broken.statusCode).toBe(503);
    expect(broken.json().error.code).toBe('media_unavailable');
  });

  it('answers 503 fast when the media service is down', async () => {
    const t0 = Date.now();
    const r = await deadMedia.app.inject({ method: 'GET', url: '/videos/manifest.json' });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('media_unavailable');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(Date.now() - t0).toBeLessThan(2_500);
  });

  it('answers 404 (JSON, not the SPA page) when AOM_MEDIA_URL is unset', async () => {
    const r = await withoutMedia.app.inject({ method: 'GET', url: '/videos/manifest.json' });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('not_found');
  });

  it('refuses traversal and anything outside /videos/', async () => {
    seen = [];
    for (const url of [
      '/videos/..%2f..%2fetc%2fpasswd',
      '/videos/%2e%2e/%2e%2e/etc/passwd',
      '/videos//desk.mp4',
      '/videos/a/b.mp4',
    ]) {
      const r = await withMedia.app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(404);
    }
    expect(seen).toHaveLength(0);
  });

  it('only forwards GET and HEAD', async () => {
    seen = [];
    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      const r = await withMedia.app.inject({
        method,
        url: '/videos/desk.mp4',
        headers: { origin: 'http://aom.test' },
      });
      expect(r.statusCode, method).toBeGreaterThanOrEqual(400);
    }
    expect(seen).toHaveLength(0);
  });
});

describe('the /videos limits per address (security review finding 15)', () => {
  it('limiter: concurrency and a rolling-minute rate, freed on release, forgotten when idle', () => {
    let t = 1_000_000;
    const lim = createMediaLimiter({ maxConcurrentPerIp: 2, ratePerMin: 5 }, () => t);
    const a = lim.take('1.1.1.1');
    const b = lim.take('1.1.1.1');
    expect('release' in a && 'release' in b).toBe(true);
    expect(lim.take('1.1.1.1')).toMatchObject({ refused: 'concurrent' });
    // another address is unaffected
    expect('release' in lim.take('2.2.2.2')).toBe(true);
    if ('release' in a) a.release();
    if ('release' in a) a.release(); // twice is harmless
    const c = lim.take('1.1.1.1');
    expect('release' in c).toBe(true);
    if ('release' in b) b.release();
    if ('release' in c) c.release();
    // 3 so far for 1.1.1.1, two more fit the rate of 5, then it is refused with a retry time
    for (let i = 0; i < 2; i++) {
      const x = lim.take('1.1.1.1');
      if ('release' in x) x.release();
    }
    const over = lim.take('1.1.1.1');
    expect(over).toMatchObject({ refused: 'rate' });
    expect((over as { retryAfterSec: number }).retryAfterSec).toBeGreaterThan(0);
    t += 61_000;
    expect('release' in lim.take('1.1.1.1')).toBe(true);
  });

  it('the route answers 429 with Retry-After past the rate, and recovers for other addresses', async () => {
    const app = await createTestApp({ env: { AOM_MEDIA_URL: fakeUrl, AOM_MEDIA_RATE_PER_MIN: '3' } });
    try {
      for (let i = 0; i < 3; i++)
        expect(
          (await app.app.inject({ method: 'GET', url: '/videos/desk.mp4', remoteAddress: '9.9.9.9' }))
            .statusCode,
        ).toBe(200);
      const over = await app.app.inject({ method: 'GET', url: '/videos/desk.mp4', remoteAddress: '9.9.9.9' });
      expect(over.statusCode).toBe(429);
      expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
      expect(
        (await app.app.inject({ method: 'GET', url: '/videos/desk.mp4', remoteAddress: '8.8.4.4' }))
          .statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('the route refuses a third simultaneous request of one address and frees the slot afterwards', async () => {
    const app = await createTestApp({
      env: { AOM_MEDIA_URL: fakeUrl, AOM_MEDIA_MAX_CONCURRENT_PER_IP: '2' },
    });
    try {
      const get = () =>
        app.app.inject({ method: 'GET', url: '/videos/slow-body.mp4', remoteAddress: '7.7.7.7' });
      const results = await Promise.all([get(), get(), get()]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 429]);
      expect((await get()).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('the /videos body timers (paused videos are not cut)', () => {
  const BIG = 24 * 1024 * 1024;
  const SMALL = 4 * 1024 * 1024;
  // Declared length of the endless body: far more than the kernel can buffer on the way to a client that reads nothing
  const ENDLESS = 1024 * 1024 * 1024;
  const CHUNK = 64 * 1024;
  const IDLE = 300;
  const PAUSE_MAX = 1500;
  const bigByte = (i: number) => i % 251;
  const bigBuf = Buffer.alloc(BIG);
  for (let i = 0; i < BIG; i++) bigBuf[i] = bigByte(i);
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

  // The proxy's watchdog runs on this clock, which only the tests move: how long a stream has been quiet or held is
  // decided by the test, not by how fast a busy machine happens to run the event loop.
  let clock = 1_000_000;
  const advance = (ms: number) => {
    clock += ms;
  };
  // Time is only moved once the stream has settled: nothing more is pulled from the media service (the buffers on the
  // way are full, or the stream is quiet) and the watchdog has had a few ticks to see that. A negative check ("nothing
  // was cut") then also gets the real ticks it needs.
  const TICK = 25;
  let pulled = 0;
  const settle = async () => {
    let last = -1;
    for (let stable = 0; stable < 5; ) {
      await sleep(TICK + 5);
      stable = pulled === last ? stable + 1 : 0;
      last = pulled;
    }
    await sleep(TICK * 3);
  };
  // The cap runs from the first tick that sees the stream held: let one tick see it, then move past the cap.
  const pastCap = async () => {
    await settle();
    advance(PAUSE_MAX + 1);
    await settle();
    advance(PAUSE_MAX + 1);
  };

  let up: http.Server;
  let upUrl: string;
  const upSockets = new Set<import('node:net').Socket>();
  let upReqsOpen = 0;
  let proxy: ReturnType<typeof Fastify>;
  let proxyPort: number;

  beforeAll(async () => {
    up = http.createServer((req, res) => {
      upReqsOpen++;
      res.on('close', () => upReqsOpen--);
      if (req.url?.startsWith('/videos/stall')) {
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '1000000' });
        res.write(Buffer.alloc(100, 1)); // then silence
        return;
      }
      if (req.url?.startsWith('/videos/endless')) {
        // generated on demand, so no buffer on the way (kernel included) can ever hold all of it
        let offset = 0;
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(ENDLESS) });
        pipeline(
          new Readable({
            read() {
              const chunk = Buffer.alloc(CHUNK);
              for (let i = 0; i < CHUNK; i++) chunk[i] = bigByte(offset + i);
              offset += CHUNK;
              pulled += CHUNK;
              this.push(chunk);
            },
          }),
          res,
          () => undefined,
        );
        return;
      }
      if (req.url?.startsWith('/videos/small')) {
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(SMALL) });
        res.end(Buffer.alloc(SMALL, 3));
        return;
      }
      const m = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''));
      const from = m ? Number(m[1]) : 0;
      const body = bigBuf.subarray(from);
      res.writeHead(m ? 206 : 200, {
        'content-type': 'video/mp4',
        'content-length': String(body.length),
        ...(m ? { 'content-range': `bytes ${from}-${BIG - 1}/${BIG}` } : {}),
      });
      Readable.from([body], { objectMode: false }).pipe(res);
    });
    up.keepAliveTimeout = 50; // idle pooled sockets from the proxy's agent go away quickly
    up.on('connection', (sock) => {
      upSockets.add(sock);
      sock.on('close', () => upSockets.delete(sock));
    });
    await new Promise<void>((r) => up.listen(0, '127.0.0.1', r));
    upUrl = `http://127.0.0.1:${(up.address() as AddressInfo).port}`;
    proxy = Fastify({ logger: false });
    registerMediaProxy(
      proxy,
      upUrl,
      { maxConcurrentPerIp: 1, ratePerMin: 0 },
      { idleMs: IDLE, pauseMaxMs: PAUSE_MAX, tickMs: TICK, now: () => clock },
    );
    await proxy.listen({ port: 0, host: '127.0.0.1' });
    proxyPort = (proxy.server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await proxy.close();
    up.closeAllConnections();
    await new Promise((r) => up.close(r));
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** The response, already paused: a client that reads ahead before the test pauses it would let the kernel swallow more. */
  const open = (path: string, headers: http.OutgoingHttpHeaders = {}) =>
    new Promise<http.IncomingMessage>((resolve, reject) => {
      const agent = new http.Agent({ keepAlive: false });
      http
        .get({ host: '127.0.0.1', port: proxyPort, path, headers, agent }, (res) => {
          res.pause();
          resolve(res);
        })
        .on('error', reject);
    });
  const status = (path: string) =>
    new Promise<number>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: proxyPort, path, agent: false }, (r) => {
          r.resume();
          r.on('close', () => resolve(r.statusCode ?? 0));
        })
        .on('error', reject);
    });
  const untilClosed = (r: http.IncomingMessage) =>
    new Promise<{ complete: boolean }>((resolve) => {
      r.on('error', () => undefined);
      // the socket closes when the proxy cuts the stream, even while the paused client still holds unread bytes
      r.socket.on('close', () => resolve({ complete: r.complete }));
    });
  const collect = (r: http.IncomingMessage) =>
    new Promise<Buffer>((resolve) => {
      const parts: Buffer[] = [];
      r.on('data', (c: Buffer) => parts.push(c));
      r.on('error', () => undefined);
      r.on('close', () => resolve(Buffer.concat(parts)));
    });
  const waitFor = async (cond: () => boolean, ms = 10_000) => {
    const t = Date.now();
    while (!cond() && Date.now() - t < ms) await sleep(20);
    expect(cond()).toBe(true);
  };

  it('cuts a body when the media service itself goes silent for longer than the idle time', async () => {
    const r = await open('/videos/stall.mp4');
    expect(r.statusCode).toBe(200);
    const end = untilClosed(r);
    r.resume();
    // quiet, but not yet for the idle time: still open
    advance(IDLE - 50);
    await settle();
    expect(r.socket.destroyed).toBe(false);
    advance(100);
    expect((await end).complete).toBe(false);
    await waitFor(() => upReqsOpen === 0);
    expect(await status('/videos/big.mp4?x=1')).toBe(200); // slot was freed
  });

  it('does not cut a client that stopped reading before the pause cap, and closes it (slot freed) after', async () => {
    const r = await open('/videos/endless.mp4');
    expect(r.statusCode).toBe(200);
    await settle(); // the proxy notices the client is not reading
    advance(IDLE * 3); // well past idle, before the cap
    await settle();
    expect(upReqsOpen).toBe(1); // still being served
    expect(await status('/videos/big.mp4')).toBe(429); // slot still held
    await pastCap();
    // (a paused client only sees the close once it reads again, so watch the proxy side)
    await waitFor(() => upReqsOpen === 0);
    expect(await status('/videos/big.mp4')).toBe(200); // slot freed
    const end = untilClosed(r);
    r.resume();
    expect((await end).complete).toBe(false); // truncated: the browser re-requests a Range
    await waitFor(() => upSockets.size === 0);
  });

  it('closes a small body that the client never reads once the pause cap is over', async () => {
    const r = await open('/videos/small.mp4');
    expect(r.statusCode).toBe(200);
    await settle();
    advance(IDLE * 2);
    await settle();
    // How much a paused client's socket swallows is up to the kernel (autotuned buffers): if it took all 4 MB the
    // response is over by itself and the slot is free. Only while the proxy still holds the body is it held.
    if (upReqsOpen > 0) expect(await status('/videos/big.mp4')).toBe(429); // slot still held
    await pastCap();
    let freed = false;
    for (let i = 0; i < 100 && !freed; i++) {
      freed = (await status('/videos/small.mp4?p=1')) === 200;
      if (!freed) await sleep(50);
    }
    expect(freed).toBe(true);
    r.destroy();
  });

  it('a slow but steady reader is not cut even when the total time is over the pause cap', async () => {
    const r = await open('/videos/endless.mp4');
    expect(r.statusCode).toBe(200);
    const parts: Buffer[] = [];
    let closed = false;
    r.on('error', () => undefined);
    r.on('close', () => {
      closed = true;
    });
    r.on('data', (c: Buffer) => parts.push(c));
    const got = () => parts.reduce((n, c) => n + c.length, 0);
    // the total (simulated) time reaches more than twice the cap, but no single pause comes near it
    for (let n = 0; n < 7; n++) {
      const before = got();
      r.resume();
      await waitFor(() => got() > before + 1024 * 1024);
      r.pause();
      await settle(); // the watchdog sees the bytes that went out, then the pause
      advance(PAUSE_MAX / 3);
      await settle();
      expect(closed, `cut in round ${n}`).toBe(false);
    }
    const body = Buffer.concat(parts);
    expect(body.length).toBeGreaterThan(7 * 1024 * 1024);
    // every byte is the one the media service sent
    const expected = Buffer.alloc(251 * 1000);
    for (let i = 0; i < expected.length; i++) expected[i] = bigByte(i);
    expect(sha(body.subarray(0, expected.length))).toBe(sha(expected));
    r.destroy();
    await waitFor(() => upReqsOpen === 0);
  }, 20_000);

  it('a client that resumes after more than the idle time gets the rest of the body intact', async () => {
    const r = await open('/videos/big.mp4');
    await settle(); // backpressure is on
    advance(IDLE * 3);
    await settle();
    const got = collect(r);
    r.resume();
    const body = await got;
    expect(r.complete).toBe(true);
    expect(body.length).toBe(BIG);
    expect(sha(body)).toBe(sha(bigBuf));
    await waitFor(() => upReqsOpen === 0);
  });

  it('a Range 206 survives a pause longer than the idle time', async () => {
    const from = 5_000_000;
    const r = await open('/videos/big.mp4', { range: `bytes=${from}-` });
    expect(r.statusCode).toBe(206);
    await settle();
    advance(IDLE * 3);
    await settle();
    const got = collect(r);
    r.resume();
    const body = await got;
    expect(r.complete).toBe(true);
    expect(sha(body)).toBe(sha(bigBuf.subarray(from)));
    await waitFor(() => upReqsOpen === 0);
  });

  it('leaks nothing: every upstream connection and request is gone once the streams are over', async () => {
    const r = await open('/videos/big.mp4');
    const all = collect(r);
    r.resume();
    await all;
    const s = await open('/videos/stall.mp4');
    const end = untilClosed(s);
    s.resume();
    advance(IDLE + 100);
    await end;
    await waitFor(() => upReqsOpen === 0);
    await waitFor(() => upSockets.size === 0);
  });
});
