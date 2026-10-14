import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileTokenStore, gitAuthFor, MemoryTokenStore } from '../src/forge/index.ts';
import type { ForgeEnv } from '../src/forge/types.ts';
import { AzureDevOpsIntegration } from '../src/integrations/forge-tokens.ts';
import type { AdapterEnv } from '../src/integrations/types.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

const HOST = 'dev.azure.com';
const storeFile = () => join(mkdtempSync(join(tmp(), 'azt-')), 'secrets', 'git-tokens.json');
const forgeEnv = (tokens: ForgeEnv['tokens'], over: Partial<ForgeEnv> = {}): ForgeEnv => ({
  exec: { run: async () => ({ exitCode: 127, stdout: '', stderr: '' }) },
  fetch: (async () => new Response('{}', { status: 200 })) as typeof fetch,
  tokens,
  processEnv: {},
  ...over,
});
const envOf = (auth: { env: Record<string, string> }): string => JSON.stringify(auth.env);

describe('Azure DevOps tokens are kept per organization', () => {
  it('two organizations on dev.azure.com live side by side, case-insensitively', () => {
    const s = new FileTokenStore(storeFile());
    s.set({ provider: 'azure-devops', host: HOST, token: 'PAT-ACME', organization: 'Acme' });
    s.set({ provider: 'azure-devops', host: HOST, token: 'PAT-OTHER', organization: 'other' });
    expect(s.get('azure-devops', HOST, 'acme')?.token).toBe('PAT-ACME');
    expect(s.get('azure-devops', HOST, 'ACME')?.token).toBe('PAT-ACME');
    expect(s.get('azure-devops', HOST, 'other')?.token).toBe('PAT-OTHER');
    expect(s.get('azure-devops', HOST, 'third')).toBeUndefined();
    expect(
      s
        .list()
        .map((t) => t.organization)
        .sort(),
    ).toEqual(['Acme', 'other']);
  });

  it('other providers stay keyed by provider and host only', () => {
    const file = storeFile();
    const s = new FileTokenStore(file);
    s.set({ provider: 'gitlab', host: 'gitlab.com', token: 'GL' });
    expect(s.get('gitlab', 'GitLab.com')?.token).toBe('GL');
    expect(s.get('gitlab', 'gitlab.com', 'whatever')?.token).toBe('GL');
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')))).toEqual(['gitlab@gitlab.com']);
  });

  it('remove drops only that organization', () => {
    const s = new FileTokenStore(storeFile());
    s.set({ provider: 'azure-devops', host: HOST, token: 'A', organization: 'acme' });
    s.set({ provider: 'azure-devops', host: HOST, token: 'B', organization: 'other' });
    expect(s.remove('azure-devops', HOST, 'acme')).toBe(true);
    expect(s.remove('azure-devops', HOST, 'acme')).toBe(false);
    expect(s.get('azure-devops', HOST, 'acme')).toBeUndefined();
    expect(s.get('azure-devops', HOST, 'other')?.token).toBe('B');
  });

  it('migrates the old single entry on read and keeps it readable', () => {
    const file = storeFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        'azure-devops@dev.azure.com': {
          provider: 'azure-devops',
          host: HOST,
          token: 'OLD',
          organization: 'acme',
          savedAt: '2026-01-01T00:00:00.000Z',
        },
        'gitlab@gitlab.com': { provider: 'gitlab', host: 'gitlab.com', token: 'GL', savedAt: 'x' },
      }),
    );
    const s = new FileTokenStore(file);
    expect(s.get('azure-devops', HOST, 'acme')?.token).toBe('OLD');
    expect(s.get('gitlab', 'gitlab.com')?.token).toBe('GL');
    // A second organization added later does not overwrite the migrated one; the file is rewritten in the new shape.
    s.set({ provider: 'azure-devops', host: HOST, token: 'NEW', organization: 'other' });
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).sort()).toEqual([
      'azure-devops@dev.azure.com#acme',
      'azure-devops@dev.azure.com#other',
      'gitlab@gitlab.com',
    ]);
    expect(s.get('azure-devops', HOST, 'acme')?.token).toBe('OLD');
  });

  it('git auth resolves the organization from both URL forms', async () => {
    const t = new MemoryTokenStore();
    t.set({ provider: 'azure-devops', host: HOST, token: 'PAT-ACME', organization: 'acme' });
    t.set({ provider: 'azure-devops', host: HOST, token: 'PAT-OTHER', organization: 'other' });
    const env = forgeEnv(t);
    const urls: Array<[string, string, string]> = [
      ['https://dev.azure.com/acme/Shop/_git/web', 'PAT-ACME', 'PAT-OTHER'],
      ['https://other@dev.azure.com/other/Shop/_git/web', 'PAT-OTHER', 'PAT-ACME'],
      ['https://acme.visualstudio.com/Shop/_git/web', 'PAT-ACME', 'PAT-OTHER'],
      ['https://other.visualstudio.com/DefaultCollection/Shop/_git/web', 'PAT-OTHER', 'PAT-ACME'],
    ];
    for (const [url, yes, no] of urls) {
      const a = await gitAuthFor(env, url);
      expect(envOf(a), url).toContain(yes);
      expect(envOf(a), url).not.toContain(no);
    }
    // An organization without a token gets no PAT at all.
    expect(envOf(await gitAuthFor(env, 'https://dev.azure.com/third/Shop/_git/web'))).not.toContain('PAT-');
  });
});

describe('Integrations adapter for Azure DevOps', () => {
  it('connects, tests and removes two organizations independently', async () => {
    const tokens = new MemoryTokenStore();
    const seen: string[] = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      seen.push(`${String(input)} ${h.authorization ?? ''}`);
      return new Response('{"count":1}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const forge = forgeEnv(tokens, { fetch: fetcher });
    const env = {
      forge,
      now: () => new Date('2026-10-14T08:00:00Z'),
      touchRecheck: () => {},
    } as unknown as AdapterEnv;
    const a = new AzureDevOpsIntegration(env);
    const basic = (p: string) => `Basic ${Buffer.from(`:${p}`).toString('base64')}`;

    expect(await a.connect('acme', 'token', { token: 'PAT-ACME' })).toMatchObject({ state: 'connected' });
    expect(await a.connect('other', 'token', { token: 'PAT-OTHER' })).toMatchObject({ state: 'connected' });
    expect(seen.some((l) => l.includes('/acme/_apis') && l.endsWith(basic('PAT-ACME')))).toBe(true);
    expect(seen.some((l) => l.includes('/other/_apis') && l.endsWith(basic('PAT-OTHER')))).toBe(true);
    expect((await a.instances()).sort()).toEqual(['acme', 'other']);

    await a.remove('acme');
    expect(tokens.get('azure-devops', HOST, 'acme')).toBeUndefined();
    expect(tokens.get('azure-devops', HOST, 'other')?.token).toBe('PAT-OTHER');
    expect(await a.instances()).toEqual(['other']);
    expect(await a.test('other')).toMatchObject({ state: 'connected' });
  });
});
