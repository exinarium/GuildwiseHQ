import { createHash, randomBytes } from 'node:crypto';

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** `XXXX-XXXX`, Crockford base32, 40 bits. */
export function generatePairingCode(): string {
  const b = randomBytes(5);
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let s = '';
  for (let i = 0; i < 8; i++) {
    s = CROCKFORD[Number(n & 31n)] + s;
    n >>= 5n;
  }
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Uppercase, strip separators and map Crockford look-alikes (I,L -> 1; O -> 0). */
export function normalizePairingCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
}
