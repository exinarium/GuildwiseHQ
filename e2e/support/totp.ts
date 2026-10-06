import { createHmac } from 'node:crypto';
import { BASE_URL } from './env.ts';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The TOTP code for `secret` at the given step (RFC 6238, SHA-1, 6 digits, 30 s). */
export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const o = (h[h.length - 1] as number) & 0xf;
  const bin =
    (((h[o] as number) & 0x7f) << 24) |
    (((h[o + 1] as number) & 0xff) << 16) |
    (((h[o + 2] as number) & 0xff) << 8) |
    ((h[o + 3] as number) & 0xff);
  return String(bin % 1_000_000).padStart(6, '0');
}

/**
 * A code the server accepts and has not seen: the (test) server's clock moves on one step first, so a code is never
 * the one used a moment ago. Moving the clock forward is harmless to the other specs (they already move it by days).
 */
export async function freshTotp(secret: string): Promise<string> {
  const r = await fetch(`${BASE_URL}/api/test/clock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE_URL },
    body: JSON.stringify({ advanceMs: 31_000 }),
  });
  const { now } = (await r.json()) as { now: string };
  return totpAt(secret, Math.floor(new Date(now).getTime() / 30_000));
}
