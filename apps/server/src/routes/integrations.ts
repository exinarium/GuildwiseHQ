import {
  INTEGRATION_KINDS,
  INTEGRATIONS_REGISTRY_VERSION,
  IntegrationActionRequestSchema,
  IntegrationConnectRequestSchema,
  IntegrationInputRequestSchema,
  IntegrationSessionRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/guards.ts';
import {
  listIntegrationWorkstations,
  readIntegrationRequest,
  readWorkstationIntegrations,
  requestConnect,
  requestRemove,
  requestSession,
  requestSessionCancel,
  requestSessionInput,
  requestTest,
} from '../commands/integrations.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

const Ws = z.object({ id: z.uuid() });
const WsReq = z.object({ id: z.uuid(), rid: z.uuid() });
const WsSession = z.object({ id: z.uuid(), sid: z.uuid() });

/**
 * The Integrations page (docs/design/integrations-page.md section 5.4). Every route needs the signed-in user and, for a
 * workstation, that it is that user's own: anyone else gets a 404. Bodies carry sealed envelopes only; they are never logged
 * (the app's pino `redact` covers `envelope`), echoed or stored beyond the command row.
 */
export function integrationRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);
    const limit = (max: number, timeWindow: string, perWorkstation = false) =>
      ctx.config.rateLimit
        ? {
            config: {
              rateLimit: {
                max,
                timeWindow,
                ...(perWorkstation
                  ? {
                      keyGenerator: (req: { params?: unknown; ip: string }) =>
                        String((req.params as { id?: string })?.id ?? req.ip),
                    }
                  : {}),
              },
            },
          }
        : {};

    /** The registry (static, cacheable): the page also has it compiled in; this serves other clients and the check below. */
    app.get('/api/integrations/registry', async (req, reply) => {
      await requireUser(ctx, req);
      reply.header('cache-control', 'private, max-age=300');
      return { version: INTEGRATIONS_REGISTRY_VERSION, kinds: INTEGRATION_KINDS };
    });

    app.get('/api/integrations/workstations', async (req) => {
      const s = await requireUser(ctx, req);
      return { workstations: await listIntegrationWorkstations(ctx, s.user) };
    });

    app.get(
      '/api/workstations/:id/integrations',
      { schema: { params: Ws }, ...limit(60, '1 minute') },
      async (req) => {
        const s = await requireUser(ctx, req);
        return readWorkstationIntegrations(ctx, s.user, req.params.id);
      },
    );

    app.post(
      '/api/workstations/:id/integrations/connect',
      { schema: { params: Ws, body: IntegrationConnectRequestSchema }, ...limit(10, '1 minute') },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        reply.code(202);
        return requestConnect(ctx, s.user, req.params.id, req.body);
      },
    );

    app.get(
      '/api/workstations/:id/integrations/requests/:rid',
      { schema: { params: WsReq }, ...limit(120, '1 minute') },
      async (req) => {
        const s = await requireUser(ctx, req);
        return readIntegrationRequest(ctx, s.user, req.params.id, req.params.rid);
      },
    );

    app.post(
      '/api/workstations/:id/integrations/sessions',
      { schema: { params: Ws, body: IntegrationSessionRequestSchema }, ...limit(6, '10 minutes', true) },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        reply.code(202);
        return requestSession(ctx, s.user, req.params.id, req.body);
      },
    );

    app.post(
      '/api/workstations/:id/integrations/sessions/:sid/input',
      { schema: { params: WsSession, body: IntegrationInputRequestSchema }, ...limit(10, '1 minute') },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        reply.code(202);
        return requestSessionInput(ctx, s.user, req.params.id, req.params.sid, req.body);
      },
    );

    app.post(
      '/api/workstations/:id/integrations/sessions/:sid/cancel',
      { schema: { params: WsSession }, ...limit(30, '1 minute') },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        reply.code(202);
        return requestSessionCancel(ctx, s.user, req.params.id, req.params.sid);
      },
    );

    app.post(
      '/api/workstations/:id/integrations/test',
      { schema: { params: Ws, body: IntegrationActionRequestSchema }, ...limit(30, '1 minute') },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        reply.code(202);
        return requestTest(ctx, s.user, req.params.id, req.body);
      },
    );

    app.post(
      '/api/workstations/:id/integrations/remove',
      { schema: { params: Ws, body: IntegrationActionRequestSchema }, ...limit(10, '1 minute') },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        reply.code(202);
        return requestRemove(ctx, s.user, req.params.id, req.body);
      },
    );
  };
}
