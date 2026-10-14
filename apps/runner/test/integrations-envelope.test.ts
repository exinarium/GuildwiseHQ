import { constants, createCipheriv, createPublicKey, publicEncrypt, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type IntegrationKindId, integrationAad, sealForRunner } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { ReplayCache } from '../src/integrations/seen.ts';
import { EnvelopeError, RunnerKeys } from '../src/secrets/keys.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

const WS = '11111111-1111-4111-8111-111111111111';
const SECRET = 'jira-token-VALUE-0123456789abcdef';

function keys() {
  const dir = tmp('aom-env-');
  return { dir, keys: new RunnerKeys(join(dir, 'secrets', 'runner-key.pem')) };
}

async function seal(
  k: RunnerKeys,
  over: Partial<Parameters<typeof sealForRunner>[0]> = {},
  fields: Record<string, string> = { token: SECRET, email: 'me@acme.com' },
) {
  return sealForRunner({
    publicKey: k.publicKey.publicKey,
    keyId: k.publicKey.keyId,
    workstationId: WS,
    ref: 'req-1',
    kind: 'jira',
    instance: '',
    op: 'connect',
    method: 'token',
    fields,
    serverTimeMs: Date.now(),
    ...over,
  });
}

const outer = (over: Partial<Parameters<RunnerKeys['open']>[1]> = {}) => ({
  workstationId: WS,
  ref: 'req-1',
  kind: 'jira' as IntegrationKindId,
  instance: '',
  op: 'connect' as const,
  ...over,
});

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof EnvelopeError ? e.code : `other:${String(e)}`;
  }
  return undefined;
};

describe('integration envelope (browser seals, runner opens)', () => {
  it('round-trips the fields the browser sealed', async () => {
    const { keys: k } = keys();
    const env = await seal(k);
    const plain = k.open(env, outer());
    expect(plain.fields).toEqual({ token: SECRET, email: 'me@acme.com' });
    expect(plain.method).toBe('token');
  });

  it('refuses a ciphertext moved to another workstation, kind, instance, request or op', async () => {
    const { keys: k } = keys();
    const env = await seal(k);
    expect(code(() => k.open(env, outer({ workstationId: 'other' })))).toBe('decrypt');
    expect(code(() => k.open(env, outer({ kind: 'github' })))).toBe('decrypt');
    expect(code(() => k.open(env, outer({ instance: 'x' })))).toBe('decrypt');
    expect(code(() => k.open(env, outer({ ref: 'req-2' })))).toBe('decrypt');
    expect(code(() => k.open(env, outer({ op: 'input' })))).toBe('decrypt');
  });

  it('refuses inner fields that differ from the outer ones even when the AAD matches', async () => {
    const { keys: k } = keys();
    // an envelope whose AAD says github but whose plaintext says jira: built by hand with the right key
    const aes = randomBytes(32);
    const iv = randomBytes(12);
    const aad = integrationAad({
      workstationId: WS,
      ref: 'req-1',
      kind: 'github',
      instance: 'github.com',
      op: 'connect',
    });
    const body = JSON.stringify({
      v: 1,
      ref: 'req-1',
      workstationId: WS,
      kind: 'jira',
      instance: '',
      op: 'connect',
      exp: Date.now() + 60_000,
      fields: { token: 'x' },
    });
    const c = createCipheriv('aes-256-gcm', aes, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(body), c.final(), c.getAuthTag()]);
    const pub = createPublicKey({
      key: Buffer.from(k.publicKey.publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
    const wrapped = publicEncrypt(
      { key: pub, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      aes,
    );
    const env = {
      v: 1 as const,
      alg: 'RSA-OAEP-256+A256GCM' as const,
      keyId: k.publicKey.keyId,
      wrappedKey: wrapped.toString('base64'),
      iv: iv.toString('base64'),
      ct: ct.toString('base64'),
    };
    expect(code(() => k.open(env, outer({ kind: 'github', instance: 'github.com' })))).toBe('mismatch');
  });

  it('refuses an expired envelope, one valid for too long, another key id and damaged data', async () => {
    const { keys: k } = keys();
    const old = await seal(k, { serverTimeMs: Date.now() - 11 * 60_000 });
    expect(code(() => k.open(old, outer()))).toBe('expired');
    const far = await seal(k, { serverTimeMs: Date.now() + 30 * 60_000 });
    expect(code(() => k.open(far, outer()))).toBe('too_far');
    const fresh = await seal(k);
    expect(code(() => k.open({ ...fresh, keyId: 'deadbeefdeadbeef' }, outer()))).toBe('key');
    const flipped = Buffer.from(fresh.ct, 'base64');
    flipped[3] = (flipped[3] as number) ^ 0xff;
    expect(code(() => k.open({ ...fresh, ct: flipped.toString('base64') }, outer()))).toBe('decrypt');
    // sealed for another runner's key
    const other = keys().keys;
    const foreign = await seal(other, {}, { token: 'x' });
    expect(code(() => k.open({ ...foreign, keyId: k.publicKey.keyId }, outer()))).toBe('decrypt');
  });

  it('error messages never contain the plaintext', async () => {
    const { keys: k } = keys();
    const env = await seal(k, { serverTimeMs: 0 });
    try {
      k.open(env, outer());
    } catch (e) {
      expect(String(e)).not.toContain(SECRET);
    }
  });
});

describe('replay cache', () => {
  it('accepts a ref once, also after a restart, until it expires', () => {
    const dir = tmp('aom-seen-');
    const file = join(dir, 'secrets', 'integration-seen.json');
    let now = 1_000_000;
    const a = new ReplayCache(file, () => now);
    expect(a.claim('r1', now + 600_000)).toBe(true);
    expect(a.claim('r1', now + 600_000)).toBe(false);
    const b = new ReplayCache(file, () => now); // a restarted runner
    expect(b.claim('r1', now + 600_000)).toBe(false);
    expect(b.claim('r2', now + 600_000)).toBe(true);
    now += 700_000;
    expect(new ReplayCache(file, () => now).claim('r1', now + 600_000)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(file) && readFileSync(file, 'utf8')).toContain('r1');
  });
});
