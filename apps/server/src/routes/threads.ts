import { ThreadMessagesQuerySchema, ThreadParamsSchema } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guards.ts';
import type { Ctx } from '../context.ts';
import { threadMessages } from '../queries/threads.ts';
import { typed } from './util.ts';

export function threadRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get(
      '/api/threads/:id/messages',
      { schema: { params: ThreadParamsSchema, querystring: ThreadMessagesQuerySchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        return threadMessages(ctx.pool, s.user.id, req.params.id, req.query);
      },
    );
  };
}
