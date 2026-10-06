import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238) with HMAC-SHA1, 6 digits and a 30-second step: what authenticator apps implement. Pure functions;
 * persistence and replay protection live in `two-factor.ts`.
 */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit secret, base32 encoded (what the authenticator app stores). */
export const generateTotpSecret = (): string => base32Encode(randomBytes(20));

export const totpStep = (at: Date): number => Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS);

/** The code for one time step. */
export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = (h[h.length - 1] as number) & 0xf;
  const bin =
    (((h[offset] as number) & 0x7f) << 24) |
    (((h[offset + 1] as number) & 0xff) << 16) |
    (((h[offset + 2] as number) & 0xff) << 8) |
    ((h[offset + 3] as number) & 0xff);
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/**
 * The time step the code belongs to, within one step of `at` either way (clock drift), or null. Steps at or before
 * `lastUsedStep` are refused: a code works once.
 */
export function verifyTotp(
  secret: string,
  code: string,
  at: Date,
  lastUsedStep: number | null = null,
): number | null {
  const given = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return null;
  const now = totpStep(at);
  for (const step of [now, now - 1, now + 1]) {
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    const want = Buffer.from(totpCode(secret, step));
    const have = Buffer.from(given);
    if (want.length === have.length && timingSafeEqual(want, have)) return step;
  }
  return null;
}

/** `otpauth://totp/<issuer>:<account>?secret=...` for the QR code. */
export function otpauthUri(opts: { issuer: string; account: string; secret: string }): string {
  const label = `${encodeURIComponent(opts.issuer)}:${encodeURIComponent(opts.account)}`;
  return `otpauth://totp/${label}?secret=${opts.secret}&issuer=${encodeURIComponent(opts.issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}
