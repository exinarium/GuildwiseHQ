/**
 * WebCrypto (`crypto.subtle`) only exists in a secure context (HTTPS or localhost). The app is also served over plain
 * HTTP on LAN addresses for testing, where it is undefined. Every browser path that seals a secret goes through
 * `requireSubtle` so the user sees a clear message rather than "Cannot read properties of undefined".
 */
export const SECURE_CONTEXT_MESSAGE =
  'Encrypting secrets needs HTTPS or localhost — open this page over https';

export class SecureContextError extends Error {
  constructor() {
    super(SECURE_CONTEXT_MESSAGE);
    this.name = 'SecureContextError';
  }
}

/** `crypto.subtle`, or a `SecureContextError` where the page is not a secure context. */
export function requireSubtle(): typeof globalThis.crypto.subtle {
  const subtle = (globalThis as { crypto?: { subtle?: typeof globalThis.crypto.subtle } }).crypto?.subtle;
  if (!subtle) throw new SecureContextError();
  return subtle;
}

/** True when sealing is possible here (always true outside a browser, where Node has WebCrypto). */
export function canSeal(): boolean {
  const w = globalThis as { isSecureContext?: boolean; crypto?: { subtle?: unknown } };
  return w.isSecureContext !== false && Boolean(w.crypto?.subtle);
}
