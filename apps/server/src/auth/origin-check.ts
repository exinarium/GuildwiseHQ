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
  // Incoming webhooks of automations (#14): no cookie, no Origin; the secret is the credential.
  '/api/hooks/',
  // The runner uploads a file an agent attached with its runner token (Bearer), no cookie and no Origin.
  '/api/runner/uploads/',
];

/**
 * CSRF defence (docs/ARCHITECTURE.md section 18): strict Origin check on every non-GET request, and mutating
 * endpoints accept only application/json (blocks HTML form posts).
 */
/** The origins the web app may call from: the public origin and the optional `AOM_EXTRA_ORIGINS`, compared exactly. */
export function originAllowed(config: Config, origin: string | undefined): boolean {
  if (origin === undefined || origin === '*' || origin === 'null') return false;
  return origin === config.publicOrigin || (config.extraOrigins ?? []).includes(origin);
}

export function checkOrigin(config: Config, req: FastifyRequest): void {
  if (SAFE.has(req.method)) return;
  const path = req.url.split('?')[0] ?? '';
  if (!path.startsWith('/api/')) return;
  if (EXEMPT_PREFIXES.some((p) => path.startsWith(p))) return;
  if (!originAllowed(config, req.headers.origin)) {
    throw new HttpError(403, 'bad_origin', 'Origin header missing or not allowed');
  }
}

/** Mail programs POST the one-click unsubscribe as a form (RFC 8058); it carries a signed token and changes nothing else. */
const isUnsubscribePost = (url: string): boolean => /^\/blog\/unsubscribe\//.test(url.split('?')[0] ?? '');

export function checkContentType(req: FastifyRequest): void {
  if (SAFE.has(req.method)) return;
  if (isUnsubscribePost(req.url)) return;
  // SendGrid Inbound Parse posts multipart/form-data; the shared secret (checked before the body is read) is the credential.
  if ((req.url.split('?')[0] ?? '') === '/api/inbound/mail/sendgrid') return;
  // PayFast's notification is a form post.
  if ((req.url.split('?')[0] ?? '') === '/api/billing/payfast/itn') return;
  // A file upload is the raw body (the web app sends application/octet-stream), not JSON.
  const path = req.url.split('?')[0] ?? '';
  if (/^\/api\/cards\/[^/]+\/attachments$/.test(path) || path.startsWith('/api/runner/uploads/')) return;
  const ct = req.headers['content-type'];
  const hasBody = req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0';
  const chunked = req.headers['transfer-encoding'] !== undefined;
  if ((ct !== undefined || hasBody || chunked) && !(ct ?? '').toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  }
}

export function checkWsOrigin(config: Config, origin: string | undefined): boolean {
  return originAllowed(config, origin);
}
