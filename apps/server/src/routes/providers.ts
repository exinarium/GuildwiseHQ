import {
  AccountSharingRequestSchema,
  IdParamsSchema,
  PrivateEndpointsSetSchema,
  ProviderAccountKeySchema,
  ProviderAccountPromotePayloadSchema,
  ProviderKeyIdSchema,
  SetProviderKeyRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/guards.ts';
import {
  clearProviderKey,
  promoteAccount,
  setAccountSharing,
  setPrivateEndpoints,
  setProviderKey,
  workstationAiRuntimes,
  workstationProviders,
} from '../commands/provider-keys.ts';
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

    // The private-endpoint allow-list (R2): the workstation's owner only.
    app.put(
      '/api/workstations/:id/private-endpoints',
      { schema: { params: IdParamsSchema, body: PrivateEndpointsSetSchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        const endpoints = await setPrivateEndpoints(ctx, s.user, req.params.id, req.body.endpoints);
        reply.code(202);
        return { queued: true, endpoints };
      },
    );

    app.delete(
      '/api/workstations/:id/providers/:provider',
      {
        schema: {
          params: ProviderParamsSchema,
          querystring: z.object({ account: ProviderAccountKeySchema.optional() }),
        },
      },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        await clearProviderKey(ctx, s.user, req.params.id, req.params.provider, req.query.account);
        reply.code(202);
        return { queued: true };
      },
    );

    // Integrations > AI runtime (S-A): the runtimes and providers with their accounts, and "Make main".
    app.get('/api/workstations/:id/ai-runtimes', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return workstationAiRuntimes(ctx, s.user, req.params.id);
    });

    app.put(
      '/api/workstations/:id/account-sharing',
      { schema: { params: IdParamsSchema, body: AccountSharingRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await setAccountSharing(ctx, s.user, req.params.id, req.body.allow);
        return { allow: req.body.allow };
      },
    );

    app.post(
      '/api/workstations/:id/accounts/promote',
      { schema: { params: IdParamsSchema, body: ProviderAccountPromotePayloadSchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        await promoteAccount(ctx, s.user, req.params.id, req.body);
        reply.code(202);
        return { queued: true };
      },
    );
  };
}
