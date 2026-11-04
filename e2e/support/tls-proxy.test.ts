import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startTlsProxy } from './tls-proxy.ts';

function listen(h: http.RequestListener): Promise<http.Server> {
  return new Promise((r) => {
    const s = http.createServer(h);
    s.listen(0, '127.0.0.1', () => r(s));
  });
}
const portOf = (s: http.Server) => (s.address() as { port: number }).port;

function get(url: string, ca: Buffer) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    https.get(url, { ca }, (r) => {
      let body = '';
      r.on('data', (d) => (body += d));
      r.on('end', () => resolve({ status: r.statusCode ?? 0, headers: r.headers, body }));
    }).on('error', reject);
  });
}

test('the proxy passes response headers through unchanged and never adds HSTS', async () => {
  const up = await listen((req, res) => {
    if (req.url === '/hsts') res.setHeader('strict-transport-security', 'max-age=31536000');
    res.setHeader('x-custom', 'yes');
    res.end(JSON.stringify({ proto: req.headers['x-forwarded-proto'] }));
  });
  const proxy = await startTlsProxy({ target: `http://127.0.0.1:${portOf(up)}`, port: 0, certDir: mkdtempSync(join(tmpdir(), 'tls-')), unchecked: true });
  try {
    const ca = readFileSync(proxy.caPath);
    const withHsts = await get(`${proxy.url}/hsts`, ca);
    const without = await get(`${proxy.url}/plain`, ca);
    assert.equal(withHsts.headers['strict-transport-security'], 'max-age=31536000');
    assert.equal(without.headers['strict-transport-security'], undefined);
    assert.equal(without.headers['x-custom'], 'yes');
    assert.equal(JSON.parse(without.body).proto, 'https');
  } finally {
    await proxy.close();
    up.close();
  }
});

test('a refused upstream gives 502 naming the target', async () => {
  const proxy = await startTlsProxy({ target: 'http://127.0.0.1:1', port: 0, certDir: mkdtempSync(join(tmpdir(), 'tls-')), unchecked: true });
  try {
    const r = await get(`${proxy.url}/x`, readFileSync(proxy.caPath));
    assert.equal(r.status, 502);
    assert.match(r.body, /http:\/\/127\.0\.0\.1:1/);
  } finally {
    await proxy.close();
  }
});
