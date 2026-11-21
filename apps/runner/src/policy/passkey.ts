import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import type { ApprovalPasskeyPayload } from '@aom/shared';
import { passkeyMayApprove } from './passkey-kinds.ts';
import type { TrustedPasskey } from './schema.ts';

/**
 * Passkey approvals for routine held items (R18-S2, R22), verified by the runner with `node:crypto` only. The server
 * relays the assertion; it never approves anything itself, and it can never add a trusted passkey: only
 * `guildwise-runner passkey trust` on this machine writes `policy.json` `passkeys[]`.
 */

export const PASSKEY_CHALLENGE_MS = 5 * 60_000;

const b64url = (b: Buffer): string => b.toString('base64url');

/** `base64url(sha256(commandHash || nonce || expiry))` (strings concatenated as UTF-8). */
export function passkeyChallenge(commandHash: string, nonce: string, expiresAt: string): string {
  return b64url(createHash('sha256').update(`${commandHash}${nonce}${expiresAt}`, 'utf8').digest());
}

export function newPasskeyChallenge(
  commandHash: string,
  now: number,
): { nonce: string; challenge: string; expiresAt: string } {
  const nonce = b64url(randomBytes(18));
  const expiresAt = new Date(now + PASSKEY_CHALLENGE_MS).toISOString();
  return { nonce, expiresAt, challenge: passkeyChallenge(commandHash, nonce, expiresAt) };
}

export interface PasskeyCheckInput {
  assertion: ApprovalPasskeyPayload;
  item: {
    kind: string;
    commandHash: string;
    passkey?: { nonce: string; challenge: string; expiresAt: string; usedNonce: boolean } | undefined;
  };
  trusted: readonly TrustedPasskey[];
  /** The highest sign count seen per credential id (kept beside the policy). */
  signCounts: Readonly<Record<string, number>>;
  now: number;
}

export type PasskeyCheck =
  | { ok: true; credentialId: string; signCount: number }
  | { ok: false; reason: string };

function keyFor(p: TrustedPasskey) {
  return createPublicKey({ key: Buffer.from(p.publicKey, 'base64'), format: 'der', type: 'spki' });
}

function verifySignature(p: TrustedPasskey, data: Buffer, signature: Buffer): boolean {
  const key = keyFor(p);
  try {
    if (p.alg === -8) return verify(null, data, key, signature);
    // ES256: DER-encoded ECDSA over SHA-256 (WebAuthn); RS256: RSASSA-PKCS1-v1_5 with SHA-256
    return verify('sha256', data, key, signature);
  } catch {
    return false;
  }
}

/** Every check of R18-S2 "Approval", in order; the first that fails is the reason. */
export function checkPasskeyAssertion(i: PasskeyCheckInput): PasskeyCheck {
  const { assertion: a, item } = i;
  if (!passkeyMayApprove(item.kind))
    return { ok: false, reason: `a passkey cannot approve ${item.kind}: approve it on the workstation` };
  const pk = item.passkey;
  if (!pk) return { ok: false, reason: 'no passkey challenge was published for this item' };
  if (pk.usedNonce) return { ok: false, reason: 'this challenge was already used' };
  if (Date.parse(pk.expiresAt) < i.now) return { ok: false, reason: 'the challenge expired' };
  if (pk.challenge !== passkeyChallenge(item.commandHash, pk.nonce, pk.expiresAt))
    return { ok: false, reason: 'the challenge does not belong to this item' };
  const trusted = i.trusted.find((t) => t.credentialId === a.credentialId);
  if (!trusted) return { ok: false, reason: 'the passkey is not trusted on this workstation' };

  let client: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  const clientRaw = Buffer.from(a.clientDataJSON, 'base64url');
  try {
    client = JSON.parse(clientRaw.toString('utf8'));
  } catch {
    return { ok: false, reason: 'clientDataJSON is not JSON' };
  }
  if (client.type !== 'webauthn.get') return { ok: false, reason: 'not a webauthn.get assertion' };
  if (client.challenge !== pk.challenge)
    return { ok: false, reason: 'the assertion is for another challenge' };
  if (client.origin !== trusted.origin)
    return {
      ok: false,
      reason: `origin ${String(client.origin)} is not the pinned origin ${trusted.origin}`,
    };
  if (client.crossOrigin === true) return { ok: false, reason: 'a cross-origin assertion is refused' };

  const auth = Buffer.from(a.authenticatorData, 'base64url');
  if (auth.length < 37) return { ok: false, reason: 'authenticatorData is too short' };
  const rpIdHash = createHash('sha256').update(trusted.rpId, 'utf8').digest();
  if (!auth.subarray(0, 32).equals(rpIdHash))
    return { ok: false, reason: 'the rpIdHash does not match the pinned rpId' };
  const flags = auth[32] as number;
  if (!(flags & 0x01)) return { ok: false, reason: 'user presence is missing' };
  if (!(flags & 0x04)) return { ok: false, reason: 'user verification (UV) is missing' };
  const signCount = auth.readUInt32BE(33);
  const seen = Math.max(i.signCounts[trusted.credentialId] ?? 0, trusted.signCount);
  if (signCount < seen || (seen > 0 && signCount === 0))
    return {
      ok: false,
      reason: `the sign count ${signCount} is lower than before (${seen}): a cloned authenticator?`,
    };

  const signed = Buffer.concat([auth, createHash('sha256').update(clientRaw).digest()]);
  if (!verifySignature(trusted, signed, Buffer.from(a.signature, 'base64url')))
    return { ok: false, reason: 'the signature does not verify' };
  return { ok: true, credentialId: trusted.credentialId, signCount };
}
