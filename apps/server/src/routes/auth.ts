import {
  ChangePasswordRequestSchema,
  IdParamsSchema,
  LoginRequestSchema,
  type MeResponse,
  SetMyAvatarRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '../auth/guards.ts';
import { SlidingLimit } from '../auth/limits.ts';
import { requestedOrgId } from '../auth/org-context.ts';
import { createSession, deleteSession, SESSION_COOKIE, sessionOfUser } from '../auth/sessions.ts';
import { changePassword, verifyLogin } from '../commands/auth.ts';
import { avatarImageFor, setMyAvatar } from '../commands/avatar.ts';
import type { Ctx } from '../context.ts';
import { buildMe } from '../queries/me.ts';
import { typed } from './util.ts';

/** `me` for a user without a request in hand (right after login or accept): the default organization applies. */
export async function meResponse(
  ctx: Ctx,
  userId: string,
  requestedOrg: string | null = null,
): Promise<MeResponse> {
  return buildMe(ctx, await sessionOfUser(ctx, userId), requestedOrg);
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
    // Beyond the per-(IP, email) limit on login: one IP cannot walk through many accounts (credential stuffing),
    // and a stolen session cannot be used to guess the current password.
    const loginPerIp = new SlidingLimit(30, 60_000);
    const passwordPerAccount = new SlidingLimit(5, 60_000);

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
        if (ctx.config.rateLimit) loginPerIp.hit(req.ip);
        const userId = await verifyLogin(ctx, req.body.email, req.body.password);
        const s = await createSession(ctx, userId, { userAgent: req.headers['user-agent'], ip: req.ip });
        setSessionCookie(ctx, reply, s.token, s.maxAgeSec);
        return meResponse(ctx, userId, requestedOrgId(req));
      },
    );

    app.post('/api/auth/logout', async (req, reply) => {
      const s = await requireSession(ctx, req);
      await deleteSession(ctx, s.sessionId);
      ctx.services.browser.closeSession(s.sessionId);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    });

    app.post('/api/auth/password', { schema: { body: ChangePasswordRequestSchema } }, async (req) => {
      const s = await requireSession(ctx, req);
      if (ctx.config.rateLimit) passwordPerAccount.hit(s.user.id);
      await changePassword(ctx, s, req.body.current, req.body.new);
      return { ok: true };
    });

    // The signed-in user's own picture: a generated face, an uploaded (cropped, 256 px) image, or none.
    app.put('/api/me/avatar', { schema: { body: SetMyAvatarRequestSchema } }, async (req) => {
      const s = await requireSession(ctx, req);
      await setMyAvatar(ctx, s.user, req.body);
      return meResponse(ctx, s.user.id, requestedOrgId(req));
    });

    // An uploaded picture, for the people who may see that user (themselves, an administrator, project mates).
    app.get('/api/users/:id/avatar', { schema: { params: IdParamsSchema } }, async (req, reply) => {
      const s = await requireSession(ctx, req);
      const img = await avatarImageFor(ctx, s.user, req.params.id);
      if (!img) return reply.code(404).send({ error: { code: 'not_found', message: 'no picture' } });
      return reply
        .header('content-type', img.mime)
        .header('cache-control', 'private, max-age=86400')
        .header('etag', `"${img.id}"`)
        .header('x-content-type-options', 'nosniff')
        .send(img.data);
    });

    app.get('/api/auth/me', async (req) => {
      const s = await requireSession(ctx, req);
      return buildMe(ctx, s, requestedOrgId(req));
    });
  };
}
