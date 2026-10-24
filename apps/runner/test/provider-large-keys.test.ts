import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealLarge } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { parseServiceAccount, serviceAccountFetch } from '../src/direct/google-sa.ts';
import { ProviderStore } from '../src/direct/store.ts';
import { RunnerKeys } from '../src/secrets/keys.ts';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const saJson = JSON.stringify({
  type: 'service_account',
  project_id: 'p',
  private_key_id: 'abc',
  private_key: pem,
  client_email: 'bot@p.iam.gserviceaccount.com',
  token_uri: 'https://oauth2.googleapis.com/token',
});

function keys() {
  const dir = mkdtempSync(join(tmpdir(), 'rk-'));
  return { dir, keys: new RunnerKeys(join(dir, 'runner-key.pem')) };
}

describe('hybrid sealing of provider credentials', () => {
  it('round-trips a service-account JSON far over the RSA limit, through the provider store', async () => {
    const { dir, keys: k } = keys();
    expect(saJson.length).toBeGreaterThan(1500);
    const sealed = await sealLarge(k.publicKey.publicKey, saJson);
    expect(sealed.startsWith('h1.')).toBe(true);
    expect(sealed).not.toContain('service_account');
    const store = new ProviderStore({ file: join(dir, 'providers.json'), keys: k });
    expect(
      store.set({ provider: 'google', keyId: k.publicKey.keyId, ciphertext: sealed, models: [] }),
    ).toEqual({
      stored: true,
    });
    expect(store.get('google')?.apiKey).toBe(saJson);
  });
  it('still opens a legacy RSA-only blob', async () => {
    const { dir, keys: k } = keys();
    const { publicEncrypt, constants, createPublicKey } = await import('node:crypto');
    const spki = Buffer.from(k.publicKey.publicKey, 'base64');
    const legacy = publicEncrypt(
      {
        key: createPublicKey({ key: spki, format: 'der', type: 'spki' }),
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      Buffer.from('sk-old-key'),
    ).toString('base64');
    const store = new ProviderStore({ file: join(dir, 'providers.json'), keys: k });
    expect(
      store.set({ provider: 'openai', keyId: k.publicKey.keyId, ciphertext: legacy, models: [] }).stored,
    ).toBe(true);
    expect(store.get('openai')?.apiKey).toBe('sk-old-key');
    expect(k.decryptAny(legacy)).toBe('sk-old-key');
  });
  it('rejects a damaged hybrid blob without storing anything', async () => {
    const { dir, keys: k } = keys();
    const sealed = await sealLarge(k.publicKey.publicKey, 'sk-x');
    const bad = `${sealed.slice(0, -6)}AAAAAA`;
    const store = new ProviderStore({ file: join(dir, 'providers.json'), keys: k });
    expect(
      store.set({ provider: 'openai', keyId: k.publicKey.keyId, ciphertext: bad, models: [] }).stored,
    ).toBe(false);
  });
});

describe('a service account as the Gemini credential', () => {
  it('is recognised only when it is a service-account key', () => {
    expect(parseServiceAccount(saJson)?.client_email).toBe('bot@p.iam.gserviceaccount.com');
    expect(parseServiceAccount('AIzaSyKEY')).toBeUndefined();
    expect(parseServiceAccount('{"type":"authorized_user"}')).toBeUndefined();
  });
  it('exchanges a signed assertion for a bearer token, caches it, and drops the api-key header', async () => {
    const sa = parseServiceAccount(saJson) as NonNullable<ReturnType<typeof parseServiceAccount>>;
    const seen: Array<{ url: string; auth: string | null; key: string | null }> = [];
    let minted = 0;
    const base = async (url: string, init: RequestInit = {}) => {
      const h = new Headers(init.headers);
      if (url.includes('oauth2')) {
        minted++;
        expect(String(init.body)).toContain('jwt-bearer');
        return new Response(JSON.stringify({ access_token: 'ya29.tok', expires_in: 3600 }));
      }
      seen.push({ url, auth: h.get('authorization'), key: h.get('x-goog-api-key') });
      return new Response('{}');
    };
    const f = serviceAccountFetch(sa, base);
    await f('https://generativelanguage.googleapis.com/v1/x', {
      headers: { 'x-goog-api-key': 'service-account' },
    });
    await f('https://generativelanguage.googleapis.com/v1/y');
    expect(minted).toBe(1);
    expect(seen.map((s) => [s.auth, s.key])).toEqual([
      ['Bearer ya29.tok', null],
      ['Bearer ya29.tok', null],
    ]);
  });
  it('refuses a token endpoint that is not Google’s', async () => {
    const sa = {
      ...(parseServiceAccount(saJson) as object),
      token_uri: 'https://evil.example/token',
    } as never;
    const f = serviceAccountFetch(sa, async () => new Response('{}'));
    await expect(f('https://x/')).rejects.toThrow(/not Google/);
  });
});
