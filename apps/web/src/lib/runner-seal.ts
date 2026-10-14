import {
  type IntegrationEnvelopeOp,
  type IntegrationKindId,
  type SealedEnvelope,
  sealForRunner,
} from '@aom/shared';

/** RSA-OAEP / SHA-256 with the runner's SPKI public key (base64); returns base64 ciphertext. Used for the sudo password. */
export async function encryptForRunner(publicKeyB64: string, text: string): Promise<string> {
  const der = Uint8Array.from(atob(publicKeyB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('spki', der, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, [
    'encrypt',
  ]);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, new TextEncoder().encode(text)),
  );
  let bin = '';
  for (const b of ct) bin += String.fromCharCode(b);
  return btoa(bin);
}

export interface IntegrationKey {
  keyId: string;
  publicKey: string;
}

/**
 * Seals integration fields (or one pasted code) for one workstation's runner: hybrid RSA-OAEP-256 + AES-GCM, bound to
 * the workstation, request, kind, instance and op. `serverTime` is the page's `serverTime` (a skewed browser clock does
 * not matter). The caller clears its own copy of the values afterwards.
 */
export function sealIntegration(a: {
  key: IntegrationKey;
  serverTime: string;
  workstationId: string;
  /** The request id (connect) or `${sessionId}:${attempt}` (input). */
  ref: string;
  kind: IntegrationKindId;
  instance: string;
  op: IntegrationEnvelopeOp;
  method?: string;
  fields: Record<string, string>;
}): Promise<SealedEnvelope> {
  return sealForRunner({
    publicKey: a.key.publicKey,
    keyId: a.key.keyId,
    workstationId: a.workstationId,
    ref: a.ref,
    kind: a.kind,
    instance: a.instance,
    op: a.op,
    ...(a.method ? { method: a.method } : {}),
    fields: a.fields,
    serverTimeMs: Date.parse(a.serverTime),
  });
}
