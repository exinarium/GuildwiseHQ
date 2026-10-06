import {
  AgentStatsResponseSchema,
  HrBoardQuerySchema,
  IdParamsSchema,
  MetricsQuerySchema,
  RecommendationIdParamsSchema,
  RoleKeyParamsSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireOrg } from '../auth/guards.ts';
import { whoOf } from '../auth/org-context.ts';
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
      return hrBoard(ctx, whoOf(await requireOrg(ctx, req)), req.query.projectId, req.query.department);
    });

    app.get('/api/agents/:id/stats', { schema: { params: IdParamsSchema } }, async (req) => {
      const a = await requireOrg(ctx, req);
      return AgentStatsResponseSchema.parse(await agentStats(ctx, whoOf(a), req.params.id));
    });

    app.get('/api/hr/recommendations', { schema: { querystring: HrBoardQuerySchema } }, async (req) => {
      const a = await requireOrg(ctx, req);
      return {
        recommendations: (await listRecommendations(ctx, whoOf(a), req.query.projectId)).map((l) => l.rec),
      };
    });

    app.post(
      '/api/hr/recommendations/:id/apply',
      { schema: { params: RecommendationIdParamsSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req);
        return applyRecommendation(ctx, a.session.user, whoOf(a), req.params.id);
      },
    );

    app.get('/api/hr/role-updates', async (req) => {
      const a = await requireOrg(ctx, req);
      return { roleUpdates: await roleUpdates(ctx, whoOf(a)) };
    });

    app.post('/api/hr/roles/:key/reset', { schema: { params: RoleKeyParamsSchema } }, async (req) => {
      const a = await requireOrg(ctx, req);
      return resetRole(ctx, a.session.user, whoOf(a), req.params.key);
    });

    app.get('/api/metrics', { schema: { querystring: MetricsQuerySchema } }, async (req) => {
      const a = await requireOrg(ctx, req);
      return metrics(ctx, whoOf(a), req.query);
    });
  };
}
