import { RelayIntegrationCreateSchema } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOrg } from '../auth/guards.ts';
import {
  createRelayIntegration,
  listRelayIntegrations,
  relayStatuses,
  revokeRelayIntegration,
  rotateRelayIntegration,
} from '../commands/relay-integrations.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

const IdParams = z.object({ id: z.uuid() });

/**
 * Inbound relay integrations of a Business mode organization. The Owner and Admins manage them; any member reads the
 * list and the status. The public URL is in the answer of create and rotate only, and is never stored.
 */
export function relayIntegrationRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.post('/api/relay/integrations', { schema: { body: RelayIntegrationCreateSchema } }, async (req, reply) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      const out = await createRelayIntegration(ctx, a.session.user.id, a.orgId, req.body);
      reply.code(201);
      return out;
    });

    app.get('/api/relay/integrations', async (req) => {
      const a = await requireOrg(ctx, req);
      return { integrations: await listRelayIntegrations(ctx, a.orgId) };
    });

    app.get('/api/relay/integrations/status', async (req) => {
      const a = await requireOrg(ctx, req);
      return { statuses: await relayStatuses(ctx, a.orgId) };
    });

    app.post('/api/relay/integrations/:id/rotate', { schema: { params: IdParams } }, async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      return rotateRelayIntegration(ctx, a.session.user.id, a.orgId, req.params.id);
    });

    app.post('/api/relay/integrations/:id/revoke', { schema: { params: IdParams } }, async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      return { integration: await revokeRelayIntegration(ctx, a.session.user.id, a.orgId, req.params.id) };
    });
  };
}
