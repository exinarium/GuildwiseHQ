import { DigestItemsQuerySchema, IdParamsSchema, RateDigestItemRequestSchema } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guards.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import { rateDigestItem } from '../commands/digests.ts';
import type { Ctx } from '../context.ts';
import { feedListFor, listDigestItems, tasteFor } from '../queries/digests.ts';
import { typed } from './util.ts';

export function digestRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/digest-items', { schema: { querystring: DigestItemsQuerySchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return { items: await listDigestItems(ctx.pool, s.user.id, req.query) };
    });

    app.post(
      '/api/digest-items/:id/rate',
      { schema: { params: IdParamsSchema, body: RateDigestItemRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        return rateDigestItem(ctx, s.user, req.params.id, req.body);
      },
    );

    app.get('/api/projects/:id/feed', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return feedListFor(ctx.pool, s.user.id, await loadVisibleProject(ctx.pool, s.user.id, req.params.id));
    });

    app.get('/api/projects/:id/taste', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return tasteFor(ctx.pool, await loadVisibleProject(ctx.pool, s.user.id, req.params.id));
    });
  };
}
