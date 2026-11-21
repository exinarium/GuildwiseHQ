import { createHash, createPublicKey, verify } from 'node:crypto';
import { parseMinisignPublicKey } from '@aom/shared';

/**
 * Verifies a minisign signature (R30) with `node:crypto` alone: no secret key is ever involved on the server.
 *
 * A `.minisig` file is four lines: an untrusted comment, base64(`alg`[2] || key id[8] || signature[64]), the trusted comment
 * and base64(global signature[64]). `alg` `Ed` signs the file's bytes, `ED` (minisign's default) signs BLAKE2b-512 of
 * them; the global signature covers signature || trusted comment, so the trusted comment cannot be swapped either.
 */

export type MinisignCheck =
  | { ok: true; keyId: string; trustedComment: string }
  | { ok: false; reason: 'malformed' | 'bad_public_key' | 'wrong_key' | 'bad_signature'; keyId?: string };

/** The key id a `.minisig` names (16 upper-case hex, as minisign prints it), or null when it is not one. */
export function minisigKeyId(minisig: string): string | null {
  const p = parseMinisig(minisig);
  return p ? p.keyId : null;
}

/** The public key line of a pasted `.pub` file (its last non-comment line), or the line itself. */
export function publicKeyLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('untrusted comment:'));
  return lines[lines.length - 1] ?? '';
}

function parseMinisig(text: string): {
  alg: string;
  keyId: string;
  signature: Buffer;
  trustedComment: string;
  global: Buffer;
} | null {
  const lines = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => l.length > 0);
  if (lines.length !== 4) return null;
  const [untrusted, sigLine, trusted, globalLine] = lines as [string, string, string, string];
  if (!untrusted.startsWith('untrusted comment:') || !trusted.startsWith('trusted comment: ')) return null;
  const b64 = /^[A-Za-z0-9+/]+={0,2}$/;
  if (!b64.test(sigLine) || !b64.test(globalLine)) return null;
  const sig = Buffer.from(sigLine, 'base64');
  const global = Buffer.from(globalLine, 'base64');
  if (sig.length !== 74 || global.length !== 64) return null;
  const alg = sig.subarray(0, 2).toString('latin1');
  if (alg !== 'Ed' && alg !== 'ED') return null;
  const keyId = Buffer.from(sig.subarray(2, 10)).reverse().toString('hex').toUpperCase();
  return {
    alg,
    keyId,
    signature: sig.subarray(10),
    trustedComment: trusted.slice('trusted comment: '.length),
    global,
  };
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Checks `minisig` over `message` with the public key line `publicKey` (`RW...`). */
export function verifyMinisign(publicKey: string, message: Buffer, minisig: string): MinisignCheck {
  const pk = parseMinisignPublicKey(publicKey);
  if (!pk) return { ok: false, reason: 'bad_public_key' };
  const sig = parseMinisig(minisig);
  if (!sig) return { ok: false, reason: 'malformed' };
  if (sig.keyId !== pk.keyId) return { ok: false, reason: 'wrong_key', keyId: sig.keyId };
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pk.publicKey)]),
    format: 'der',
    type: 'spki',
  });
  const signed = sig.alg === 'ED' ? createHash('blake2b512').update(message).digest() : message;
  if (!verify(null, signed, key, sig.signature))
    return { ok: false, reason: 'bad_signature', keyId: sig.keyId };
  const globalData = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, 'utf8')]);
  if (!verify(null, globalData, key, sig.global))
    return { ok: false, reason: 'bad_signature', keyId: sig.keyId };
  return { ok: true, keyId: sig.keyId, trustedComment: sig.trustedComment };
}
