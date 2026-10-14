import {
  ENVELOPE_TTL_MS,
  INTEGRATION_ENVELOPE_ALG,
  type IntegrationEnvelopeOp,
  type IntegrationKindId,
  integrationAad,
  MAX_ENVELOPE_FIELDS_BYTES,
  type SealedEnvelope,
  type SealedPlaintext,
} from './schema.ts';

/**
 * Browser-side sealing for the runner (D3): a random AES-256-GCM key encrypts the fields (bound to one workstation, request,
 * kind, instance and op by the AAD); the key is wrapped with the runner's RSA-OAEP-256 public key. Uses WebCrypto only
 * (`globalThis.crypto.subtle`: browsers and Node 22), so the web app and the tests share one implementation.
 */

// The shared package builds with ES2023 only (no DOM types): the little of WebCrypto used here is declared locally.
interface SubtleLike {
  importKey(format: string, data: unknown, algo: unknown, extractable: boolean, usages: string[]): Promise<unknown>;
  generateKey(algo: unknown, extractable: boolean, usages: string[]): Promise<unknown>;
  exportKey(format: string, key: unknown): Promise<ArrayBuffer>;
  encrypt(algo: unknown, key: unknown, data: unknown): Promise<ArrayBuffer>;
}
interface CryptoLike {
  subtle: SubtleLike;
  getRandomValues<T extends ArrayBufferView>(a: T): T;
}
const webcrypto = (): CryptoLike => {
  const c = (globalThis as unknown as { crypto?: CryptoLike }).crypto;
  if (!c?.subtle) throw new Error('WebCrypto is not available in this browser');
  return c;
};

const b64 = {
  enc(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return (globalThis as unknown as { btoa(s: string): string }).btoa(s);
  },
  dec(text: string): Uint8Array {
    const bin = (globalThis as unknown as { atob(s: string): string }).atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

export interface SealInput {
  /** The runner's SPKI public key, base64. */
  publicKey: string;
  keyId: string;
  workstationId: string;
  /** The request id (connect) or the session id (input). */
  ref: string;
  kind: IntegrationKindId;
  instance: string;
  op: IntegrationEnvelopeOp;
  method?: string;
  fields: Record<string, string>;
  /** Server time in ms (the page gets `serverTime` with the key, so a skewed browser clock does not matter). */
  serverTimeMs: number;
}

/** Seals `fields` for one runner. Throws when the fields exceed 8 KB. */
export async function sealForRunner(input: SealInput): Promise<SealedEnvelope> {
  const enc = new TextEncoder();
  const plaintext: SealedPlaintext = {
    v: 1,
    ref: input.ref,
    workstationId: input.workstationId,
    kind: input.kind,
    instance: input.instance,
    op: input.op,
    ...(input.method ? { method: input.method } : {}),
    exp: input.serverTimeMs + ENVELOPE_TTL_MS,
    fields: input.fields,
  };
  const body = enc.encode(JSON.stringify(plaintext));
  if (enc.encode(JSON.stringify(input.fields)).length > MAX_ENVELOPE_FIELDS_BYTES)
    throw new Error('the values are too large to send');
  const c = webcrypto();
  const rsa = await c.subtle.importKey(
    'spki',
    b64.dec(input.publicKey),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  );
  const aes = await c.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = c.getRandomValues(new Uint8Array(12));
  const aad = enc.encode(
    integrationAad({
      workstationId: input.workstationId,
      ref: input.ref,
      kind: input.kind,
      instance: input.instance,
      op: input.op,
    }),
  );
  const ct = new Uint8Array(await c.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, aes, body));
  const raw = new Uint8Array(await c.subtle.exportKey('raw', aes));
  const wrapped = new Uint8Array(await c.subtle.encrypt({ name: 'RSA-OAEP' }, rsa, raw));
  return {
    v: 1,
    alg: INTEGRATION_ENVELOPE_ALG,
    keyId: input.keyId,
    wrappedKey: b64.enc(wrapped),
    iv: b64.enc(iv),
    ct: b64.enc(ct),
  };
}
