import { mkdtempSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseUrlEndpointProblem, normalizePrivateEndpoints, parsePrivateEndpoint } from '@aom/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { ProviderStore } from '../src/direct/store.ts';
import { isNeverReachable, startEgressProxy } from '../src/sandbox/egress-proxy.ts';
import { RunnerKeys } from '../src/secrets/keys.ts';

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

describe('parsing an allow-list entry', () => {
  it('takes exact private host:port entries and refuses everything else', () => {
    for (const ok of [
      '192.168.1.12:11434',
      'studio.lan:1234',
      '10.0.0.5:80',
      '[fd00::5]:8080',
      '172.16.3.4:5',
    ])
      expect(parsePrivateEndpoint(ok).ok, ok).toBe(true);
    const bad: Array<[string, RegExp]> = [
      ['192.168.1.0/24:80', /exact/],
      ['192.168.*.*:80', /exact/],
      ['*.lan:80', /exact/],
      ['192.168.1.12', /host:port/],
      ['192.168.1.12:0', /port/],
      ['192.168.1.12:70000', /port/],
      ['169.254.169.254:80', /never/],
      ['metadata.google.internal:80', /never/],
      ['0.0.0.0:80', /never/],
      ['8.8.8.8:53', /private/],
      ['[fe80::1]:80', /never/],
      ['999.1.1.1:80', /valid/],
    ];
    for (const [raw, why] of bad) {
      const r = parsePrivateEndpoint(raw);
      expect(r.ok, raw).toBe(false);
      if (!r.ok) expect(r.error, raw).toMatch(why);
    }
    expect(normalizePrivateEndpoints([' 192.168.1.12:11434 ', '192.168.1.12:11434'])).toEqual({
      ok: true,
      entries: ['192.168.1.12:11434'],
    });
    expect(normalizePrivateEndpoints(['10.0.0.1:1', '8.8.8.8:1']).ok).toBe(false);
  });
  it('checks a base URL against the list: loopback and public hosts pass, a private IP needs its entry, metadata never', () => {
    const list = ['192.168.1.12:11434'];
    expect(baseUrlEndpointProblem('http://localhost:11434/v1', [])).toBeUndefined();
    expect(baseUrlEndpointProblem('https://openrouter.ai/api/v1', [])).toBeUndefined();
    expect(baseUrlEndpointProblem('http://192.168.1.12:11434/v1', [])).toMatch(/private endpoints/);
    expect(baseUrlEndpointProblem('http://192.168.1.12:11434/v1', list)).toBeUndefined();
    expect(baseUrlEndpointProblem('http://192.168.1.12:9999/v1', list)).toMatch(/private/);
    expect(baseUrlEndpointProblem('http://169.254.169.254/latest', list)).toMatch(/metadata/);
    expect(baseUrlEndpointProblem('http://192.168.1.21:11434/v1', list)).toMatch(/private/);
  });
});

describe('the egress proxy and the allow-list', () => {
  const sock = () => join(mkdtempSync(join(tmpdir(), 'aom-pe-')), 'p.sock');

  it('reaches a listed host:port on the LAN, and no other port or host', async () => {
    const port = await upstream();
    const s = sock();
    const proxy = await startEgressProxy({
      socketPath: s,
      allowedHosts: ['public.test'],
      privateEndpoints: [`lan.test:${port}`],
      resolve: async () => '127.0.0.1',
    });
    try {
      expect((await get(s, `http://lan.test:${port}/a`)).body).toBe('UP /a');
      expect((await get(s, `http://lan.test:${port + 1}/a`)).status).toBe(403);
      expect((await get(s, `http://other.lan:${port}/a`)).status).toBe(403);
      // a name that is allowed for the public internet may not reach a private address
      expect((await get(s, `http://public.test:${port}/a`)).status).toBe(403);
    } finally {
      await proxy.close();
    }
  });

  it('refuses everything private with an empty list (off by default)', async () => {
    const port = await upstream();
    const s = sock();
    const proxy = await startEgressProxy({
      socketPath: s,
      allowedHosts: ['public.test'],
      resolve: async () => '10.1.2.3',
    });
    try {
      expect((await get(s, `http://lan.test:${port}/a`)).status).toBe(403);
      expect((await get(s, `http://public.test:${port}/a`)).status).toBe(403);
    } finally {
      await proxy.close();
    }
  });

  it('never reaches the metadata address, even when it is listed or a listed name resolves to it', async () => {
    expect(isNeverReachable('169.254.169.254')).toBe(true);
    expect(isNeverReachable('fe80::1')).toBe(true);
    expect(isNeverReachable('192.168.1.1')).toBe(false);
    const s = sock();
    const proxy = await startEgressProxy({
      socketPath: s,
      allowedHosts: [],
      privateEndpoints: ['lan.test:80'],
      resolve: async () => '169.254.169.254',
    });
    try {
      expect((await get(s, 'http://lan.test:80/latest')).status).toBe(403);
    } finally {
      await proxy.close();
    }
  });

  it('a route to a private upstream works for this machine and for a listed endpoint only', async () => {
    const port = await upstream();
    const run = async (privateEndpoints: string[], resolveTo: string, host: string) => {
      const s = sock();
      const proxy = await startEgressProxy({
        socketPath: s,
        allowedHosts: [host],
        privateEndpoints,
        routes: [
          { prefix: '/m', upstream: `http://${host}:${port}`, headers: {}, allowPrivateUpstream: true },
        ],
        resolve: async () => resolveTo,
      });
      try {
        return (await get(s, '/m/v1/models')).status;
      } finally {
        await proxy.close();
      }
    };
    expect(await run([], '127.0.0.1', 'ollama.local')).toBe(200);
    expect(await run([], '192.168.1.12', 'ollama.local')).toBe(403);
    expect(await run([`ollama.local:${port}`], '127.0.0.1', 'ollama.local')).toBe(200);
    expect(await run([`other.local:${port}`], '10.0.0.9', 'ollama.local')).toBe(403);
  });
});

describe('the provider store and the allow-list', () => {
  const store = () => {
    const dir = mkdtempSync(join(tmpdir(), 'aom-pe-store-'));
    const keys = new RunnerKeys(join(dir, 'runner-key.pem'));
    return { dir, keys, store: new ProviderStore({ file: join(dir, 'providers.json'), keys }) };
  };
  const compat = (keys: RunnerKeys, baseUrl: string) => ({
    provider: 'openai-compatible' as const,
    keyId: keys.publicKey.keyId,
    baseUrl,
    models: [],
  });

  it('holds the list on disk, empty by default, and validates it again', () => {
    const { dir, store: s } = store();
    expect(s.endpoints()).toEqual([]);
    expect(s.setEndpoints(['8.8.8.8:53']).stored).toBe(false);
    expect(s.setEndpoints(['192.168.1.12:11434'])).toEqual({ stored: true });
    expect(s.endpoints()).toEqual(['192.168.1.12:11434']);
    const again = new ProviderStore({
      file: join(dir, 'providers.json'),
      keys: new RunnerKeys(join(dir, 'runner-key.pem')),
    });
    expect(again.endpoints()).toEqual(['192.168.1.12:11434']);
  });

  it('accepts a LAN base URL only when listed, and stops using it when the entry is removed', () => {
    const { keys, store: s } = store();
    const lan = 'http://192.168.1.12:11434/v1';
    const refused = s.set(compat(keys, lan));
    expect(refused.stored).toBe(false);
    expect(refused.error).toMatch(/private endpoints/);
    expect(s.set(compat(keys, 'http://localhost:11434/v1')).stored).toBe(true);
    s.setEndpoints(['192.168.1.12:11434']);
    const ok = s.set(compat(keys, lan));
    expect(ok.stored).toBe(true);
    expect(ok.warning).toMatch(/plain http/);
    expect(s.get('openai-compatible')?.baseUrl).toBe(lan);
    s.setEndpoints([]);
    expect(s.get('openai-compatible')).toBeUndefined();
  });
});
