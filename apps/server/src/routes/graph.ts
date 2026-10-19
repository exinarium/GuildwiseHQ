import { IdParamsSchema } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireOrg } from '../auth/guards.ts';
import { projectGraphStatus, reindexProjectGraph } from '../commands/graph.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

/** Project graph STATUS (docs/design/project-graphs.md owner decision 5: no graph view, nothing code-derived). */
export function graphRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/projects/:id/graph', { schema: { params: IdParamsSchema } }, async (req) => {
      const a = await requireOrg(ctx, req);
      return projectGraphStatus(ctx, a.session.user, req.params.id);
    });

    app.post('/api/projects/:id/graph/index', { schema: { params: IdParamsSchema } }, async (req, reply) => {
      const a = await requireOrg(ctx, req);
      const r = await reindexProjectGraph(ctx, a.session.user, req.params.id);
      reply.code(202);
      return r;
    });
  };
}
