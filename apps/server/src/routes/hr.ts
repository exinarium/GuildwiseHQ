import {
  AgentStatsResponseSchema,
  HrBoardQuerySchema,
  IdParamsSchema,
  MetricsQuerySchema,
  RecommendationIdParamsSchema,
  RoleKeyParamsSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guards.ts';
import type { Ctx } from '../context.ts';
import {
  agentStats,
  applyRecommendation,
  hrBoard,
  listRecommendations,
  resetRole,
  roleUpdates,
} from '../hr/hr.ts';
import { metrics } from '../hr/metrics.ts';
import { typed } from './util.ts';

export function hrRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/hr/board', { schema: { querystring: HrBoardQuerySchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return hrBoard(ctx, s.user.id, req.query.projectId);
    });

    app.get('/api/agents/:id/stats', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return AgentStatsResponseSchema.parse(await agentStats(ctx, s.user.id, req.params.id));
    });

    app.get('/api/hr/recommendations', { schema: { querystring: HrBoardQuerySchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return {
        recommendations: (await listRecommendations(ctx, s.user.id, req.query.projectId)).map((l) => l.rec),
      };
    });

    app.post(
      '/api/hr/recommendations/:id/apply',
      { schema: { params: RecommendationIdParamsSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        return applyRecommendation(ctx, s.user, req.params.id);
      },
    );

    app.get('/api/hr/role-updates', async (req) => {
      const s = await requireUser(ctx, req);
      return { roleUpdates: await roleUpdates(ctx, s.user.id) };
    });

    app.post('/api/hr/roles/:key/reset', { schema: { params: RoleKeyParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return resetRole(ctx, s.user, req.params.key);
    });

    app.get('/api/metrics', { schema: { querystring: MetricsQuerySchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return metrics(ctx, s.user.id, req.query);
    });
  };
}
