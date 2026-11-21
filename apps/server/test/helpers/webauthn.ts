import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';

/**
 * A software authenticator for the passkey tests (R22): makes WebAuthn registration and assertion responses the way a
 * browser hands them over (`RegistrationResponseJSON`, assertion fields as base64url). Test-only keys, made per run.
 */
export type SoftAlg = -7 | -8 | -257;

const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString('base64url');
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest();

export class SoftAuthenticator {
  readonly credentialId: Buffer = randomBytes(32);
  readonly publicKey: KeyObject;
  private readonly privateKey: KeyObject;
  signCount = 0;

  constructor(readonly alg: SoftAlg = -7) {
    const pair =
      alg === -7
        ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
        : alg === -8
          ? generateKeyPairSync('ed25519')
          : generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.publicKey = pair.publicKey;
    this.privateKey = pair.privateKey;
  }

  get id(): string {
    return b64u(this.credentialId);
  }

  /** SPKI DER, base64: what the server must store and offer to the runner. */
  spki(): string {
    return this.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  }

  private coseKey(): Uint8Array {
    const jwk = this.publicKey.export({ format: 'jwk' }) as Record<string, string>;
    const bin = (s: string | undefined) => new Uint8Array(Buffer.from(s ?? '', 'base64url'));
    const m = new Map<number, number | Uint8Array>();
    if (this.alg === -7) {
      m.set(1, 2).set(3, -7).set(-1, 1).set(-2, bin(jwk.x)).set(-3, bin(jwk.y));
    } else if (this.alg === -8) {
      m.set(1, 1).set(3, -8).set(-1, 6).set(-2, bin(jwk.x));
    } else {
      m.set(1, 3).set(3, -257).set(-1, bin(jwk.n)).set(-2, bin(jwk.e));
    }
    return isoCBOR.encode(m as never);
  }

  private authData(rpId: string, flags: number, withCredential: boolean): Buffer {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.signCount);
    const parts: Buffer[] = [sha256(rpId), Buffer.from([flags]), count];
    if (withCredential) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), len, this.credentialId, Buffer.from(this.coseKey()));
    }
    return Buffer.concat(parts);
  }

  /** `navigator.credentials.create()` as `@simplewebauthn/browser` returns it (attestation `none`). */
  register(o: {
    challenge: string;
    origin: string;
    rpId: string;
    userVerified?: boolean;
    type?: string;
  }): Record<string, unknown> {
    const flags = 0x01 | (o.userVerified === false ? 0 : 0x04) | 0x40;
    const authData = this.authData(o.rpId, flags, true);
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', new Uint8Array(authData)],
      ]) as never,
    );
    const clientDataJSON = JSON.stringify({
      type: o.type ?? 'webauthn.create',
      challenge: o.challenge,
      origin: o.origin,
      crossOrigin: false,
    });
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64u(Buffer.from(clientDataJSON)),
        attestationObject: b64u(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** `navigator.credentials.get()` for a challenge: the fields the server relays in `approval.passkey`. */
  assert(o: { challenge: string; origin: string; rpId: string; type?: string }): {
    credentialId: string;
    authenticatorData: string;
    clientDataJSON: string;
    signature: string;
  } {
    this.signCount += 1;
    const authData = this.authData(o.rpId, 0x05, false);
    const clientData = Buffer.from(
      JSON.stringify({
        type: o.type ?? 'webauthn.get',
        challenge: o.challenge,
        origin: o.origin,
        crossOrigin: false,
      }),
    );
    const data = Buffer.concat([authData, sha256(clientData)]);
    const signature =
      this.alg === -8 ? sign(null, data, this.privateKey) : sign('sha256', data, this.privateKey);
    return {
      credentialId: this.id,
      authenticatorData: b64u(authData),
      clientDataJSON: b64u(clientData),
      signature: b64u(signature),
    };
  }
}
