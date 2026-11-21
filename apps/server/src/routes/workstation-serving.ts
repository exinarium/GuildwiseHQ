import { SetWorkstationServingRequestSchema, WorkstationOrgParamsSchema } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guards.ts';
import { listWorkstationServing, setWorkstationServing } from '../commands/workstation-serving.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

/** "Works for" (R9, audit F4): the organizations each of your workstations runs work for. The workstation's owner only. */
export function workstationServingRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/workstations/serving', async (req) => {
      const s = await requireUser(ctx, req);
      return listWorkstationServing(ctx.pool, s.user);
    });

    app.put(
      '/api/workstations/:id/orgs/:orgId',
      { schema: { params: WorkstationOrgParamsSchema, body: SetWorkstationServingRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        const r = await setWorkstationServing(ctx, s.user, req.params.id, req.params.orgId, req.body.serving);
        // Switched on: waiting work of that organization may start there; switched off: its agents need a new home.
        if (r.changed) ctx.services.dispatcher.trigger();
        return { workstationId: req.params.id, orgId: req.params.orgId, serving: req.body.serving };
      },
    );
  };
}
