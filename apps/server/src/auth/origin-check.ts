import type { FastifyRequest } from 'fastify';
import type { Config } from '../config.ts';
import { HttpError } from '../errors.ts';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Unauthenticated machine endpoints that are called by the runner CLI, which sends no Origin. */
const EXEMPT_PREFIXES = [
  '/api/runner/pair',
  '/api/test/',
  // The agent API is authenticated by a Bearer key only and ignores session cookies, so there is nothing to forge.
  '/api/v1/',
  '/api/billing/payfast/itn',
  '/api/billing/paystack/webhook',
  // The mail provider's inbound webhook: no cookie, no Origin; the shared secret is the credential.
  '/api/inbound/mail/',
];

/**
 * CSRF defence (docs/ARCHITECTURE.md section 18): strict Origin check on every non-GET request, and mutating
 * endpoints accept only application/json (blocks HTML form posts).
 */
export function checkOrigin(config: Config, req: FastifyRequest): void {
  if (SAFE.has(req.method)) return;
  const path = req.url.split('?')[0] ?? '';
  if (!path.startsWith('/api/')) return;
  if (EXEMPT_PREFIXES.some((p) => path.startsWith(p))) return;
  if (req.headers.origin !== config.publicOrigin) {
    throw new HttpError(403, 'bad_origin', 'Origin header missing or not allowed');
  }
}

/** Mail programs POST the one-click unsubscribe as a form (RFC 8058); it carries a signed token and changes nothing else. */
const isUnsubscribePost = (url: string): boolean => /^\/blog\/unsubscribe\//.test(url.split('?')[0] ?? '');

export function checkContentType(req: FastifyRequest): void {
  if (SAFE.has(req.method)) return;
  if (isUnsubscribePost(req.url)) return;
  // PayFast's notification is a form post.
  if ((req.url.split('?')[0] ?? '') === '/api/billing/payfast/itn') return;
  const ct = req.headers['content-type'];
  const hasBody = req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0';
  const chunked = req.headers['transfer-encoding'] !== undefined;
  if ((ct !== undefined || hasBody || chunked) && !(ct ?? '').toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  }
}

export function checkWsOrigin(config: Config, origin: string | undefined): boolean {
  return origin === config.publicOrigin;
}
