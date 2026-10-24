import {
  constants,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ENVELOPE_MAX_AHEAD_MS,
  INTEGRATION_ENVELOPE_ALG,
  type IntegrationEnvelopeOp,
  type IntegrationKindId,
  integrationAad,
  type SealedEnvelope,
  type SealedPlaintext,
  SealedPlaintextSchema,
  type SudoKey,
} from '@aom/shared';

/** Why an integration envelope was refused. `code` is safe to show; the message never holds plaintext. */
export class EnvelopeError extends Error {
  constructor(
    readonly code: 'key' | 'decrypt' | 'mismatch' | 'expired' | 'too_far',
    message: string,
  ) {
    super(message);
  }
}

/** The outer fields of a command: the AAD is rebuilt from these, so a moved ciphertext fails to decrypt. */
export interface EnvelopeOuter {
  workstationId: string;
  ref: string;
  kind: IntegrationKindId;
  instance: string;
  op: IntegrationEnvelopeOp;
}

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

  /** Opens `sealLarge` output (`h1.<wrapped key>.<iv>.<ciphertext+tag>`: AES-256-GCM under an RSA-OAEP wrapped key). */
  decryptHybrid(sealed: string, aad?: string): string {
    const [v, wrapped, iv, ct] = sealed.split('.');
    if ((v !== 'h1' && v !== 'h2') || !wrapped || !iv || !ct) throw new Error('not a sealed value');
    // `h2` is bound to what the person typed it for: without that binding it does not open (and `h1` has none)
    if (v === 'h2' && !aad)
      throw new Error('this sealed value is bound to a server and cannot be opened without it');
    const aes = privateDecrypt(
      {
        key: createPrivateKey(this.privatePem),
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      Buffer.from(wrapped, 'base64'),
    );
    const buf = Buffer.from(ct, 'base64');
    const d = createDecipheriv('aes-256-gcm', aes, Buffer.from(iv, 'base64'));
    d.setAuthTag(buf.subarray(buf.length - 16));
    if (v === 'h2') d.setAAD(Buffer.from(aad as string, 'utf8'));
    return Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString('utf8');
  }

  /**
   * `decrypt` for a short value, `decryptHybrid` for a sealed one of any length. `requireBound` refuses every form that is not
   * tied to its purpose by associated data (`h2.`): the RSA-only form and `h1.` carry no binding, so whoever relays them can
   * relabel what they are for.
   */
  decryptAny(value: string, aad?: string, opts: { requireBound?: boolean } = {}): string {
    if (opts.requireBound && !value.startsWith('h2.'))
      throw new Error('this sealed value is not bound to its purpose and is refused');
    return value.startsWith('h1.') || value.startsWith('h2.')
      ? this.decryptHybrid(value, aad)
      : this.decrypt(value);
  }

  /**
   * Opens a hybrid envelope (RSA-OAEP-256 wraps an AES-256-GCM key; the AAD binds workstation, request, kind, instance and
   * op). Refuses another key id, a ciphertext moved to another request (the AAD is rebuilt from the command's outer
   * fields), inner fields that differ from the outer ones, an expired envelope and one valid for more than 15 minutes.
   * The replay check is the caller's (`ReplayCache`). Throws `EnvelopeError`; the plaintext is returned only on success.
   */
  open(envelope: SealedEnvelope, outer: EnvelopeOuter, now: number = Date.now()): SealedPlaintext {
    if (envelope.alg !== INTEGRATION_ENVELOPE_ALG)
      throw new EnvelopeError('decrypt', 'the sealed values use an unknown scheme: reload the page');
    if (envelope.keyId !== this.publicKey.keyId)
      throw new EnvelopeError(
        'key',
        'the values were sealed for another key (the runner key changed): reload the page and enter them again',
      );
    let plain: Buffer;
    try {
      const aes = privateDecrypt(
        {
          key: createPrivateKey(this.privatePem),
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256',
        },
        Buffer.from(envelope.wrappedKey, 'base64'),
      );
      const ct = Buffer.from(envelope.ct, 'base64');
      if (aes.length !== 32 || ct.length < 17) throw new Error('shape');
      const d = createDecipheriv('aes-256-gcm', aes, Buffer.from(envelope.iv, 'base64'));
      d.setAAD(Buffer.from(integrationAad(outer), 'utf8'));
      d.setAuthTag(ct.subarray(ct.length - 16));
      plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
    } catch {
      throw new EnvelopeError('decrypt', 'the sealed values could not be opened: enter them again');
    }
    let inner: SealedPlaintext;
    try {
      inner = SealedPlaintextSchema.parse(JSON.parse(plain.toString('utf8')));
    } catch {
      throw new EnvelopeError('decrypt', 'the sealed values are damaged: enter them again');
    }
    if (
      inner.ref !== outer.ref ||
      inner.workstationId !== outer.workstationId ||
      inner.kind !== outer.kind ||
      inner.instance !== outer.instance ||
      inner.op !== outer.op
    )
      throw new EnvelopeError('mismatch', 'the sealed values belong to another request');
    if (inner.exp <= now) throw new EnvelopeError('expired', 'the sealed values expired: enter them again');
    if (inner.exp > now + ENVELOPE_MAX_AHEAD_MS)
      throw new EnvelopeError('too_far', 'the sealed values are valid for too long');
    return inner;
  }
}
