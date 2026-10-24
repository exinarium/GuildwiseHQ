import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ProviderKeyId, providerKeyAad, sealLarge, sealProviderKey } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { ProviderStore } from '../src/direct/store.ts';
import { RunnerKeys } from '../src/secrets/keys.ts';
import { unregisterSecret } from '../src/secrets/redact.ts';
import { sealOrg, sealWs } from './seal-helpers.ts';

const ORG = '11111111-1111-4111-8111-111111111111';

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'acct-'));
  const keys = new RunnerKeys(join(dir, 'secrets', 'runner-key.pem'));
  const store = new ProviderStore({ file: join(dir, 'secrets', 'providers.json'), keys });
  /** Seals a key the way the web app does for a named account. */
  const sealAcct = (
    provider: ProviderKeyId,
    secret: string,
    account: string,
    generation: number,
    url?: string,
  ) =>
    sealProviderKey(keys.publicKey.publicKey, secret, {
      scope: 'workstation',
      provider,
      endpoint: url,
      generation,
      keyId: keys.publicKey.keyId,
      account,
    });
  const setAcct = async (
    provider: ProviderKeyId,
    account: string,
    secret: string,
    generation = 100,
    sealedAs = account,
  ) =>
    store.set({
      provider,
      account,
      keyId: keys.publicKey.keyId,
      generation,
      ciphertext: await sealAcct(provider, secret, sealedAs, generation),
      models: [],
    });
  return { dir, keys, store, setAcct, sealAcct };
}

describe('key slots with account names (S-A)', () => {
  it('the main key keeps the associated data it always had; an account name is appended and nothing else changes', () => {
    const base = { scope: 'workstation' as const, provider: 'openai', generation: 5, keyId: 'k1' };
    expect(providerKeyAad(base)).toBe(
      JSON.stringify(['aom-provider-key/v2', 'workstation', '', 'openai', '', 5, 'k1']),
    );
    expect(providerKeyAad({ ...base, account: '' })).toBe(providerKeyAad(base));
    expect(providerKeyAad({ ...base, account: 'work' })).toBe(
      JSON.stringify(['aom-provider-key/v2', 'workstation', '', 'openai', '', 5, 'k1', 'work']),
    );
    // an organization key has no account
    expect(
      providerKeyAad({
        scope: 'org',
        orgId: ORG,
        provider: 'openai',
        generation: 1,
        keyId: 'k1',
        account: 'work',
      }),
    ).toBe(providerKeyAad({ scope: 'org', orgId: ORG, provider: 'openai', generation: 1, keyId: 'k1' }));
  });

  it('stores a named account next to the main key; each is read back by its own name', async () => {
    const { dir, keys, store, setAcct } = rig();
    expect(
      store.set({
        provider: 'openai',
        keyId: keys.publicKey.keyId,
        ciphertext: await sealWs(keys, 'openai', 'sk-main-1111'),
        models: [],
      }).stored,
    ).toBe(true);
    expect((await setAcct('openai', 'work', 'sk-work-2222')).stored).toBe(true);
    expect((await setAcct('openai', 'personal', 'sk-personal-3333')).stored).toBe(true);
    expect(store.get('openai')?.apiKey).toBe('sk-main-1111');
    expect(store.get('openai', undefined, 'main')?.apiKey).toBe('sk-main-1111');
    expect(store.get('openai', undefined, 'work')).toMatchObject({
      apiKey: 'sk-work-2222',
      source: 'workstation',
      account: 'work',
    });
    expect(store.get('openai', undefined, 'personal')?.apiKey).toBe('sk-personal-3333');
    expect(store.get('openai', undefined, 'nope')).toBeUndefined();
    expect(store.accountNames()).toEqual(['personal', 'work']);
    expect(store.holdsAccount('openai', 'work')).toBe(true);
    expect(store.holdsAccount('anthropic', 'work')).toBe(false);
    // the file keeps ciphertext only
    expect(readFileSync(join(dir, 'secrets', 'providers-accounts.json'), 'utf8')).not.toContain(
      'sk-work-2222',
    );
    for (const k of ['sk-work-2222', 'sk-personal-3333']) unregisterSecret(k);
  });

  it('refuses a blob sealed for another account, for main, or for another provider', async () => {
    const { keys, store, setAcct, sealAcct } = rig();
    // sealed as `work`, presented as `personal`
    const a = await setAcct('openai', 'personal', 'sk-x-4444', 100, 'work');
    expect(a).toMatchObject({ stored: false, error: expect.stringMatching(/sealed for another/) });
    // a main-key blob presented as a named account (and the other way round)
    const mainBlob = await sealWs(keys, 'openai', 'sk-main-5555', undefined, 100);
    expect(
      store.set({
        provider: 'openai',
        account: 'work',
        keyId: keys.publicKey.keyId,
        generation: 100,
        ciphertext: mainBlob,
        models: [],
      }).stored,
    ).toBe(false);
    expect(
      store.set({
        provider: 'openai',
        keyId: keys.publicKey.keyId,
        generation: 100,
        ciphertext: await sealAcct('openai', 'sk-acct-6666', 'work', 100),
        models: [],
      }).stored,
    ).toBe(false);
    // another provider
    expect(
      store.set({
        provider: 'anthropic',
        account: 'work',
        keyId: keys.publicKey.keyId,
        generation: 100,
        ciphertext: await sealProviderKey(keys.publicKey.publicKey, 'k', {
          scope: 'workstation',
          provider: 'openai',
          generation: 100,
          keyId: keys.publicKey.keyId,
          account: 'work',
        }),
        models: [],
      }).stored,
    ).toBe(false);
    expect(store.accountNames()).toEqual([]);
  });

  it('a named account needs the bound form, a valid name, and is the workstation’s own (never the organization’s)', async () => {
    const { keys, store, setAcct } = rig();
    const old = await sealLarge(keys.publicKey.publicKey, 'sk-old-form');
    expect(
      store.set({
        provider: 'openai',
        account: 'work',
        keyId: keys.publicKey.keyId,
        ciphertext: old,
        models: [],
      }),
    ).toMatchObject({
      stored: false,
      error: expect.stringMatching(/current web app/),
    });
    for (const bad of ['main', 'org', 'Work', '9a', 'a_b'])
      expect((await setAcct('openai', bad, 'sk-1234')).stored).toBe(false);
    expect(
      store.set({
        provider: 'openai',
        account: 'work',
        source: 'org',
        orgId: ORG,
        keyId: keys.publicKey.keyId,
        generation: 1,
        ciphertext: await sealOrg(keys, ORG, 'openai', 'sk-org', 1),
        models: [],
      }),
    ).toMatchObject({ stored: false, error: expect.stringMatching(/workstation’s own key/) });
  });

  it('keeps a generation and a revocation floor per account (a removed key cannot be replayed)', async () => {
    const { keys, store, setAcct, sealAcct } = rig();
    expect((await setAcct('anthropic', 'work', 'sk-ant-1', 100)).stored).toBe(true);
    // an older version is refused
    expect(await setAcct('anthropic', 'work', 'sk-ant-0', 90)).toMatchObject({
      stored: false,
      error: expect.stringMatching(/newer version/),
    });
    // removing it raises the floor: the same blob cannot come back
    const blob = await sealAcct('anthropic', 'sk-ant-1', 'work', 100);
    store.clearPayload({ provider: 'anthropic', account: 'work' });
    expect(store.get('anthropic', undefined, 'work')).toBeUndefined();
    expect(
      store.set({
        provider: 'anthropic',
        account: 'work',
        keyId: keys.publicKey.keyId,
        generation: 100,
        ciphertext: blob,
        models: [],
      }),
    ).toMatchObject({ stored: false, error: expect.stringMatching(/removed or replaced/) });
    // another account and the main key are not affected by that floor
    expect((await setAcct('anthropic', 'other', 'sk-ant-9', 100)).stored).toBe(true);
    expect(
      store.set({
        provider: 'anthropic',
        keyId: keys.publicKey.keyId,
        generation: 100,
        ciphertext: await sealWs(keys, 'anthropic', 'sk-ant-main', undefined, 100),
        models: [],
      }).stored,
    ).toBe(true);
    // a later generation is accepted again
    expect((await setAcct('anthropic', 'work', 'sk-ant-2', 200)).stored).toBe(true);
    expect(store.get('anthropic', undefined, 'work')?.apiKey).toBe('sk-ant-2');
  });

  it('clearing one account leaves main and the other accounts alone', async () => {
    const { keys, store, setAcct } = rig();
    store.set({
      provider: 'openai',
      keyId: keys.publicKey.keyId,
      ciphertext: await sealWs(keys, 'openai', 'sk-main-7777'),
      models: [],
    });
    await setAcct('openai', 'work', 'sk-work-8888');
    await setAcct('openai', 'other', 'sk-other-9999');
    store.clearPayload({ provider: 'openai', account: 'work' });
    expect(store.get('openai')?.apiKey).toBe('sk-main-7777');
    expect(store.get('openai', undefined, 'other')?.apiKey).toBe('sk-other-9999');
    expect(store.accountNames()).toEqual(['other']);
  });

  it('`org` picks the organization’s key on purpose, even where the workstation has its own', async () => {
    const { keys, store } = rig();
    store.set({
      provider: 'openai',
      keyId: keys.publicKey.keyId,
      ciphertext: await sealWs(keys, 'openai', 'sk-own-1010'),
      models: [],
    });
    store.set({
      provider: 'openai',
      source: 'org',
      orgId: ORG,
      generation: 1,
      keyId: keys.publicKey.keyId,
      ciphertext: await sealOrg(keys, ORG, 'openai', 'sk-org-2020', 1),
      models: [],
    });
    // the main account: the workstation's key overrides the organization's, as before
    expect(store.get('openai', ORG)).toMatchObject({ apiKey: 'sk-own-1010', source: 'workstation' });
    // the project chose the organization's key: that one, and it is counted against the cap (source org)
    expect(store.get('openai', ORG, 'org')).toMatchObject({ apiKey: 'sk-org-2020', source: 'org' });
    expect(store.sourceOf('openai', ORG, 'org')).toBe('org');
    // never without the organization named, and never another organization's
    expect(store.get('openai', undefined, 'org')).toBeUndefined();
    expect(store.get('openai', '22222222-2222-4222-8222-222222222222', 'org')).toBeUndefined();
  });

  it('reports account names and a missing main key; never a key', async () => {
    const { keys, store, setAcct } = rig();
    await setAcct('openai', 'work', 'sk-work-1212');
    await setAcct('openai', 'alt', 'sk-alt-1313');
    const only = store.reportKeys().find((k) => k.provider === 'openai');
    expect(only).toMatchObject({ provider: 'openai', accounts: ['alt', 'work'], main: false });
    expect(JSON.stringify(store.reportKeys())).not.toContain('sk-');
    // the provider is offered (its models are known) even with only named accounts
    expect(store.report().map((p) => p.id)).toContain('openai');
    expect(store.holds('openai')).toBe(true);
    // with a main key the report says nothing about main being absent
    store.set({
      provider: 'openai',
      keyId: keys.publicKey.keyId,
      ciphertext: await sealWs(keys, 'openai', 'sk-main-1414'),
      models: [],
    });
    const both = store.reportKeys().find((k) => k.provider === 'openai');
    expect(both?.main).toBeUndefined();
    expect(both?.accounts).toEqual(['alt', 'work']);
  });

  it('`configured` applies the account to the one provider only', async () => {
    const { keys, store, setAcct } = rig();
    store.set({
      provider: 'openai',
      keyId: keys.publicKey.keyId,
      ciphertext: await sealWs(keys, 'openai', 'sk-main-o'),
      models: [],
    });
    store.set({
      provider: 'anthropic',
      keyId: keys.publicKey.keyId,
      ciphertext: await sealWs(keys, 'anthropic', 'sk-main-a'),
      models: [],
    });
    await setAcct('openai', 'work', 'sk-work-o');
    const got = store.configured(undefined, { provider: 'openai', account: 'work' });
    expect(got.find((c) => c.id === 'openai')?.apiKey).toBe('sk-work-o');
    expect(got.find((c) => c.id === 'anthropic')?.apiKey).toBe('sk-main-a');
    // an account that does not exist leaves the provider out (the project’s choice is not silently replaced by main)
    expect(
      store.configured(undefined, { provider: 'openai', account: 'nope' }).find((c) => c.id === 'openai'),
    ).toBeUndefined();
  });

  it('a backend credential (Bedrock) can be an account too', async () => {
    const { keys, store, sealAcct } = rig();
    const fields = JSON.stringify({
      region: 'eu-west-1',
      accessKeyId: 'AKIAEXAMPLE12345',
      secretAccessKey: 'secretsecretsecret1',
    });
    const r = store.set({
      provider: 'bedrock',
      account: 'work',
      keyId: keys.publicKey.keyId,
      generation: 100,
      ciphertext: await sealAcct('bedrock', fields, 'work', 100),
      models: [],
    });
    expect(r.stored).toBe(true);
    expect(store.getBackend('bedrock', undefined, 'work')?.fields.region).toBe('eu-west-1');
    expect(store.getBackend('bedrock')).toBeUndefined();
    expect(store.reportBackends().map((b) => b.id)).toContain('bedrock');
  });

  it('Make main swaps the named account and the main key, re-sealed under their new names', async () => {
    const { keys, store, setAcct } = rig();
    store.set({
      provider: 'openai',
      keyId: keys.publicKey.keyId,
      generation: 50,
      ciphertext: await sealWs(keys, 'openai', 'sk-old-main', undefined, 50),
      models: [],
    });
    await setAcct('openai', 'work', 'sk-work-new', 60);
    expect(await store.promote('openai', 'work')).toEqual({ ok: true });
    expect(store.get('openai')?.apiKey).toBe('sk-work-new');
    expect(store.get('openai', undefined, 'work')?.apiKey).toBe('sk-old-main');
    // undone by doing it again
    expect(await store.promote('openai', 'work')).toEqual({ ok: true });
    expect(store.get('openai')?.apiKey).toBe('sk-old-main');
    expect(store.get('openai', undefined, 'work')?.apiKey).toBe('sk-work-new');
    // refuses a name that holds nothing
    expect(await store.promote('openai', 'ghost')).toMatchObject({ ok: false });
    // an old blob of the former main cannot be replayed over the swapped state
    expect(
      store.set({
        provider: 'openai',
        keyId: keys.publicKey.keyId,
        generation: 50,
        ciphertext: await sealWs(keys, 'openai', 'sk-old-main', undefined, 50),
        models: [],
      }),
    ).toMatchObject({ stored: false });
  });

  it('Make main with no main key yet just moves the key', async () => {
    const { store, setAcct } = rig();
    await setAcct('google', 'work', 'AIza-work-key');
    expect(await store.promote('google', 'work')).toEqual({ ok: true });
    expect(store.get('google')?.apiKey).toBe('AIza-work-key');
    expect(store.accountNames()).toEqual([]);
  });

  it('keeps at most 20 named accounts', async () => {
    const { setAcct } = rig();
    for (let i = 0; i < 20; i++) expect((await setAcct('openai', `a${i}`, `sk-${i}-zzzz`)).stored).toBe(true);
    expect(await setAcct('openai', 'one-too-many', 'sk-zzzz-1234')).toMatchObject({
      stored: false,
      error: expect.stringMatching(/at most 20/),
    });
    // an existing one can still be replaced
    expect((await setAcct('openai', 'a3', 'sk-new-zzzz', 200)).stored).toBe(true);
  });
});
