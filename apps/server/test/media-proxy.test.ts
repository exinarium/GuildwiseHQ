import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mediaTarget } from '../src/media-proxy.ts';
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
