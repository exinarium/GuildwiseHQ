import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Test-only minisign signing with the W0 fixture keys (apps/runner/test/fixtures/minisign: deliberately public keys no
 * release trusts). Decodes an UNENCRYPTED minisign secret key and signs like `minisign -S` (prehashed `ED`).
 */
export const FIXTURES = join(import.meta.dirname, 'fixtures', 'minisign');
export const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
export const TEST_PUB = fixture('test.pub');
export const OTHER_PUB = fixture('other.pub');
export const TEST_KEY_ID = '8399E5B65A3876B0';
export const OTHER_KEY_ID = 'F0D6288B1CBE00A7';

function secretOf(keyFileText: string): { keyId: Buffer; seed: Buffer; pub: Buffer } {
  const raw = Buffer.from(keyFileText.split('\n')[1]?.trim() ?? '', 'base64');
  if (raw.subarray(2, 4).toString('latin1') === 'Sc')
    throw new Error('encrypted fixture key: not supported here');
  const keynum = raw.subarray(54, 54 + 104);
  return { keyId: keynum.subarray(0, 8), seed: keynum.subarray(8, 40), pub: keynum.subarray(40, 72) };
}

export function minisignSign(
  message: Buffer | string,
  keyName: 'test.key' | 'other.key' = 'test.key',
  trustedComment = 'test signature',
  prehash = true,
): string {
  const k = secretOf(fixture(keyName));
  const key = createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', d: k.seed.toString('base64url'), x: k.pub.toString('base64url') },
    format: 'jwk',
  });
  const msg = typeof message === 'string' ? Buffer.from(message) : message;
  const signed = prehash ? createHash('blake2b512').update(msg).digest() : msg;
  const sig = sign(null, signed, key);
  const blob = Buffer.concat([Buffer.from(prehash ? 'ED' : 'Ed', 'latin1'), k.keyId, sig]);
  const global = sign(null, Buffer.concat([sig, Buffer.from(trustedComment)]), key);
  return `untrusted comment: signature from minisign secret key\n${blob.toString('base64')}\ntrusted comment: ${trustedComment}\n${global.toString('base64')}\n`;
}

/** A release manifest text for `version` naming a tgz with the given sha256. */
export function manifestText(version: string, sha256: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify(
    {
      version,
      file: `aom-runner-${version}.tgz`,
      sha256,
      minRunner: version,
      floor: '1.10.0',
      allowDowngrade: false,
      nodeRuntime: {},
      ...extra,
    },
    null,
    2,
  )}\n`;
}
