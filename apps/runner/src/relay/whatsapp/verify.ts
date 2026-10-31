import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();
/** Constant time whatever the lengths: compares fixed-size digests. */
export const tokenEquals = (a: string, b: string): boolean => timingSafeEqual(digest(a), digest(b));

/** The GET handshake of the WhatsApp Cloud API: 200 with exactly `hub.challenge`, 403 for a wrong token, 400 without a challenge. */
export function verifyHandshake(
  query: string,
  verifyToken: string,
): { status: 200; body: string } | { status: 400 | 403 } {
  const q = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  const one = (k: string): string | null => (q.getAll(k).length === 1 ? q.get(k) : null);
  if (one('hub.mode') !== 'subscribe') return { status: 403 };
  const given = one('hub.verify_token');
  if (given === null || !tokenEquals(given, verifyToken)) return { status: 403 };
  const challenge = one('hub.challenge');
  if (
    challenge === null ||
    challenge.length === 0 ||
    challenge.length > 512 ||
    !/^[\x21-\x7e]+$/.test(challenge)
  )
    return { status: 400 };
  return { status: 200, body: challenge };
}

const SIG_RE = /^sha256=([0-9a-fA-F]{64})$/;

/** `X-Hub-Signature-256` over the exact raw bytes, in constant time. */
export function verifySignature(
  raw: Buffer,
  header: string | undefined,
  appSecret: string,
): 'ok' | 'missing' | 'malformed' | 'mismatch' {
  if (header === undefined || header === '') return 'missing';
  const m = SIG_RE.exec(header.trim());
  if (!m) return 'malformed';
  const expected = createHmac('sha256', appSecret).update(raw).digest();
  const given = Buffer.from(m[1] as string, 'hex');
  return timingSafeEqual(expected, given) ? 'ok' : 'mismatch';
}
