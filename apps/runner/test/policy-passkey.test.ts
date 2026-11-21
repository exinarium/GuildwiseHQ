import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkPasskeyAssertion, newPasskeyChallenge } from '../src/policy/passkey.ts';
import { PASSKEY_KINDS, passkeyMayApprove } from '../src/policy/passkey-kinds.ts';
import type { TrustedPasskey } from '../src/policy/schema.ts';

const RP = 'hq.example';
const ORIGIN = 'https://hq.example';
const NOW = Date.parse('2026-11-21T10:00:00.000Z');
const HASH = 'a'.repeat(64);

function authenticator(alg: -7 | -8 | -257) {
  const kp =
    alg === -7
      ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
      : alg === -8
        ? generateKeyPairSync('ed25519')
        : generateKeyPairSync('rsa', { modulusLength: 2048 });
  const trusted: TrustedPasskey = {
    credentialId: `cred${alg < 0 ? -alg : alg}`,
    publicKey: (kp.publicKey as KeyObject).export({ type: 'spki', format: 'der' }).toString('base64'),
    alg,
    rpId: RP,
    origin: ORIGIN,
    signCount: 0,
  };
  return { trusted, privateKey: kp.privateKey as KeyObject };
}

function assertion(
  a: ReturnType<typeof authenticator>,
  challenge: string,
  o: { origin?: string; rpId?: string; flags?: number; count?: number; type?: string; tamper?: boolean } = {},
) {
  const client = Buffer.from(
    JSON.stringify({
      type: o.type ?? 'webauthn.get',
      challenge,
      origin: o.origin ?? ORIGIN,
      crossOrigin: false,
    }),
  );
  const auth = Buffer.alloc(37);
  createHash('sha256')
    .update(o.rpId ?? RP)
    .digest()
    .copy(auth, 0);
  auth[32] = o.flags ?? 0x05; // UP + UV
  auth.writeUInt32BE(o.count ?? 7, 33);
  const data = Buffer.concat([auth, createHash('sha256').update(client).digest()]);
  const sig = a.trusted.alg === -8 ? sign(null, data, a.privateKey) : sign('sha256', data, a.privateKey);
  if (o.tamper) sig.writeUInt8(sig.readUInt8(sig.length - 1) ^ 0xff, sig.length - 1);
  return {
    itemId: 'abc123',
    credentialId: a.trusted.credentialId,
    authenticatorData: auth.toString('base64url'),
    clientDataJSON: client.toString('base64url'),
    signature: sig.toString('base64url'),
  };
}

function item(kind: string) {
  const c = newPasskeyChallenge(HASH, NOW);
  return { kind, commandHash: HASH, passkey: { ...c, usedNonce: false } };
}

describe('passkey approvals, verified by the runner (R22)', () => {
  it('the hard-coded kinds are exactly a commit-only redeploy and a recipe write', () => {
    expect([...PASSKEY_KINDS]).toEqual(['deploy.commit_redeploy', 'recipe.write']);
    for (const k of [
      'deploy.exec',
      'devops.task',
      'devops.request',
      'sudo',
      'env.secret',
      'vault.configure',
      'release.sign',
      'installScripts',
    ])
      expect(passkeyMayApprove(k)).toBe(false);
  });

  for (const alg of [-7, -8, -257] as const)
    it(`a valid assertion (alg ${alg}) approves a commit-only redeploy and a recipe write`, () => {
      const a = authenticator(alg);
      for (const kind of ['deploy.commit_redeploy', 'recipe.write']) {
        const it = item(kind);
        const r = checkPasskeyAssertion({
          assertion: assertion(a, it.passkey.challenge),
          item: it,
          trusted: [a.trusted],
          signCounts: {},
          now: NOW,
        });
        expect(r).toEqual({ ok: true, credentialId: a.trusted.credentialId, signCount: 7 });
      }
    });

  it('the same assertion is refused for a DevOps grant, aom sudo, a changed deploy and installScripts', () => {
    const a = authenticator(-7);
    for (const kind of ['devops.grant', 'sudo', 'deploy.exec', 'installScripts', 'devops.task']) {
      const it = item(kind);
      const r = checkPasskeyAssertion({
        assertion: assertion(a, it.passkey.challenge),
        item: it,
        trusted: [a.trusted],
        signCounts: {},
        now: NOW,
      });
      expect(r.ok).toBe(false);
    }
  });

  it('refuses an untrusted passkey (an offer is not trust), a wrong origin, rpId, challenge, type, missing UV and a bad signature', () => {
    const a = authenticator(-7);
    const it = item('recipe.write');
    const check = (as: ReturnType<typeof assertion>, trusted = [a.trusted]) =>
      checkPasskeyAssertion({ assertion: as, item: it, trusted, signCounts: {}, now: NOW });
    expect(check(assertion(a, it.passkey.challenge), [])).toMatchObject({ ok: false, reason: /not trusted/ });
    expect(check(assertion(a, it.passkey.challenge, { origin: 'https://evil.example' }))).toMatchObject({
      ok: false,
    });
    expect(check(assertion(a, it.passkey.challenge, { rpId: 'evil.example' }))).toMatchObject({ ok: false });
    expect(check(assertion(a, 'another-challenge'))).toMatchObject({ ok: false });
    expect(check(assertion(a, it.passkey.challenge, { type: 'webauthn.create' }))).toMatchObject({
      ok: false,
    });
    expect(check(assertion(a, it.passkey.challenge, { flags: 0x01 }))).toMatchObject({
      ok: false,
      reason: /UV/,
    });
    expect(check(assertion(a, it.passkey.challenge, { tamper: true }))).toMatchObject({ ok: false });
  });

  it('refuses a replayed nonce, an expired challenge and a lower sign count', () => {
    const a = authenticator(-7);
    const it = item('recipe.write');
    const as = assertion(a, it.passkey.challenge, { count: 5 });
    const base = { assertion: as, trusted: [a.trusted], now: NOW };
    expect(
      checkPasskeyAssertion({
        ...base,
        item: { ...it, passkey: { ...it.passkey, usedNonce: true } },
        signCounts: {},
      }).ok,
    ).toBe(false);
    expect(checkPasskeyAssertion({ ...base, item: it, signCounts: {}, now: NOW + 6 * 60_000 }).ok).toBe(
      false,
    );
    expect(
      checkPasskeyAssertion({ ...base, item: it, signCounts: { [a.trusted.credentialId]: 9 } }),
    ).toMatchObject({
      ok: false,
      reason: /sign count/,
    });
  });

  it('a challenge only fits the item it was made for (command hash and nonce are bound in)', () => {
    const a = authenticator(-7);
    const it = item('recipe.write');
    const other = { ...it, commandHash: 'b'.repeat(64) };
    expect(
      checkPasskeyAssertion({
        assertion: assertion(a, it.passkey.challenge),
        item: other,
        trusted: [a.trusted],
        signCounts: {},
        now: NOW,
      }).ok,
    ).toBe(false);
  });
});
