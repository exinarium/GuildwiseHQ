import { PublicationsQuerySchema } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireUserWithFeature } from '../auth/guards.ts';
import type { Ctx } from '../context.ts';
import { listPublications } from '../queries/research.ts';
import { typed } from './util.ts';

export function researchRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get(
      '/api/research/publications',
      { schema: { querystring: PublicationsQuerySchema } },
      async (req) => {
        const s = await requireUserWithFeature(ctx, req, 'research');
        return {
          publications: await listPublications(
            ctx.pool,
            s.user.id,
            req.query.projectId,
            req.query.interestId,
          ),
        };
      },
    );
  };
}
