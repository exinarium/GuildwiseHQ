import type { FastifyRequest } from 'fastify';
import type { Config } from '../config.ts';
import { HttpError } from '../errors.ts';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Unauthenticated machine endpoints that are called by the runner CLI, which sends no Origin. */
const EXEMPT_PREFIXES = ['/api/runner/pair', '/api/test/'];

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

export function checkContentType(req: FastifyRequest): void {
  if (SAFE.has(req.method)) return;
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
