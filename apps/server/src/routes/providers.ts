import { IdParamsSchema, ProviderKeyIdSchema, SetProviderKeyRequestSchema } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/guards.ts';
import { clearProviderKey, setProviderKey, workstationProviders } from '../commands/provider-keys.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

const ProviderParamsSchema = z.object({ id: z.uuid(), provider: ProviderKeyIdSchema });

/** Provider keys of the direct-model runtime: the owner's workstation only; the key is sealed in the browser (section 38.3). */
export function providerRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/workstations/:id/providers', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return workstationProviders(ctx, s.user, req.params.id);
    });

    app.put(
      '/api/workstations/:id/providers/:provider',
      { schema: { params: ProviderParamsSchema, body: SetProviderKeyRequestSchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        await setProviderKey(ctx, s.user, req.params.id, req.params.provider, req.body);
        reply.code(202);
        return { queued: true };
      },
    );

    app.delete(
      '/api/workstations/:id/providers/:provider',
      { schema: { params: ProviderParamsSchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        await clearProviderKey(ctx, s.user, req.params.id, req.params.provider);
        reply.code(202);
        return { queued: true };
      },
    );
  };
}
