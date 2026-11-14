import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppCommandResultSchema, type IntegrationKindId, sealForRunner } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { appProviderOf, appsConnect, appsList, readAppKey } from '../src/apps/cli.ts';
import { AppKeyStore, pemSecrets } from '../src/apps/store.ts';
import { AutomatedAppIntegration } from '../src/integrations/automated-app.ts';
import { IntegrationService } from '../src/integrations/index.ts';
import type { AdapterEnv, IntegrationAdapter } from '../src/integrations/types.ts';
import { RunnerKeys } from '../src/secrets/keys.ts';
import { redact, unregisterSecret } from '../src/secrets/redact.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

// Generated per run: no private key is ever committed.
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs1', format: 'pem' })
  .toString();
const WS = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const ORG2 = '33333333-3333-4333-8333-333333333333';
const INTEGRATION = '44444444-4444-4444-8444-444444444444';
const INSTANCE = '4242:777';

afterEach(() => {
  for (const s of pemSecrets(PEM)) unregisterSecret(s);
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Recorded-shape GitHub answers; `appStatus` 404 plays an unknown App ID. */
function fakeGitHub(opts: { appStatus?: number; installations?: number[] } = {}) {
  let mints = 0;
  const f = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    if (u.pathname === '/app')
      return opts.appStatus
        ? json(opts.appStatus, { message: 'Not Found' })
        : json(200, { id: 4242, slug: 'guild-bot', name: 'Guild Bot' });
    if (u.pathname === '/app/installations')
      return json(
        200,
        (opts.installations ?? [777]).map((id) => ({
          id,
          account: { login: `acct${id}`, type: 'Organization' },
          suspended_at: null,
        })),
      );
    if (u.pathname === '/app/installations/777')
      return json(200, {
        id: 777,
        account: { login: 'acme', type: 'Organization' },
        repository_selection: 'selected',
        permissions: { contents: 'write', pull_requests: 'write', metadata: 'read', issues: 'write' },
        suspended_at: null,
      });
    if (u.pathname === '/app/installations/777/access_tokens' && (init.method ?? 'GET') === 'POST') {
      mints++;
      return json(201, {
        token: `ghs_cmdtoken${String(mints).padStart(24, '0')}`,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    if (u.pathname.startsWith('/users/guild-bot')) return json(200, { login: 'guild-bot[bot]', id: 99001 });
    return json(404, { message: 'Not Found' });
  }) as unknown as typeof fetch;
  return f;
}

function setup(opts: { allowWeb?: boolean; fetch?: typeof fetch } = {}) {
  const dir = mkdtempSync(join(tmp(), 'appcmd-'));
  const env = {
    paths: { secrets: join(dir, 'secrets'), logs: join(dir, 'logs') },
    fetch: opts.fetch ?? fakeGitHub(),
    now: () => new Date(),
    sealKey: () => Buffer.alloc(32, 7),
    touchRecheck: () => {},
    config: () => ({ integrations: { allowWeb: opts.allowWeb ?? true, machineScopeFromWeb: 'primary' } }),
  } as unknown as AdapterEnv;
  const adapter = new AutomatedAppIntegration('github-app', env);
  const keys = new RunnerKeys(join(dir, 'secrets', 'runner-key.pem'));
  const service = new IntegrationService({
    workstationId: WS,
    keys,
    env,
    adapters: new Map<IntegrationKindId, IntegrationAdapter>([['github-app', adapter]]),
    send: () => {},
  });
  const store = new AppKeyStore(join(dir, 'secrets'), () => Buffer.alloc(32, 7));
  let n = 0;
  const connect = async (
    over: Record<string, unknown> = {},
    sealOver: Partial<Parameters<typeof sealForRunner>[0]> = {},
  ) => {
    const ref = `share-ref-${++n}`;
    const instance = '4242:777';
    const envelope = await sealForRunner({
      publicKey: keys.publicKey.publicKey,
      keyId: keys.publicKey.keyId,
      workstationId: WS,
      ref,
      kind: 'github-app',
      instance,
      op: 'connect',
      method: 'app_key',
      fields: { privateKey: PEM },
      serverTimeMs: Date.now(),
      ...sealOver,
    });
    return {
      ref,
      payload: {
        requestId: `req-${n}`,
        orgId: ORG,
        integrationId: INTEGRATION,
        provider: 'github-app',
        host: 'github.com',
        appRef: '4242',
        installationId: '777',
        ref,
        envelope,
        ...over,
      },
    };
  };
  return { dir, service, adapter, store, connect, auditFile: join(dir, 'logs', 'integrations.jsonl') };
}

describe('app.* runner commands', () => {
  it('app.connect opens a sealed envelope, verifies with GitHub and stores the key with the org ref', async () => {
    const s = setup();
    const r = await s.service.handleApp('app.connect', (await s.connect()).payload);
    expect(AppCommandResultSchema.parse(r)).toMatchObject({ ok: true, instance: INSTANCE });
    expect(r.identity?.commitEmail).toBe('99001+guild-bot[bot]@users.noreply.github.com');
    expect(s.store.get(INSTANCE)?.refs).toEqual([{ orgId: ORG, integrationId: INTEGRATION }]);
    expect(JSON.stringify(r)).not.toContain('PRIVATE KEY');
    expect(readFileSync(s.auditFile, 'utf8')).not.toContain('PRIVATE KEY');
  });

  it('refuses a replayed ref, a tampered AAD and allow-web off, and stores nothing', async () => {
    const s = setup();
    const first = await s.connect();
    expect((await s.service.handleApp('app.connect', first.payload)).ok).toBe(true);
    s.adapter.broker().store.remove(INSTANCE);
    const replay = await s.service.handleApp('app.connect', first.payload);
    expect(replay.ok).toBe(false);
    // the envelope was sealed for another instance: the AAD no longer matches
    const tampered = await s.connect({}, { instance: '9999:1' });
    expect((await s.service.handleApp('app.connect', tampered.payload)).ok).toBe(false);
    expect(s.store.get(INSTANCE)).toBeUndefined();

    const off = setup({ allowWeb: false });
    const r = await off.service.handleApp('app.connect', (await off.connect()).payload);
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toMatch(/allow-web on/);
    expect(off.store.get(INSTANCE)).toBeUndefined();
  });

  it('a wrong App ID stores nothing and leaves no key in the redaction registry', async () => {
    const s = setup({ fetch: fakeGitHub({ appStatus: 404 }) });
    const r = await s.service.handleApp('app.connect', (await s.connect()).payload);
    expect(r.ok).toBe(false);
    expect(r.code).toBeDefined();
    expect(s.store.get(INSTANCE)).toBeUndefined();
    expect(redact(PEM)).toBe(PEM);
  });

  it('app.remove keeps a key two organizations use until both are gone, then deletes it', async () => {
    const s = setup();
    await s.service.handleApp('app.connect', (await s.connect()).payload);
    await s.service.handleApp('app.connect', (await s.connect({ orgId: ORG2 })).payload);
    expect(s.store.get(INSTANCE)?.refs).toHaveLength(2);
    await s.service.handleApp('app.remove', { orgId: ORG, integrationId: INTEGRATION, instance: INSTANCE });
    expect(s.store.get(INSTANCE)?.refs).toEqual([{ orgId: ORG2, integrationId: INTEGRATION }]);
    expect(redact(PEM)).not.toContain('PRIVATE KEY-----\n');
    await s.service.handleApp('app.remove', { orgId: ORG2, integrationId: INTEGRATION, instance: INSTANCE });
    expect(s.store.get(INSTANCE)).toBeUndefined();
    expect(redact(PEM)).toBe(PEM);
  });

  it('app.sync drops the refs of an organization the server no longer lists (removed while offline)', async () => {
    const s = setup();
    await s.service.handleApp('app.connect', (await s.connect()).payload);
    await s.service.handleApp('app.sync', {
      orgIds: [ORG],
      apps: [{ orgId: ORG, integrationId: INTEGRATION, instance: INSTANCE }],
    });
    expect(s.store.get(INSTANCE)).toBeDefined();
    await s.service.handleApp('app.sync', { orgIds: [ORG], apps: [] });
    expect(s.store.get(INSTANCE)).toBeUndefined();
  });

  it('app.test re-verifies the stored copy and app.adopt adds the organization ref to a CLI copy', async () => {
    const s = setup();
    const cli = await appsConnect(s.adapter, { appId: '4242', installation: '777' }, PEM);
    expect(cli.ok).toBe(true);
    expect(s.store.get(INSTANCE)).toMatchObject({ local: true, refs: [] });
    expect((await s.service.handleApp('app.test', { requestId: 'r', instance: INSTANCE })).ok).toBe(true);
    await s.service.handleApp('app.adopt', {
      requestId: 'r2',
      orgId: ORG,
      integrationId: INTEGRATION,
      instance: INSTANCE,
    });
    expect(s.store.get(INSTANCE)?.refs).toEqual([{ orgId: ORG, integrationId: INTEGRATION }]);
    // a local copy survives the organization's removal
    await s.service.handleApp('app.remove', { orgId: ORG, integrationId: INTEGRATION, instance: INSTANCE });
    expect(s.store.get(INSTANCE)).toBeDefined();
  });

  it('an unknown or malformed payload is an answer, not a crash', async () => {
    const s = setup();
    expect((await s.service.handleApp('app.connect', { nope: 1 })).ok).toBe(false);
  });
});

describe('apps CLI', () => {
  it('maps the provider short name and refuses unknown providers', () => {
    expect(appProviderOf('github')).toBe('github-app');
    expect(() => appProviderOf('gitea')).toThrow(/Supported: github/);
  });

  it('reads the key from a file, from stdin when not a terminal, otherwise from the hidden prompt', async () => {
    const dir = mkdtempSync(join(tmp(), 'appkey-'));
    writeFileSync(join(dir, 'k.pem'), 'from-file');
    const io = { stdin: async () => 'from-stdin', prompt: async () => 'from-prompt', isTTY: true };
    expect(await readAppKey({ keyFile: join(dir, 'k.pem') }, io)).toBe('from-file');
    expect(await readAppKey({ keyStdin: true }, io)).toBe('from-stdin');
    expect(await readAppKey({}, { ...io, isTTY: false })).toBe('from-stdin');
    expect(await readAppKey({}, io)).toBe('from-prompt');
  });

  it('connect prints the bot identity and never the key; list shows it; a non-PEM is refused', async () => {
    const s = setup();
    const r = await appsConnect(s.adapter, { appId: '4242', installation: '777' }, PEM);
    const out = r.lines.join('\n');
    expect(out).toContain('guild-bot[bot]');
    expect(out).toContain('99001+guild-bot[bot]@users.noreply.github.com');
    expect(out).not.toContain('PRIVATE KEY');
    expect((await appsList([s.adapter])).join('\n')).toContain(`github-app ${INSTANCE}`);
    expect((await appsConnect(s.adapter, { appId: '4242' }, 'not a key')).ok).toBe(false);
  });

  it('several installations list the choices and save nothing', async () => {
    const s = setup({ fetch: fakeGitHub({ installations: [777, 888] }) });
    const r = await appsConnect(s.adapter, { appId: '4242' }, PEM);
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toContain('--installation 888');
    expect(s.store.get(INSTANCE)).toBeUndefined();
  });
});
