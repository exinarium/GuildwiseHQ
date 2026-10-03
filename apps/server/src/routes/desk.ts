import {
  AnswerDeskItemRequestSchema,
  DeskItemParamsSchema,
  DeskQuerySchema,
  DismissDeskItemRequestSchema,
  ResolveDeskItemRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guards.ts';
import { answerDeskItem, dismissDeskItem, resolveDeskItem } from '../commands/desk.ts';
import type { Ctx } from '../context.ts';
import { notFound } from '../errors.ts';
import { getDeskDto, listDesk } from '../queries/desk.ts';
import { typed } from './util.ts';

export function deskRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    const dto = async (userId: string, id: string) => {
      const item = await getDeskDto(ctx.pool, userId, id);
      if (!item) throw notFound('desk item not found');
      return item;
    };

    app.get('/api/desk', { schema: { querystring: DeskQuerySchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return listDesk(ctx.pool, s.user.id, req.query);
    });

    app.post(
      '/api/desk/:id/answer',
      { schema: { params: DeskItemParamsSchema, body: AnswerDeskItemRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        const r = await answerDeskItem(ctx, s.user, req.params.id, req.body);
        return { item: await dto(s.user.id, req.params.id), ...r };
      },
    );

    app.post(
      '/api/desk/:id/resolve',
      { schema: { params: DeskItemParamsSchema, body: ResolveDeskItemRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await resolveDeskItem(ctx, s.user, req.params.id, req.body);
        return dto(s.user.id, req.params.id);
      },
    );

    app.post(
      '/api/desk/:id/dismiss',
      { schema: { params: DeskItemParamsSchema, body: DismissDeskItemRequestSchema.optional() } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await dismissDeskItem(ctx, s.user, req.params.id, req.body?.note);
        return dto(s.user.id, req.params.id);
      },
    );
  };
}
