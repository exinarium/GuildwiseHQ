import {
  constants,
  createDecipheriv,
  createPrivateKey,
  generateKeyPairSync,
  privateDecrypt,
} from 'node:crypto';
import { packCredentialAad } from '@aom/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sealPackCredential } from '../api/queries/my-capabilities.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const PACK = '0192f3a0-0000-7000-8000-00000000c0de';
const WS = '0192f3a0-0000-7000-8000-0000000000a1';

function open(sealed: string, aad: string): string {
  const [v, wrapped, iv, ct] = sealed.split('.');
  expect(v).toBe('h2');
  const aes = privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(wrapped as string, 'base64'),
  );
  const buf = Buffer.from(ct as string, 'base64');
  const d = createDecipheriv('aes-256-gcm', aes, Buffer.from(iv as string, 'base64'));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString('utf8');
}

afterEach(() => vi.unstubAllGlobals());

describe('sealing a pack deploy key or token in the browser', () => {
  it('binds it to the pack, the kind and the host of its git URL, and to the runner key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ keyId: 'k1', publicKey: spki }), {
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const out = await sealPackCredential(
      'token',
      'ghp_secret',
      [WS],
      { id: PACK, url: 'https://GitHub.com/acme/skills.git' },
      'bot',
    );
    const share = out.shares[0] as { ciphertext: string; keyId: string };
    expect(share.keyId).toBe('k1');
    expect(out.username).toBe('bot');
    const aad = packCredentialAad({ packId: PACK, kind: 'token', host: 'github.com', keyId: 'k1' });
    expect(open(share.ciphertext, aad)).toBe('ghp_secret');
    // another pack, another host, another kind: does not open
    for (const other of [
      packCredentialAad({ packId: WS, kind: 'token', host: 'github.com', keyId: 'k1' }),
      packCredentialAad({ packId: PACK, kind: 'token', host: 'evil.example.net', keyId: 'k1' }),
      packCredentialAad({ packId: PACK, kind: 'ssh', host: 'github.com', keyId: 'k1' }),
    ])
      expect(() => open(share.ciphertext, other)).toThrow();
    expect(JSON.stringify(out)).not.toContain('ghp_secret');
  });

  it('knows the host of an scp-style ssh URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ keyId: 'k1', publicKey: spki }), {
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const out = await sealPackCredential('ssh', 'KEY', [WS], {
      id: PACK,
      url: 'git@git.example.org:acme/skills.git',
    });
    const aad = packCredentialAad({ packId: PACK, kind: 'ssh', host: 'git.example.org', keyId: 'k1' });
    expect(open((out.shares[0] as { ciphertext: string }).ciphertext, aad)).toBe('KEY');
  });
});
