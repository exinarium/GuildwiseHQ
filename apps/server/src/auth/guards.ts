import type { FastifyRequest } from 'fastify';
import type { Ctx } from '../context.ts';
import { forbidden, notFound, unauthorized } from '../errors.ts';
import { type AuthSession, lookupSession, SESSION_COOKIE } from './sessions.ts';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthSession | null;
  }
}

/** Authenticated session or 401. The user is always `active` (deactivated users have no valid session). */
export async function requireUser(ctx: Ctx, req: FastifyRequest): Promise<AuthSession> {
  if (req.auth) return req.auth;
  const s = await lookupSession(ctx, req.cookies[SESSION_COOKIE]);
  if (!s) throw unauthorized();
  req.auth = s;
  return s;
}

export async function requireAdmin(ctx: Ctx, req: FastifyRequest): Promise<AuthSession> {
  const s = await requireUser(ctx, req);
  if (s.user.role !== 'admin') throw forbidden('administrator access required');
  return s;
}

export { notFound };
