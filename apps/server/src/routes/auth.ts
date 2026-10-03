import { LoginRequestSchema, type MeResponse } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guards.ts';
import { createSession, deleteSession, SESSION_COOKIE } from '../auth/sessions.ts';
import { verifyLogin } from '../commands/auth.ts';
import type { Ctx } from '../context.ts';
import { rows } from '../db/sql.ts';
import { toUserDto } from '../dto.ts';
import { typed } from './util.ts';

export async function meResponse(ctx: Ctx, userId: string): Promise<MeResponse> {
  const u = (await rows(ctx.pool, 'SELECT * FROM users WHERE id=$1', [userId]))[0];
  const projects = await rows<{ project_id: string }>(
    ctx.pool,
    `SELECT project_id FROM project_members WHERE user_id=$1 AND status='active' ORDER BY project_id`,
    [userId],
  );
  return {
    user: toUserDto(u as Record<string, any>),
    isAdmin: u?.role === 'admin',
    visibleProjectIds: projects.map((p) => p.project_id),
  };
}

export function setSessionCookie(ctx: Ctx, reply: { setCookie: Function }, token: string, maxAgeSec: number) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.config.secureCookies,
    path: '/',
    maxAge: maxAgeSec,
  });
}

export function authRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.post(
      '/api/auth/login',
      {
        schema: { body: LoginRequestSchema },
        config: {
          rateLimit: {
            max: 10,
            timeWindow: '1 minute',
            keyGenerator: (req: { ip: string; body?: unknown }) =>
              `${req.ip}|${String((req.body as { email?: string } | undefined)?.email ?? '').toLowerCase()}`,
          },
        },
      },
      async (req, reply) => {
        const userId = await verifyLogin(ctx, req.body.email, req.body.password);
        const s = await createSession(ctx, userId, { userAgent: req.headers['user-agent'], ip: req.ip });
        setSessionCookie(ctx, reply, s.token, s.maxAgeSec);
        return meResponse(ctx, userId);
      },
    );

    app.post('/api/auth/logout', async (req, reply) => {
      const s = await requireUser(ctx, req);
      await deleteSession(ctx, s.sessionId);
      ctx.services.browser.closeSession(s.sessionId);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    });

    app.get('/api/auth/me', async (req) => {
      const s = await requireUser(ctx, req);
      return meResponse(ctx, s.user.id);
    });
  };
}
