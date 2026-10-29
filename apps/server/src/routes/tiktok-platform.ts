import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireSuperAdmin } from '../auth/guards.ts';
import { tiktokCallback, tiktokConnectUrl, tiktokCreator } from '../commands/tiktok.ts';
import type { Ctx } from '../context.ts';
import { HttpError } from '../errors.ts';
import { typed } from './util.ts';

/** Super admin routes of the TikTok channel (404 for everyone else). */
export function tiktokPlatformRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);
    /** Starts the OAuth sign-in: a redirect to TikTok (the Connect button is a link). */
    app.get('/api/platform/social/tiktok/connect', async (req, reply) => {
      const s = await requireSuperAdmin(ctx, req);
      return reply.redirect(await tiktokConnectUrl(ctx, s.user), 302);
    });
    /** TikTok sends the browser back here with `code` and `state`; the page goes on to the Social sharing panel. */
    app.get(
      '/api/platform/social/tiktok/callback',
      {
        schema: {
          querystring: z.object({
            code: z.string().max(2000).optional(),
            state: z.string().max(200).optional(),
            error: z.string().max(200).optional(),
            error_description: z.string().max(500).optional(),
          }),
        },
      },
      async (req, reply) => {
        const s = await requireSuperAdmin(ctx, req);
        try {
          await tiktokCallback(ctx, s.user, req.query);
          return reply.redirect(`${ctx.config.publicOrigin}/platform/blog?tiktok=connected`, 302);
        } catch (err) {
          if (!(err instanceof HttpError) || err.status >= 500) throw err;
          const q = new URLSearchParams({ tiktok: 'error', message: err.message.slice(0, 200) });
          return reply.redirect(`${ctx.config.publicOrigin}/platform/blog?${q}`, 302);
        }
      },
    );
    app.get('/api/platform/social/tiktok/creator-info', async (req) => {
      await requireSuperAdmin(ctx, req);
      return tiktokCreator(ctx);
    });
  };
}
