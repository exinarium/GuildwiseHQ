import { createHmac, timingSafeEqual } from 'node:crypto';

export type HookScheme = 'guildwise' | 'body_sha256';
export type SignatureResult = 'ok' | 'missing' | 'bad' | 'stale';

const header = (h: Record<string, unknown>, name: string): string | undefined => {
  const v = h[name];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' ? s : undefined;
};

const equalHex = (a: string, b: string): boolean => {
  // Equal-length buffers only: timingSafeEqual throws on a length mismatch.
  if (!/^[0-9a-f]+$/i.test(a)) return false;
  const x = Buffer.from(a.toLowerCase(), 'hex');
  const y = Buffer.from(b.toLowerCase(), 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

/** `sha256=<hex>` as the header carries it; null for anything else. */
const hexOf = (v: string | undefined): string | null => {
  const m = /^sha256=([0-9a-fA-F]{64})$/.exec((v ?? '').trim());
  return m ? (m[1] as string) : null;
};

/**
 * Checks the signature over the RAW bytes (before any parsing). `guildwise`: HMAC-SHA256 over `<timestamp>.<body>` with a
 * timestamp within `toleranceSec`. `body_sha256`: HMAC over the body only (GitHub-style senders; replays are stopped by the
 * idempotency key only).
 */
export function verifyHookSignature(
  scheme: HookScheme,
  secret: string,
  headers: Record<string, unknown>,
  raw: Buffer,
  nowSec: number,
  toleranceSec = 300,
): SignatureResult {
  if (scheme === 'body_sha256') {
    const given = hexOf(header(headers, 'x-hub-signature-256') ?? header(headers, 'x-signature'));
    if (!given) return 'missing';
    const mac = createHmac('sha256', secret).update(raw).digest('hex');
    return equalHex(given, mac) ? 'ok' : 'bad';
  }
  const given = hexOf(header(headers, 'x-guildwise-signature'));
  const ts = header(headers, 'x-guildwise-timestamp');
  if (!given || !ts) return 'missing';
  if (!/^\d{1,12}$/.test(ts)) return 'bad';
  const mac = createHmac('sha256', secret).update(`${ts}.`).update(raw).digest('hex');
  if (!equalHex(given, mac)) return 'bad';
  return Math.abs(nowSec - Number(ts)) > toleranceSec ? 'stale' : 'ok';
}

export function signHook(
  scheme: HookScheme,
  secret: string,
  raw: Buffer,
  tsSec: number,
): Record<string, string> {
  if (scheme === 'body_sha256')
    return { 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` };
  return {
    'x-guildwise-timestamp': String(tsSec),
    'x-guildwise-signature': `sha256=${createHmac('sha256', secret).update(`${tsSec}.`).update(raw).digest('hex')}`,
  };
}
