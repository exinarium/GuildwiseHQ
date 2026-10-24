import { mkdtempSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolvedEndpointProblem } from '../src/direct/guarded-fetch.ts';
import {
  isNeverReachable,
  isPrivateAddress,
  safeRoutePath,
  startEgressProxy,
} from '../src/sandbox/egress-proxy.ts';

const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});
function upstream(): Promise<number> {
  const s = createServer((req, res) => res.end(`UP ${req.url}`));
  servers.push(s);
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r((s.address() as { port: number }).port)));
}
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
const sock = () => join(mkdtempSync(join(tmpdir(), 'aom-eh-')), 'p.sock');

describe('finding 7: one normaliser for every private check', () => {
  const private_ = [
    '::ffff:7f00:1',
    '::ffff:127.0.0.1',
    '::ffff:a00:1',
    '::ffff:c0a8:101',
    '::10.0.0.1',
    '64:ff9b::7f00:1',
    '64:ff9b::a9fe:a9fe',
    '2002:7f00:1::',
    '2002:a9fe:a9fe::1',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    'fec0::1',
    '::ffff:a9fe:a9fe',
  ];
  it('the egress proxy treats every listed form as private, and metadata forms as never reachable', () => {
    for (const ip of private_) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['::ffff:a9fe:a9fe', '64:ff9b::a9fe:a9fe', '2002:a9fe:a9fe::1', '::a9fe:a9fe'])
      expect(isNeverReachable(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '2606:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808'])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('a name allowed for the public internet that resolves to a hex-mapped private address is refused', async () => {
    const port = await upstream();
    for (const addr of ['::ffff:7f00:1', '::ffff:c0a8:101', '64:ff9b::7f00:1', '2002:a9fe:a9fe::1']) {
      const s = sock();
      const proxy = await startEgressProxy({
        socketPath: s,
        allowedHosts: ['public.test'],
        resolve: async () => addr,
      });
      try {
        expect((await get(s, `http://public.test:${port}/`)).status, addr).toBe(403);
      } finally {
        await proxy.close();
      }
    }
  });

  it('the direct-model guard judges the same forms (a name resolving to ::ffff:a9fe:a9fe is metadata)', async () => {
    const r = (a: string, entries: string[] = []) =>
      resolvedEndpointProblem('x.test', 80, entries, async () => [a]);
    expect(await r('::ffff:a9fe:a9fe', ['x.test:80'])).toMatch(/metadata/);
    expect(await r('::ffff:c0a8:101')).toMatch(/private/);
    expect(await r('::ffff:c0a8:101', ['x.test:80'])).toBeUndefined();
    expect(await r('2002:a9fe:a9fe::1', ['x.test:80'])).toMatch(/metadata/);
    expect(await r('8.8.8.8')).toBeUndefined();
  });

  it('*.localhost is loopback for the direct guard too: an organization endpoint on it is refused', async () => {
    expect(await resolvedEndpointProblem('a.localhost', 80, [], async () => ['127.0.0.1'], true)).toMatch(
      /private/,
    );
    expect(await resolvedEndpointProblem('a.localhost', 80, [], async () => ['127.0.0.1'])).toBeUndefined();
  });
});

describe('finding 6: an organization-sourced route', () => {
  const run = async (o: {
    upstreamHost: string;
    resolveTo: string;
    privateEndpoints?: string[];
    orgSourced: boolean;
    scheme?: string;
  }) => {
    const port = await upstream();
    const s = sock();
    const proxy = await startEgressProxy({
      socketPath: s,
      allowedHosts: [o.upstreamHost],
      privateEndpoints: o.privateEndpoints ?? [],
      routes: [
        {
          prefix: '/m',
          upstream: `${o.scheme ?? 'http'}://${o.upstreamHost}:${port}`,
          headers: {},
          allowPrivateUpstream: true,
          ...(o.orgSourced ? { orgSourced: true } : {}),
        },
      ],
      resolve: async () => o.resolveTo,
    });
    try {
      return { status: (await get(s, '/m/v1/models')).status, port };
    } finally {
      await proxy.close();
    }
  };
  it("the owner's own route keeps loopback", async () => {
    expect(
      (await run({ upstreamHost: 'ollama.local', resolveTo: '127.0.0.1', orgSourced: false })).status,
    ).toBe(200);
  });
  it('an org route to loopback is refused, listed or not by a different entry', async () => {
    expect(
      (await run({ upstreamHost: 'ollama.local', resolveTo: '127.0.0.1', orgSourced: true })).status,
    ).toBe(403);
    expect(
      (
        await run({
          upstreamHost: 'ollama.local',
          resolveTo: '127.0.0.1',
          orgSourced: true,
          privateEndpoints: ['other.local:1'],
        })
      ).status,
    ).toBe(403);
  });
  it('an org route to a literal loopback address or *.localhost is refused by its spelling', async () => {
    expect((await run({ upstreamHost: '127.0.0.1', resolveTo: '127.0.0.1', orgSourced: true })).status).toBe(
      403,
    );
    expect(
      (await run({ upstreamHost: 'a.localhost', resolveTo: '127.0.0.1', orgSourced: true })).status,
    ).toBe(403);
  });
  it('an org route works to a listed endpoint, over plain http', async () => {
    const port = await upstream();
    const s = sock();
    const proxy = await startEgressProxy({
      socketPath: s,
      allowedHosts: ['lan.test'],
      privateEndpoints: [`lan.test:${port}`],
      routes: [{ prefix: '/m', upstream: `http://lan.test:${port}`, headers: {}, orgSourced: true }],
      resolve: async () => '127.0.0.1',
    });
    try {
      expect((await get(s, '/m/x')).body).toBe('UP /x');
    } finally {
      await proxy.close();
    }
  });
  it('an org route over plain http to a public name is refused', async () => {
    expect(
      (await run({ upstreamHost: 'api.example.com', resolveTo: '8.8.8.8', orgSourced: true })).status,
    ).toBe(403);
  });
});

describe('finding 16: plain http and route paths', () => {
  it('the allowed ports apply to absolute-URL requests too', async () => {
    const port = await upstream();
    const s = sock();
    const proxy = await startEgressProxy({
      socketPath: s,
      allowedHosts: ['public.test'],
      resolve: async () => '8.8.8.8',
    });
    try {
      // port 8080 is not 80 or 443: refused before any connection
      expect((await get(s, `http://public.test:${port}/a`)).status).toBe(403);
      expect((await get(s, 'http://public.test:8080/a')).status).toBe(403);
    } finally {
      await proxy.close();
    }
  });
  it('rejects dot segments, encoded dots and slashes in a route path, and stays under the upstream prefix', async () => {
    for (const p of [
      '/../x',
      '/a/../../x',
      '/%2e%2e/x',
      '/%2E%2e/x',
      '/a/%2e%2e/%2e%2e/x',
      '/a%2f..%2fb',
      '/a\\..\\b',
      '/.',
    ]) {
      expect(safeRoutePath(p), p).toBeUndefined();
    }
    expect(safeRoutePath('/v1/models?x=..')).toBe('/v1/models?x=..');
    const port = await upstream();
    const s = sock();
    const proxy = await startEgressProxy({
      socketPath: s,
      allowedHosts: ['up.test'],
      allowPrivate: true,
      routes: [{ prefix: '/m', upstream: `http://up.test:${port}/api/v1`, headers: {} }],
      resolve: async () => '127.0.0.1',
    });
    try {
      expect((await get(s, '/m/models')).body).toBe('UP /api/v1/models');
      expect((await get(s, '/m/../../admin')).status).toBe(400);
      expect((await get(s, '/m/%2e%2e/admin')).status).toBe(400);
      expect((await get(s, '/m/a/%2E%2E/%2e%2e/admin')).status).toBe(400);
    } finally {
      await proxy.close();
    }
  });
});

describe('finding 6: the opencode route of an organization key', () => {
  it('is org-sourced and takes no private-upstream exemption; the own key keeps it', async () => {
    const { opencodeRoute } = await import('../src/adapters/opencode.ts');
    const base = {
      id: 'openai-compatible' as const,
      apiKey: 'k',
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: [],
    };
    const org = opencodeRoute({ ...base, source: 'org' });
    expect(org?.orgSourced).toBe(true);
    expect(org?.allowPrivateUpstream).toBe(false);
    const own = opencodeRoute({ ...base, source: 'workstation' });
    expect(own?.orgSourced).toBeUndefined();
    expect(own?.allowPrivateUpstream).toBe(true);
  });
});
