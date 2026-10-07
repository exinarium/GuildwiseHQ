import { OrgChartSchema } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireOrg } from '../auth/guards.ts';
import type { Ctx } from '../context.ts';
import { getOrgChart } from '../queries/org-chart.ts';
import { typed } from './util.ts';

/** The org chart (Organization, Org chart): visible to the organization's members, never to guests of it. */
export function orgChartRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);
    app.get('/api/org-chart', async (req) => {
      const a = await requireOrg(ctx, req);
      return OrgChartSchema.parse(await getOrgChart(ctx.pool, a.orgId, ctx.clock.now()));
    });
  };
}
