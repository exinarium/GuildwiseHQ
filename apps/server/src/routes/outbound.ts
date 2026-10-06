import {
  CardParamsSchema,
  CreateOutboundDraftRequestSchema,
  OutboundListQuerySchema,
  OutboundParamsSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireUserWithFeature } from '../auth/guards.ts';
import { createManagerDraft } from '../commands/drafts.ts';
import { getOutboundDto, listOutbound, retryOutbound } from '../commands/outbox.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

/**
 * Outbound updates (M8). Approving, editing and rejecting go through the decision desk (`POST /api/desk/:id/resolve`
 * on the `outbound` approval); these routes list the history per card, let the manager write an update themselves and
 * retry a failed post.
 */
export function outboundRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/outbound', { schema: { querystring: OutboundListQuerySchema } }, async (req) => {
      const s = await requireUserWithFeature(ctx, req, 'outbound');
      return { drafts: await listOutbound(ctx.pool, s.user, req.query) };
    });

    app.post(
      '/api/cards/:id/outbound',
      { schema: { params: CardParamsSchema, body: CreateOutboundDraftRequestSchema } },
      async (req, reply) => {
        const s = await requireUserWithFeature(ctx, req, 'outbound');
        const { draftId } = await createManagerDraft(ctx, s.user, req.params.id, req.body);
        reply.code(201);
        return { draft: await getOutboundDto(ctx.pool, draftId) };
      },
    );

    app.post('/api/outbound/:id/retry', { schema: { params: OutboundParamsSchema } }, async (req) => {
      const s = await requireUserWithFeature(ctx, req, 'outbound');
      const { workstationId } = await retryOutbound(ctx, s.user, req.params.id);
      if (workstationId) await ctx.services.gateway.deliverPending(workstationId);
      return { draft: await getOutboundDto(ctx.pool, req.params.id) };
    });
  };
}
