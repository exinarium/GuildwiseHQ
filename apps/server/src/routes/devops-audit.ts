import { DevopsCommandLogQuerySchema, IdParamsSchema } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireOrg, requireUser } from '../auth/guards.ts';
import { orgDevopsAudit, workstationDevopsAudit } from '../commands/runner-telemetry.ts';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import { notFound } from '../errors.ts';
import { typed } from './util.ts';

/**
 * The DevOps command log (R17-4), for the people it belongs to: the organization's Owner (commands of its DevOps
 * shifts) and the workstation's owner (everything run on that machine). The platform sees counts only.
 */
export function devopsAuditRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get(
      '/api/org/devops-audit',
      { schema: { querystring: DevopsCommandLogQuerySchema } },
      async (req) => {
        const a = await requireOrg(ctx, req);
        if (a.role !== 'owner') throw notFound();
        return {
          entries: await orgDevopsAudit(ctx, a.orgId, {
            limit: req.query.limit,
            refusedOnly: req.query.refused === 'true',
          }),
        };
      },
    );

    app.get(
      '/api/workstations/:id/devops-audit',
      { schema: { params: IdParamsSchema, querystring: DevopsCommandLogQuerySchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        const w = await one(ctx.pool, 'SELECT user_id FROM workstations WHERE id=$1', [req.params.id]);
        if (w?.user_id !== s.user.id) throw notFound('workstation not found');
        return {
          entries: await workstationDevopsAudit(ctx, req.params.id, {
            limit: req.query.limit,
            refusedOnly: req.query.refused === 'true',
          }),
        };
      },
    );
  };
}
