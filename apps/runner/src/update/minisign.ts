import { createHash, createPublicKey, verify } from 'node:crypto';
import { isPlaceholderReleaseKey, parseMinisignPublicKey } from '@aom/shared';

/**
 * A minisign signature check with `node:crypto` only (R18-U, R22, R30): the runner verifies release manifests and
 * release artefacts itself, without a dependency and without the `minisign` binary.
 *
 * A `.minisig` file has four lines:
 *   untrusted comment: <text>
 *   base64(sig_alg[2] || key_id[8] || signature[64])     sig_alg `Ed` = over the message, `ED` = over BLAKE2b-512(message)
 *   trusted comment: <text>
 *   base64(global_signature[64])                          over signature || trusted comment bytes
 * Both signatures must verify; the trusted comment is therefore authentic too.
 */

export type MinisignResult =
  | { ok: true; keyId: string; trustedComment: string }
  | { ok: false; reason: string };

/** The key line of a minisign public key, from a `.pub` file's text or a bare `RW...` line. */
export function publicKeyLine(text: string): string {
  const lines = text
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('untrusted comment:'));
  return lines[lines.length - 1] ?? '';
}

function ed25519Key(raw: Uint8Array) {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(raw).toString('base64url') },
    format: 'jwk',
  });
}

export function verifyMinisign(message: Buffer | string, minisig: string, publicKey: string): MinisignResult {
  const line = publicKeyLine(publicKey);
  if (isPlaceholderReleaseKey(line)) return { ok: false, reason: 'the release key is the placeholder' };
  const pub = parseMinisignPublicKey(line);
  if (!pub) return { ok: false, reason: 'not a minisign public key' };
  const lines = minisig.replace(/\r/g, '').split('\n');
  if (lines.length < 4 || !lines[0]?.startsWith('untrusted comment:'))
    return { ok: false, reason: 'not a minisign signature file' };
  const sigBlob = Buffer.from(lines[1]?.trim() ?? '', 'base64');
  const tcLine = lines[2] ?? '';
  const globalSig = Buffer.from(lines[3]?.trim() ?? '', 'base64');
  if (sigBlob.length !== 74 || globalSig.length !== 64 || !tcLine.startsWith('trusted comment: '))
    return { ok: false, reason: 'malformed minisign signature' };
  const alg = sigBlob.subarray(0, 2).toString('latin1');
  if (alg !== 'Ed' && alg !== 'ED') return { ok: false, reason: `unknown signature algorithm ${alg}` };
  const keyId = Buffer.from(sigBlob.subarray(2, 10)).reverse().toString('hex').toUpperCase();
  if (keyId !== pub.keyId)
    return { ok: false, reason: `signed by key ${keyId}, not by the trusted key ${pub.keyId}` };
  const signature = sigBlob.subarray(10);
  const msg = typeof message === 'string' ? Buffer.from(message, 'utf8') : message;
  const signed = alg === 'ED' ? createHash('blake2b512').update(msg).digest() : msg;
  const key = ed25519Key(pub.publicKey);
  try {
    if (!verify(null, signed, key, signature)) return { ok: false, reason: 'the signature does not verify' };
    const trustedComment = tcLine.slice('trusted comment: '.length);
    const global = Buffer.concat([signature, Buffer.from(trustedComment, 'utf8')]);
    if (!verify(null, global, key, globalSig))
      return { ok: false, reason: 'the trusted comment signature does not verify' };
    return { ok: true, keyId, trustedComment };
  } catch (err) {
    return {
      ok: false,
      reason: `signature check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** The key id a `.minisig` names (16 upper-case hex), or null when it is not a signature file. */
export function minisigKeyId(minisig: string): string | null {
  const blob = Buffer.from(minisig.replace(/\r/g, '').split('\n')[1]?.trim() ?? '', 'base64');
  if (blob.length !== 74) return null;
  return Buffer.from(blob.subarray(2, 10)).reverse().toString('hex').toUpperCase();
}
