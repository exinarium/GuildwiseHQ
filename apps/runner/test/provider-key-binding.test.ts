import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ProviderKeyId, sealLarge, sealResealApproval } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { ProviderStore } from '../src/direct/store.ts';
import { RunnerKeys } from '../src/secrets/keys.ts';
import { sealOrg, sealWs } from './seal-helpers.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const ORG2 = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';

function rig(now?: () => number) {
  const dir = mkdtempSync(join(tmpdir(), 'bind-'));
  const keys = new RunnerKeys(join(dir, 'secrets', 'runner-key.pem'));
  const store = new ProviderStore({
    file: join(dir, 'secrets', 'providers.json'),
    keys,
    ...(now ? { now } : {}),
  });
  const setOrg = async (
    provider: ProviderKeyId,
    secret: string,
    o: { generation?: number; sealedGeneration?: number; baseUrl?: string; sealedUrl?: string } = {},
  ) =>
    store.set({
      provider,
      keyId: keys.publicKey.keyId,
      source: 'org',
      orgId: ORG,
      generation: o.generation ?? 1,
      ciphertext: await sealOrg(
        keys,
        ORG,
        provider,
        secret,
        o.sealedGeneration ?? o.generation ?? 1,
        o.sealedUrl ?? o.baseUrl,
      ),
      ...(o.baseUrl ? { baseUrl: o.baseUrl } : {}),
      models: [],
    });
  return { dir, keys, store, setOrg };
}

describe('provider keys are bound to what they were sealed for', () => {
  it('refuses an organization OpenAI key relabelled as an openai-compatible key aimed at another host', async () => {
    const { keys, store } = rig();
    const sealed = await sealOrg(keys, ORG, 'openai', 'sk-org-openai-1234');
    const relabel = store.set({
      provider: 'openai-compatible',
      keyId: keys.publicKey.keyId,
      source: 'org',
      orgId: ORG,
      generation: 1,
      ciphertext: sealed,
      baseUrl: 'https://evil.example.com/v1',
      models: [],
    });
    expect(relabel).toMatchObject({ stored: false, error: expect.stringMatching(/sealed for another/) });
    expect(store.get('openai-compatible', ORG)).toBeUndefined();
    // the same blob in another organization's slot is refused too
    expect(
      store.set({
        provider: 'openai',
        keyId: keys.publicKey.keyId,
        source: 'org',
        orgId: ORG2,
        generation: 1,
        ciphertext: sealed,
        models: [],
      }).stored,
    ).toBe(false);
    // and an organization blob cannot be stored as the workstation's own key
    expect(
      store.set({ provider: 'openai', keyId: keys.publicKey.keyId, ciphertext: sealed, models: [] }).stored,
    ).toBe(false);
  });

  it('refuses a key sealed for one endpoint when the command names another', async () => {
    const { setOrg, store } = rig();
    const r = await setOrg('openai-compatible', 'sk-compat', {
      baseUrl: 'https://evil.example.com/v1',
      sealedUrl: 'https://good.example.com/v1',
    });
    expect(r.stored).toBe(false);
    expect(store.get('openai-compatible', ORG)).toBeUndefined();
    expect(
      (await setOrg('openai-compatible', 'sk-compat', { baseUrl: 'https://good.example.com/v1' })).stored,
    ).toBe(true);
    expect(store.get('openai-compatible', ORG)).toMatchObject({
      apiKey: 'sk-compat',
      baseUrl: 'https://good.example.com/v1',
      source: 'org',
    });
  });

  it('refuses a backend credential whose own endpoint differs from the one it is bound to', async () => {
    const { keys, store } = rig();
    const fields = JSON.stringify({ baseUrl: 'https://evil.example.com', authToken: 'tok-123456' });
    const r = store.set({
      provider: 'gateway',
      keyId: keys.publicKey.keyId,
      source: 'org',
      orgId: ORG,
      generation: 1,
      // sealed with no endpoint in the binding, but the credential points at a host
      ciphertext: await sealOrg(keys, ORG, 'gateway', fields, 1),
      models: ['m'],
    });
    expect(r.stored).toBe(false);
    // bound to the endpoint it names: accepted
    const ok = store.set({
      provider: 'gateway',
      keyId: keys.publicKey.keyId,
      source: 'org',
      orgId: ORG,
      generation: 1,
      baseUrl: 'https://evil.example.com',
      ciphertext: await sealOrg(keys, ORG, 'gateway', fields, 1, 'https://evil.example.com'),
      models: ['m'],
    });
    expect(ok.stored).toBe(true);
    // the command claims a different endpoint than the blob's binding: refused
    const lie = store.set({
      provider: 'gateway',
      keyId: keys.publicKey.keyId,
      source: 'org',
      orgId: ORG,
      generation: 2,
      baseUrl: 'https://good.example.com',
      ciphertext: await sealOrg(keys, ORG, 'gateway', fields, 2, 'https://evil.example.com'),
      models: ['m'],
    });
    expect(lie.stored).toBe(false);
  });

  it('refuses the older, unbound forms for an organization key; accepts them for the workstation’s own, with a warning', async () => {
    const { keys, store } = rig();
    const h1 = await sealLarge(keys.publicKey.publicKey, 'sk-legacy-org-key');
    const org = store.set({
      provider: 'openai',
      keyId: keys.publicKey.keyId,
      source: 'org',
      orgId: ORG,
      generation: 1,
      ciphertext: h1,
      models: [],
    });
    expect(org).toMatchObject({ stored: false, error: expect.stringMatching(/enter the key again/) });
    const own = store.set({ provider: 'openai', keyId: keys.publicKey.keyId, ciphertext: h1, models: [] });
    expect(own).toMatchObject({ stored: true, warning: expect.stringMatching(/older form/) });
    expect(store.get('openai')?.apiKey).toBe('sk-legacy-org-key');
    // a bound workstation key cannot be replaced by an unbound blob (no downgrade)
    expect(
      store.set({
        provider: 'anthropic',
        keyId: keys.publicKey.keyId,
        ciphertext: await sealWs(keys, 'anthropic', 'a-1'),
        models: [],
      }).stored,
    ).toBe(true);
    expect(
      store.set({
        provider: 'anthropic',
        keyId: keys.publicKey.keyId,
        ciphertext: await sealLarge(keys.publicKey.publicKey, 'a-2'),
        models: [],
      }).stored,
    ).toBe(false);
    expect(store.get('anthropic')?.apiKey).toBe('a-1');
  });

  it('refuses a workstation key relabelled to another provider or endpoint', async () => {
    const { keys, store } = rig();
    const sealed = await sealWs(keys, 'openai', 'sk-own-key-1234');
    expect(
      store.set({
        provider: 'openai-compatible',
        keyId: keys.publicKey.keyId,
        ciphertext: sealed,
        baseUrl: 'https://evil.example.com/v1',
        models: [],
      }).stored,
    ).toBe(false);
    expect(
      store.set({ provider: 'openai', keyId: keys.publicKey.keyId, ciphertext: sealed, models: [] }),
    ).toEqual({
      stored: true,
    });
  });

  it('keeps a key stored by one organization out of reach of another, and of a call that names none', async () => {
    const { setOrg, store, keys } = rig();
    await setOrg('openai', 'sk-org-only-5555');
    expect(store.get('openai', ORG)?.apiKey).toBe('sk-org-only-5555');
    // finding 13: no organization named -> the workstation's own key only; the single org holding a key is not guessed
    expect(store.get('openai')).toBeUndefined();
    expect(store.get('openai', ORG2)).toBeUndefined();
    expect(store.configured()).toEqual([]);
    expect(store.sourceOf('openai')).toBeNull();
    expect(store.getBackend('gateway')).toBeUndefined();
    // availability reports (names only) still see that a key is held
    expect(store.holds('openai')).toBe(true);
    expect(store.reportConfigured().map((c) => [c.id, 'apiKey' in c])).toEqual([['openai', false]]);
    // a workstation key is used with or without an organization
    store.set({
      provider: 'openai',
      keyId: keys.publicKey.keyId,
      ciphertext: await sealWs(keys, 'openai', 'sk-own-9'),
      models: [],
    });
    expect(store.get('openai')?.apiKey).toBe('sk-own-9');
    expect(store.get('openai', ORG)?.apiKey).toBe('sk-own-9');
  });
});

describe('organization key generations', () => {
  it('needs a generation, and the generation is part of what the blob is bound to', async () => {
    const { setOrg, keys, store } = rig();
    expect(
      store.set({
        provider: 'openai',
        keyId: keys.publicKey.keyId,
        source: 'org',
        orgId: ORG,
        ciphertext: await sealOrg(keys, ORG, 'openai', 'sk-x-1234', 0),
        models: [],
      }).stored,
    ).toBe(false);
    // sealed for generation 1, delivered as generation 2
    expect((await setOrg('openai', 'sk-x-1234', { generation: 2, sealedGeneration: 1 })).stored).toBe(false);
    expect((await setOrg('openai', 'sk-x-1234', { generation: 1 })).stored).toBe(true);
  });

  it('refuses a replay of a revoked generation, and an older one after a replacement', async () => {
    const { setOrg, store } = rig();
    expect((await setOrg('openai', 'sk-gen-one', { generation: 1 })).stored).toBe(true);
    // replaced by generation 2; the old blob replayed is refused
    expect((await setOrg('openai', 'sk-gen-two', { generation: 2 })).stored).toBe(true);
    expect((await setOrg('openai', 'sk-gen-one', { generation: 1 })).stored).toBe(false);
    expect(store.get('openai', ORG)?.apiKey).toBe('sk-gen-two');
    // revoked at generation 2: neither 1 nor 2 comes back, 3 does
    store.clearPayload({ provider: 'openai', source: 'org', orgId: ORG, generation: 2 });
    expect(store.get('openai', ORG)).toBeUndefined();
    expect((await setOrg('openai', 'sk-gen-two', { generation: 2 })).stored).toBe(false);
    expect((await setOrg('openai', 'sk-gen-one', { generation: 1 })).stored).toBe(false);
    expect((await setOrg('openai', 'sk-gen-three', { generation: 3 })).stored).toBe(true);
    expect(store.get('openai', ORG)?.apiKey).toBe('sk-gen-three');
  });

  it('remembers a revocation for a workstation that never held the key, across a restart', async () => {
    const { setOrg, store, keys, dir } = rig();
    store.clearPayload({ provider: 'openai', source: 'org', orgId: ORG, generation: 4 });
    const again = new ProviderStore({ file: join(dir, 'secrets', 'providers.json'), keys });
    expect((await setOrg('openai', 'sk-old', { generation: 4 })).stored).toBe(false);
    expect(again.get('openai', ORG)).toBeUndefined();
    expect((await setOrg('openai', 'sk-new', { generation: 5 })).stored).toBe(true);
  });
});

describe('an organization endpoint on a member’s workstation', () => {
  it('must be https to a public host, or listed by the workstation’s owner; loopback is not exempt', async () => {
    const { setOrg, store } = rig();
    for (const url of ['http://localhost:11434/v1', 'http://127.0.0.1:11434/v1', 'http://example.com/v1']) {
      const r = await setOrg('openai-compatible', 'sk-c', { baseUrl: url });
      expect(r.stored, url).toBe(false);
    }
    expect(
      (await setOrg('openai-compatible', 'sk-c', { baseUrl: 'https://llm.example.com/v1' })).stored,
    ).toBe(true);
    // listed by the owner: plain http to a LAN host is fine
    expect(store.setEndpoints(['192.168.1.12:11434']).stored).toBe(true);
    expect(
      (await setOrg('openai-compatible', 'sk-c', { baseUrl: 'http://192.168.1.12:11434/v1', generation: 2 }))
        .stored,
    ).toBe(true);
    // removing the entry stops it working
    store.setEndpoints([]);
    expect(store.get('openai-compatible', ORG)).toBeUndefined();
  });

  it('applies to a backend credential’s endpoint too', async () => {
    const { keys, store } = rig();
    const fields = JSON.stringify({ baseUrl: 'http://127.0.0.1:4000', authToken: 'tok-123456' });
    const r = store.set({
      provider: 'gateway',
      keyId: keys.publicKey.keyId,
      source: 'org',
      orgId: ORG,
      generation: 1,
      baseUrl: 'http://127.0.0.1:4000',
      ciphertext: await sealOrg(keys, ORG, 'gateway', fields, 1, 'http://127.0.0.1:4000'),
      models: ['m'],
    });
    expect(r.stored).toBe(false);
  });
});

describe('provider.key.reseal needs the approval of an admin, made in their browser', () => {
  async function pair() {
    const a = rig();
    const b = rig();
    await a.setOrg('openai', 'sk-share-me-3333', { generation: 3 });
    const approval = (o: Partial<Parameters<typeof sealResealApproval>[0]> = {}) =>
      sealResealApproval({
        source: a.keys.publicKey,
        target: b.keys.publicKey,
        orgId: ORG,
        provider: 'openai',
        generation: 3,
        approvedBy: ADMIN,
        ...o,
      });
    const payload = (approvalText: string | undefined, o: Record<string, unknown> = {}) => ({
      provider: 'openai' as const,
      orgId: ORG,
      targetKeyId: b.keys.publicKey.keyId,
      targetPublicKey: b.keys.publicKey.publicKey,
      ...(approvalText ? { approval: approvalText } : {}),
      ...o,
    });
    return { a, b, approval, payload };
  }

  it('shares to the approved key only, bound to the organization, endpoint and generation', async () => {
    const { a, b, approval, payload } = await pair();
    const out = await a.store.reseal(payload(await approval()));
    expect(out.ok).toBe(true);
    expect(out.generation).toBe(3);
    expect(JSON.stringify(out)).not.toContain('sk-share-me-3333');
    // the target takes it as generation 3 of this organization, and nothing else
    const set = (g: number, orgId = ORG) =>
      b.store.set({
        provider: 'openai',
        keyId: b.keys.publicKey.keyId,
        source: 'org',
        orgId,
        generation: g,
        ciphertext: out.ciphertext as string,
        models: [],
      });
    expect(set(4).stored).toBe(false);
    expect(set(3, ORG2).stored).toBe(false);
    expect(set(3).stored).toBe(true);
    expect(b.store.get('openai', ORG)?.apiKey).toBe('sk-share-me-3333');
    expect(() => a.keys.decryptAny(out.ciphertext as string)).toThrow();
  });

  it('refuses without an approval, and with one the server made up', async () => {
    const { a, payload } = await pair();
    expect(await a.store.reseal(payload(undefined))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/approval/),
    });
    // anyone can seal to the runner's public key, but not with the right binding
    const forged = await sealLarge(a.keys.publicKey.publicKey, JSON.stringify({ v: 1, orgId: ORG }));
    expect((await a.store.reseal(payload(forged))).ok).toBe(false);
  });

  it('refuses a target key that is not the one the admin approved', async () => {
    const { a, approval, payload } = await pair();
    const evil = rig();
    const text = await approval();
    // a different public key under the approved key id
    const swapped = await a.store.reseal(payload(text, { targetPublicKey: evil.keys.publicKey.publicKey }));
    expect(swapped).toMatchObject({
      ok: false,
      error: expect.stringMatching(/not the one that was approved/),
    });
    // a different key id for the approved public key
    const otherId = await a.store.reseal(
      payload(await approval(), { targetKeyId: evil.keys.publicKey.keyId }),
    );
    expect(otherId.ok).toBe(false);
    // the whole target replaced
    const replaced = await a.store.reseal(
      payload(await approval(), {
        targetKeyId: evil.keys.publicKey.keyId,
        targetPublicKey: evil.keys.publicKey.publicKey,
      }),
    );
    expect(replaced.ok).toBe(false);
    // an id that does not match the public key it comes with is refused even before the approval is looked at
    const lie = await a.store.reseal(
      payload(
        await sealResealApproval({
          source: a.keys.publicKey,
          target: { keyId: evil.keys.publicKey.keyId, publicKey: evil.keys.publicKey.publicKey },
          orgId: ORG,
          provider: 'openai',
          generation: 3,
          approvedBy: ADMIN,
        }),
        { targetKeyId: 'deadbeefdeadbeef', targetPublicKey: evil.keys.publicKey.publicKey },
      ),
    );
    expect(lie.ok).toBe(false);
  });

  it('refuses a stale generation, another organization or provider, an expired approval and a replay', async () => {
    let t = 1_000_000;
    const a = rig(() => t);
    const b = rig();
    await a.setOrg('openai', 'sk-share-me-3333', { generation: 3 });
    const mk = (o: Partial<Parameters<typeof sealResealApproval>[0]> = {}) =>
      sealResealApproval({
        source: a.keys.publicKey,
        target: b.keys.publicKey,
        orgId: ORG,
        provider: 'openai',
        generation: 3,
        approvedBy: ADMIN,
        now: t,
        ...o,
      });
    const payload = (approval: string, o: Record<string, unknown> = {}) => ({
      provider: 'openai' as const,
      orgId: ORG,
      targetKeyId: b.keys.publicKey.keyId,
      targetPublicKey: b.keys.publicKey.publicKey,
      approval,
      ...o,
    });
    expect((await a.store.reseal(payload(await mk({ generation: 2 })))).ok).toBe(false);
    expect((await a.store.reseal(payload(await mk({ orgId: ORG2 })))).ok).toBe(false);
    expect((await a.store.reseal(payload(await mk({ provider: 'google' })))).ok).toBe(false);
    // an approval for another source workstation does not open here
    const other = rig();
    expect(
      (
        await a.store.reseal(
          payload(
            await sealResealApproval({
              source: other.keys.publicKey,
              target: b.keys.publicKey,
              orgId: ORG,
              provider: 'openai',
              generation: 3,
              approvedBy: ADMIN,
              now: t,
            }),
          ),
        )
      ).ok,
    ).toBe(false);
    // good once, never twice
    const good = await mk();
    expect((await a.store.reseal(payload(good))).ok).toBe(true);
    expect(await a.store.reseal(payload(good))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/already used/),
    });
    // expired
    const old = await mk();
    t += 20 * 60_000;
    expect(await a.store.reseal(payload(old))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/expired/),
    });
  });

  it('never shares a workstation’s own key, and not a key the runner does not hold', async () => {
    const { a, b, approval, payload } = await pair();
    a.store.set({
      provider: 'google',
      keyId: a.keys.publicKey.keyId,
      ciphertext: await sealWs(a.keys, 'google', 'own-google'),
      models: [],
    });
    expect(
      (await a.store.reseal({ ...payload(await approval({ provider: 'google' })), provider: 'google' })).ok,
    ).toBe(false);
    expect((await b.store.reseal(payload(await approval()))).ok).toBe(false);
  });
});

describe('a workstation’s own key has a generation and a revocation floor (Q73)', () => {
  const setOwn = async (
    r: ReturnType<typeof rig>,
    secret: string,
    o: { generation?: number; sealedGeneration?: number } = {},
  ) =>
    r.store.set({
      provider: 'openai',
      keyId: r.keys.publicKey.keyId,
      ciphertext: await sealWs(r.keys, 'openai', secret, undefined, o.sealedGeneration ?? o.generation ?? 0),
      ...(o.generation ? { generation: o.generation } : {}),
      models: [],
    });

  it('binds the generation into the blob: the same blob with another generation does not open', async () => {
    const r = rig();
    expect(await setOwn(r, 'sk-1', { generation: 100 })).toEqual({ stored: true });
    const bad = await setOwn(r, 'sk-1', { generation: 101, sealedGeneration: 100 });
    expect(bad.stored).toBe(false);
    expect(bad.error).toMatch(/could not be opened/);
    // a blob sealed with a generation but sent without one does not open either
    const missing = await setOwn(r, 'sk-1', { sealedGeneration: 100 });
    expect(missing.stored).toBe(false);
  });

  it('refuses a replay of a removed key, an older one after a replacement, and survives a restart', async () => {
    const r = rig();
    expect(await setOwn(r, 'sk-1', { generation: 100 })).toEqual({ stored: true });
    expect(await setOwn(r, 'sk-2', { generation: 200 })).toEqual({ stored: true });
    // the first blob replayed after it was replaced
    const old = await setOwn(r, 'sk-1', { generation: 100 });
    expect(old.stored).toBe(false);
    expect(old.error).toMatch(/newer version/);
    // the same version again (re-entering the key) is fine
    expect(await setOwn(r, 'sk-2', { generation: 200 })).toEqual({ stored: true });
    // removed: neither it nor anything older comes back
    r.store.clear('openai');
    expect(r.store.get('openai')).toBeUndefined();
    const replay = await setOwn(r, 'sk-2', { generation: 200 });
    expect(replay.stored).toBe(false);
    expect(replay.error).toMatch(/removed or replaced/);
    expect((await setOwn(r, 'sk-1', { generation: 100 })).stored).toBe(false);
    // a restart remembers it
    const again = new ProviderStore({ file: join(r.dir, 'secrets', 'providers.json'), keys: r.keys });
    expect(
      again.set({
        provider: 'openai',
        keyId: r.keys.publicKey.keyId,
        ciphertext: await sealWs(r.keys, 'openai', 'sk-2', undefined, 200),
        generation: 200,
        models: [],
      }).stored,
    ).toBe(false);
    // a genuinely newer entry is accepted
    expect(await setOwn(r, 'sk-3', { generation: 201 })).toEqual({ stored: true });
    expect(r.store.get('openai')?.apiKey).toBe('sk-3');
  });

  it('still accepts a key with no generation until a versioned one is stored (no downgrade)', async () => {
    const r = rig();
    const legacy = await setOwn(r, 'sk-old');
    expect(legacy.stored).toBe(true);
    expect(await setOwn(r, 'sk-new', { generation: 300 })).toEqual({ stored: true });
    const down = await setOwn(r, 'sk-old');
    expect(down.stored).toBe(false);
    expect(down.error).toMatch(/versioned key is already stored/);
    expect(r.store.get('openai')?.apiKey).toBe('sk-new');
  });
});
