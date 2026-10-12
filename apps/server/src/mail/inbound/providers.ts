import { timingSafeEqual } from 'node:crypto';
import type { Config } from '../../config.ts';
import { fakeProvider } from './fake.ts';
import { postmarkProvider } from './postmark.ts';
import type { InboundProvider } from './types.ts';

/** The provider adapters. A new provider is one file with `parse` and one line here (and a value of `AOM_INBOUND_PROVIDER`). */
const PROVIDERS: Record<string, InboundProvider> = {
  postmark: postmarkProvider,
  fake: fakeProvider,
};

/** The provider the deployment is set up for, or null when inbound mail is off. */
export const configuredProvider = (config: Config): InboundProvider | null =>
  config.inbound.provider ? (PROVIDERS[config.inbound.provider] ?? null) : null;

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Webhook authentication: the shared secret as the password of HTTP Basic auth (what Postmark's webhook URL
 * `https://user:secret@host/...` sends), or the `X-AOM-Inbound-Secret` header. Constant-time comparison. Without a
 * configured secret nothing is accepted.
 */
export function webhookAuthorised(config: Config, headers: Record<string, unknown>): boolean {
  const secret = config.inbound.secret;
  if (!secret) return false;
  const direct = headers['x-aom-inbound-secret'];
  if (typeof direct === 'string' && safeEqual(direct, secret)) return true;
  const auth = headers.authorization;
  if (typeof auth === 'string' && /^basic\s+/i.test(auth)) {
    const decoded = Buffer.from(auth.replace(/^basic\s+/i, ''), 'base64').toString('utf8');
    const password = decoded.slice(decoded.indexOf(':') + 1);
    return decoded.includes(':') && safeEqual(password, secret);
  }
  return false;
}
