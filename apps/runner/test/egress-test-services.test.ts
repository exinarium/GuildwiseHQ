import { mkdtempSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  canonicalTestServices,
  type EgressProxyOptions,
  startEgressProxy,
  testServiceListed,
} from '../src/sandbox/egress-proxy.ts';

const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

/** A small HTTP server on a loopback address; answers `UP <path>`. */
function upstream(host = '127.0.0.1'): Promise<number> {
  const s = createServer((req, res) => res.end(`UP ${req.url}`));
  servers.push(s);
  return new Promise((r) => s.listen(0, host, () => r((s.address() as { port: number }).port)));
}

const sock = () => join(mkdtempSync(join(tmpdir(), 'aom-ts-')), 'p.sock');

const get = (socketPath: string, path: string): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: 'GET', headers: { host: 'x' } }, (res) => {
      let body = '';
      res.on('data', (d) => {
        body += d;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });

/** CONNECT through the proxy; on 200 sends one HTTP request through the tunnel and returns what came back. */
const connect =(socketPath: string, target: string): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const req = request({ socketPath, path: target, method: 'CONNECT', headers: { host: target } });
    req.on('connect', (res, socket) => {
      const status = res.statusCode ?? 0;
      if (status !== 200) {
        socket.destroy();
        return resolve({ status, body: '' });
      }
      let body = '';
      socket.on('data', (d) => {
        body += d;
      });
      socket.on('end', () => resolve({ status, body }));
      socket.on('error', reject);
      socket.write(`GET /through HTTP/1.1\r\nHost: ${target}\r\nConnection: close\r\n\r\n`);
    });
    req.on('error', reject);
    req.end();
  });

async function withProxy<T>(
  o: Omit<EgressProxyOptions, 'socketPath'>,
  fn: (s: string, proxy: Awaited<ReturnType<typeof startEgressProxy>>) => Promise<T>,
): Promise<T> {
  const s = sock();
  const proxy = await startEgressProxy({ socketPath: s, ...o });
  try {
    return await fn(s, proxy);
  } finally {
    await proxy.close();
  }
}

describe('testServiceListed: exact host:port matching', () => {
  it('lets through an exact match only', () => {
    const list = ['127.0.0.1:5433'];
    expect(testServiceListed('127.0.0.1', 5433, list)).toBe(true);
    // port mismatch
    expect(testServiceListed('127.0.0.1', 5434, list)).toBe(false);
    expect(testServiceListed('127.0.0.1', 0, list)).toBe(false);
    expect(testServiceListed('127.0.0.1', 70000, list)).toBe(false);
    // host mismatch: another loopback address, another loopback name, other notations, a LAN address
    for (const h of [
      '127.0.0.2',
      'localhost',
      '::1',
      '::ffff:127.0.0.1',
      '0:0:0:0:0:0:0:1',
      'localhost.',
      '0x7f.1',
      '2130706433',
      '10.0.0.5',
      '*',
    ])
      expect(testServiceListed(h, 5433, list), h).toBe(false);
  });

  it('treats [::1] and ::1 as the same host, and is case-insensitive for localhost', () => {
    expect(testServiceListed('::1', 6379, ['[::1]:6379'])).toBe(true);
    expect(testServiceListed('[::1]', 6379, ['[::1]:6379'])).toBe(true);
    expect(testServiceListed('LocalHost', 4000, ['localhost:4000'])).toBe(true);
    expect(testServiceListed('127.0.0.1', 4000, ['localhost:4000'])).toBe(false);
  });

  it('matches nothing with an empty list', () => {
    expect(testServiceListed('127.0.0.1', 5433, [])).toBe(false);
  });

  it('never matches a non-loopback or malformed entry', () => {
    expect(testServiceListed('10.0.0.5', 5432, ['10.0.0.5:5432'])).toBe(false);
    expect(testServiceListed('127.0.0.1', 5433, ['*:5433'])).toBe(false);
    expect(testServiceListed('127.0.0.1', 5433, ['127.0.0.1'])).toBe(false);
  });

  it('canonicalises the list and drops everything that is not an exact loopback host:port', () => {
    expect(
      canonicalTestServices([
        '127.0.0.1:5433',
        ' 127.0.0.1:5433 ',
        '[::1]:6379',
        'LOCALHOST:4000',
        '10.0.0.5:5432',
        '*:5433',
        '127.0.0.1',
        '127.0.0.2:5433',
        '127.0.0.1:0',
        '127.0.0.1:99999',
        'example.com:443',
      ]),
    ).toEqual(['127.0.0.1:5433', '[::1]:6379', 'localhost:4000']);
  });
});

describe('the egress proxy and local test services', () => {
  it('CONNECT: a declared host:port reaches the service; another port, loopback or private address is refused and logged', async () => {
    const port = await upstream();
    const other = await upstream();
    const refused: string[] = [];
    await withProxy(
      {
        allowedHosts: [],
        testServices: [`127.0.0.1:${port}`],
        onDeny: (h) => refused.push(h),
      },
      async (s, proxy) => {
        const ok = await connect(s, `127.0.0.1:${port}`);
        expect(ok.status).toBe(200);
        expect(ok.body).toContain('UP /through');
        // same host, undeclared port (something does listen there)
        expect((await connect(s, `127.0.0.1:${other}`)).status).toBe(403);
        // another loopback address
        expect((await connect(s, `127.0.0.2:${port}`)).status).toBe(403);
        expect((await connect(s, `localhost:${port}`)).status).toBe(403);
        expect((await connect(s, `[::1]:${port}`)).status).toBe(403);
        // an undeclared private address
        expect((await connect(s, `10.0.0.5:${port}`)).status).toBe(403);
        expect(proxy.denied()).toEqual(
          expect.arrayContaining(['127.0.0.1', '127.0.0.2', 'localhost', '::1', '10.0.0.5']),
        );
        expect(refused).toEqual(proxy.denied());
      },
    );
  });

  it('plain HTTP: a declared host:port reaches the service; another port is refused', async () => {
    const port = await upstream();
    const other = await upstream();
    await withProxy({ allowedHosts: [], testServices: [`127.0.0.1:${port}`] }, async (s, proxy) => {
      expect(await get(s, `http://127.0.0.1:${port}/x`)).toEqual({ status: 200, body: 'UP /x' });
      expect((await get(s, `http://127.0.0.1:${other}/x`)).status).toBe(403);
      expect((await get(s, `http://127.0.0.2:${port}/x`)).status).toBe(403);
      // https to the declared entry is not a plain request the proxy forwards to a test service
      expect((await get(s, `https://127.0.0.1:${port}/x`)).status).toBe(403);
      expect(proxy.denied()).toContain('127.0.0.1');
    });
  });

  it('reaches a declared [::1] service with the bracketed URL form too', async () => {
    let port: number;
    try {
      port = await upstream('::1');
    } catch {
      return; // no IPv6 loopback on this machine
    }
    await withProxy({ allowedHosts: [], testServices: [`[::1]:${port}`] }, async (s) => {
      expect(await get(s, `http://[::1]:${port}/v6`)).toEqual({ status: 200, body: 'UP /v6' });
      expect((await connect(s, `[::1]:${port}`)).status).toBe(200);
      expect((await connect(s, `127.0.0.1:${port}`)).status).toBe(403);
    });
  });

  it('a stray non-loopback or wildcard entry in the list opens nothing', async () => {
    const port = await upstream();
    await withProxy(
      {
        allowedHosts: [],
        testServices: ['10.0.0.5:5432', `*:${port}`, '127.0.0.1'],
        resolve: async () => '127.0.0.1',
      },
      async (s) => {
        expect((await connect(s, `127.0.0.1:${port}`)).status).toBe(403);
        expect((await connect(s, '10.0.0.5:5432')).status).toBe(403);
        expect((await get(s, `http://127.0.0.1:${port}/x`)).status).toBe(403);
      },
    );
  });

  it('an empty or absent list gives the same answers as before', async () => {
    const port = await upstream();
    for (const testServices of [undefined, []]) {
      await withProxy({ allowedHosts: [], ...(testServices ? { testServices } : {}) }, async (s) => {
        expect((await connect(s, `127.0.0.1:${port}`)).status).toBe(403);
        expect((await get(s, `http://127.0.0.1:${port}/x`)).status).toBe(403);
      });
    }
  });
});

describe('test services and private endpoints do not leak into each other', () => {
  it('a test-service entry does not open a private-endpoint target or an org route', async () => {
    const port = await upstream();
    await withProxy(
      {
        allowedHosts: ['org.lan'],
        testServices: [`127.0.0.1:${port}`],
        routes: [{ prefix: '/org', upstream: `http://org.lan:${port}`, headers: {}, orgSourced: true }],
        resolve: async () => '127.0.0.1',
      },
      async (s) => {
        // a name not in either list, even one that resolves to the declared loopback address
        expect((await connect(s, `lan.test:${port}`)).status).toBe(403);
        expect((await get(s, `http://lan.test:${port}/x`)).status).toBe(403);
        // an org-sourced route to the test-service address still needs a private endpoint entry
        expect((await get(s, '/org/v1')).status).toBe(403);
      },
    );
  });

  it('a private-endpoint entry does not open a test-service address', async () => {
    const port = await upstream();
    await withProxy(
      { allowedHosts: [], privateEndpoints: [`lan.test:${port}`], resolve: async () => '10.9.9.9' },
      async (s) => {
        expect((await connect(s, `127.0.0.1:${port}`)).status).toBe(403);
        expect((await get(s, `http://127.0.0.1:${port}/x`)).status).toBe(403);
      },
    );
  });

  it('with both lists, each works for its own entries only', async () => {
    const svc = await upstream();
    const lan = await upstream();
    await withProxy(
      {
        allowedHosts: [],
        testServices: [`127.0.0.1:${svc}`],
        privateEndpoints: [`lan.test:${lan}`],
        resolve: async () => '127.0.0.1',
      },
      async (s) => {
        expect((await connect(s, `127.0.0.1:${svc}`)).status).toBe(200);
        expect((await get(s, `http://lan.test:${lan}/p`)).body).toBe('UP /p');
        // the test-service port under the private-endpoint name, and the private-endpoint port on the loopback literal
        expect((await get(s, `http://lan.test:${svc}/p`)).status).toBe(403);
        expect((await connect(s, `127.0.0.1:${lan}`)).status).toBe(403);
      },
    );
  });
});
