import { createHash, createPrivateKey, sign } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Signed runner releases for the server tests (R18-U, R21, R27), made with the test-only minisign keys in
 * `apps/runner/test/fixtures/minisign/` (no release, image or server trusts them). The keys there have no passphrase, so
 * a signature is made here in-process, exactly as `minisign -S` makes one (pre-hashed `ED`, global signature over the
 * trusted comment).
 */
export const FIXTURES = resolve(import.meta.dirname, '../../../runner/test/fixtures/minisign');

const pubLine = (name: string) =>
  (readFileSync(join(FIXTURES, `${name}.pub`), 'utf8').split('\n')[1] as string).trim();
/** `AOM_RUNNER_RELEASE_PUBKEY` value for the test key (key id `8399E5B65A3876B0`). */
export const TEST_PUBKEY = pubLine('test');
export const TEST_KEY_ID = '8399E5B65A3876B0';
export const OTHER_PUBKEY = pubLine('other');

/** Signs `message` with a fixture secret key (`test` or `other`); returns the `.minisig` text. */
export function minisign(
  message: string | Buffer,
  key: 'test' | 'other' = 'test',
  trusted = 'guildwise-runner test',
): string {
  const raw = Buffer.from(
    (readFileSync(join(FIXTURES, `${key}.key`), 'utf8').split('\n')[1] as string).trim(),
    'base64',
  );
  if (raw.subarray(2, 4).toString('latin1') !== '\0\0') throw new Error('fixture key has a passphrase');
  const keyId = raw.subarray(54, 62);
  const seed = raw.subarray(62, 94);
  const pub = raw.subarray(94, 126);
  const sk = createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', d: seed.toString('base64url'), x: pub.toString('base64url') },
    format: 'jwk',
  });
  const digest = createHash('blake2b512').update(message).digest();
  const sig = sign(null, digest, sk);
  const global = sign(null, Buffer.concat([sig, Buffer.from(trusted, 'utf8')]), sk);
  return [
    'untrusted comment: signature from minisign secret key',
    Buffer.concat([Buffer.from('ED', 'latin1'), keyId, sig]).toString('base64'),
    `trusted comment: ${trusted}`,
    global.toString('base64'),
    '',
  ].join('\n');
}

/** A manifest text in the shape of `package-runner.sh` for a version. */
export function manifestText(version: string, sha256 = 'a'.repeat(64)): string {
  return `${JSON.stringify(
    {
      version,
      file: `aom-runner-${version}.tgz`,
      sha256,
      minRunner: version,
      floor: version,
      allowDowngrade: false,
      nodeRuntime: {},
    },
    null,
    2,
  )}\n`;
}

/** The proof a runner sends at pairing and in `hello`. */
export function proofFor(
  version: string,
  key: 'test' | 'other' = 'test',
): { manifest: string; minisig: string } {
  const manifest = manifestText(version);
  return { manifest, minisig: minisign(manifest, key) };
}

/** The fixture's own signed 1.10.0 manifest and signature (made with the real `minisign` binary). */
export function fixtureProof(): { manifest: string; minisig: string } {
  return {
    manifest: readFileSync(join(FIXTURES, 'manifest.json'), 'utf8'),
    minisig: readFileSync(join(FIXTURES, 'manifest.json.minisig'), 'utf8'),
  };
}

/** A release directory as `package-runner.sh` leaves it: the tarball, `manifest.json` and, unless `unsigned`, its signature. */
export function releaseDirWith(opts: { unsigned?: boolean; key?: 'test' | 'other' } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'aom-signed-release-'));
  copyFileSync(join(FIXTURES, 'aom-runner-1.10.0.tgz'), join(dir, 'aom-runner-1.10.0.tgz'));
  copyFileSync(join(FIXTURES, 'manifest.json'), join(dir, 'manifest.json'));
  if (!opts.unsigned) {
    if (opts.key === 'other')
      copyFileSync(join(FIXTURES, 'manifest.json.other.minisig'), join(dir, 'manifest.json.minisig'));
    else copyFileSync(join(FIXTURES, 'manifest.json.minisig'), join(dir, 'manifest.json.minisig'));
  }
  return dir;
}

/** Writes an extra file into a release directory. */
export const writeInto = (dir: string, name: string, text: string) => writeFileSync(join(dir, name), text);
