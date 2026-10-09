import {
  constants,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SudoKey } from '@aom/shared';

/**
 * The runner's key pair for secrets the manager sends it (the sudo password). RSA-OAEP with SHA-256, 2048 bits: the
 * browser encrypts with the public half (announced in `hello`), only this process can decrypt. The private key lives
 * in `<data dir>/secrets/runner-key.pem`, mode 0600 in a 0700 directory, and never leaves the machine.
 */
export class RunnerKeys {
  private readonly privatePem: string;
  readonly publicKey: SudoKey;

  constructor(readonly file: string) {
    if (existsSync(file)) {
      this.privatePem = readFileSync(file, 'utf8');
    } else {
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      this.privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, this.privatePem, { mode: 0o600 });
    }
    try {
      chmodSync(file, 0o600);
      chmodSync(dirname(file), 0o700);
    } catch {
      // Windows: the data dir sits in the user's profile
    }
    const der = createPublicKey(createPrivateKey(this.privatePem)).export({ type: 'spki', format: 'der' });
    this.publicKey = {
      keyId: createHash('sha256').update(der).digest('hex').slice(0, 16),
      publicKey: der.toString('base64'),
    };
  }

  /** Decrypts a base64 RSA-OAEP (SHA-256) ciphertext to UTF-8 text. Throws on a wrong key or damaged data. */
  decrypt(ciphertextB64: string): string {
    return privateDecrypt(
      {
        key: createPrivateKey(this.privatePem),
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      Buffer.from(ciphertextB64, 'base64'),
    ).toString('utf8');
  }
}
