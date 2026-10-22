import { ListCapabilitiesQuerySchema } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireOrg } from '../auth/guards.ts';
import { effectiveRegistry } from '../capabilities/registry.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

/** Capability Registry v0: the effective registry of the tab's organization (metadata only). */
export function capabilityRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);
    app.get('/api/capabilities', { schema: { querystring: ListCapabilitiesQuerySchema } }, async (req) => {
      const a = await requireOrg(ctx, req, { min: 'member' });
      return effectiveRegistry(ctx.pool, a.orgId, req.query.kind);
    });
  };
}
