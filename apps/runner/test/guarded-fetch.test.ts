import { createServer, type Server } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { DirectModelAdapter } from '../src/adapters/direct-model.ts';
import { guardedFetch, resolvedEndpointProblem } from '../src/direct/guarded-fetch.ts';
import { ModelLister } from '../src/direct/models.ts';

/** R3c: the direct runtime resolves the NAME of an OpenAI-compatible endpoint and judges what it resolves to (Q47). */
const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});
const answers = (map: Record<string, string[]>) => async (host: string) => {
  const a = map[host];
  if (!a) throw new Error(`ENOTFOUND ${host}`);
  return a;
};

describe('judging a resolved endpoint', () => {
  const dns = answers({
    'ollama.lan': ['192.168.1.12'],
    'sneaky.example': ['169.254.169.254'],
    'public.example': ['93.184.216.34'],
    'mixed.example': ['93.184.216.34', '10.0.0.9'],
    'self.example': ['127.0.0.1'],
    'v6.lan': ['fd00::5'],
    'mapped.lan': ['::ffff:10.1.2.3'],
  });
  it('lets loopback and public answers through', async () => {
    expect(await resolvedEndpointProblem('localhost', 11434, [], dns)).toBeUndefined();
    expect(await resolvedEndpointProblem('self.example', 11434, [], dns)).toBeUndefined();
    expect(await resolvedEndpointProblem('public.example', 443, [], dns)).toBeUndefined();
    expect(await resolvedEndpointProblem('93.184.216.34', 443, [], dns)).toBeUndefined();
  });
  it('refuses a name that resolves to the metadata address, listed or not', async () => {
    const p = await resolvedEndpointProblem(
      'sneaky.example',
      80,
      ['sneaky.example:80', '169.254.169.254:80'],
      dns,
    );
    expect(p).toMatch(/link-local and metadata/);
  });
  it('refuses a name that resolves to a private address unless that host:port (the name or the address) is listed', async () => {
    expect(await resolvedEndpointProblem('ollama.lan', 11434, [], dns)).toMatch(/private network/);
    expect(await resolvedEndpointProblem('ollama.lan', 11434, ['ollama.lan:9999'], dns)).toMatch(
      /private network/,
    );
    expect(await resolvedEndpointProblem('ollama.lan', 11434, ['ollama.lan:11434'], dns)).toBeUndefined();
    expect(await resolvedEndpointProblem('ollama.lan', 11434, ['192.168.1.12:11434'], dns)).toBeUndefined();
    expect(await resolvedEndpointProblem('v6.lan', 80, [], dns)).toMatch(/private/);
    expect(await resolvedEndpointProblem('v6.lan', 80, ['v6.lan:80'], dns)).toBeUndefined();
    // an IPv4-mapped IPv6 address is judged as the IPv4 address it carries
    expect(await resolvedEndpointProblem('mapped.lan', 80, [], dns)).toMatch(/private/);
  });
  it('judges every address a name gives: one private answer among public ones is enough to refuse', async () => {
    expect(await resolvedEndpointProblem('mixed.example', 443, [], dns)).toMatch(/10\.0\.0\.9/);
  });
  it('says so when the name does not resolve', async () => {
    expect(await resolvedEndpointProblem('nowhere.example', 80, [], dns)).toBe(
      'cannot resolve nowhere.example',
    );
  });
});

describe('the guarded fetch', () => {
  function upstream(): Promise<number> {
    const s = createServer((req, res) => res.end(`UP ${req.url}`));
    servers.push(s);
    return new Promise((r) => s.listen(0, '127.0.0.1', () => r((s.address() as { port: number }).port)));
  }

  it('connects to a name that resolves to this machine, through a socket opened to the judged address', async () => {
    const port = await upstream();
    const f = guardedFetch({ entries: () => [], resolve: answers({ 'ollama.test': ['127.0.0.1'] }) });
    const res = await f(`http://ollama.test:${port}/v1/models`);
    expect(await res.text()).toBe('UP /v1/models');
  });

  it('refuses before connecting when the name resolves to a private address that is not listed', async () => {
    const f = guardedFetch({
      entries: () => [],
      resolve: answers({ 'ollama.lan': ['10.9.9.9'] }),
      inner: async () => {
        throw new Error('must not be reached');
      },
    });
    await expect(f('http://ollama.lan:11434/v1/models')).rejects.toThrow(/private network/);
  });

  it('reads the allow-list at each call: removing an entry closes the endpoint again', async () => {
    let list: string[] = ['ollama.lan:11434'];
    const f = guardedFetch({
      entries: () => list,
      resolve: answers({ 'ollama.lan': ['10.9.9.9'] }),
      inner: async () => new Response('ok'),
    });
    expect(await (await f('http://ollama.lan:11434/v1/models')).text()).toBe('ok');
    list = [];
    await expect(f('http://ollama.lan:11434/v1/models')).rejects.toThrow(/private network/);
  });

  it('judges the address again when the socket is opened: a name that changes its answer in between does not get through (rebinding)', async () => {
    const port = await upstream();
    let calls = 0;
    // the first answer (the up-front check) is this machine; the second (the connection) is the metadata address
    const resolve = async () => (++calls === 1 ? ['127.0.0.1'] : ['169.254.169.254']);
    const f = guardedFetch({ entries: () => [], resolve });
    await expect(f(`http://rebind.test:${port}/v1/models`)).rejects.toThrow();
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});

describe('the direct runtime uses it for an OpenAI-compatible endpoint and its model list', () => {
  it('lists a model list only after the name was judged', async () => {
    const seen: string[] = [];
    const guarded = guardedFetch({
      entries: () => [],
      resolve: answers({ 'ollama.lan': ['10.9.9.9'] }),
      inner: async (url) => {
        seen.push(url);
        return new Response(JSON.stringify({ data: [{ id: 'llama3' }] }));
      },
    });
    const lister = new ModelLister({ fetch: guarded });
    const cfg = { id: 'openai-compatible' as const, baseUrl: 'http://ollama.lan:11434/v1', models: [] };
    const r = await lister.refresh(cfg, true);
    expect(r.ids).toEqual([]);
    expect(r.problem).toMatch(/private network/);
    expect(seen).toEqual([]);
  });

  it('wires the adapter’s endpoint HTTP to the store’s private endpoints', async () => {
    const { ProviderStore } = await import('../src/direct/store.ts');
    const { tmp } = await import('./helpers.ts');
    const { join } = await import('node:path');
    const root = tmp('aom-guarded-');
    const store = new ProviderStore({
      file: join(root, 'p.json'),
      keys: { publicKey: { keyId: 'key-1', publicKey: 'x' }, open: (c: string) => c } as never,
    });
    store.set({
      provider: 'openai-compatible',
      keyId: 'key-1',
      baseUrl: 'http://ollama.lan:11434/v1',
      models: [],
    });
    // the store refuses a private IP literal outright; a NAME is accepted here and judged when the connection is made
    expect(store.get('openai-compatible')?.baseUrl).toBe('http://ollama.lan:11434/v1');
    const hits: string[] = [];
    const adapter = new DirectModelAdapter({
      store,
      root,
      resolve: answers({ 'ollama.lan': ['10.9.9.9'] }),
      fetch: async (url) => {
        hits.push(url);
        return new Response(JSON.stringify({ data: [{ id: 'llama3' }] }));
      },
    });
    const caps = await adapter.capabilities();
    expect(caps.available).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(hits).toEqual([]); // the list was not even asked for: the name resolves to an unlisted private address
  });
});
