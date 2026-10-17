import { ApprovalApproveRequestSchema, ApprovalSendBackRequestSchema, CardParamsSchema } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guards.ts';
import { approveStep, cardDiff, sendBackStep } from '../commands/approval.ts';
import type { Ctx } from '../context.ts';
import { getCardDetail } from '../queries/cards.ts';
import { typed } from './util.ts';

/** Approval steps (backlog #16): approve, or send back with a comment. */
export function approvalRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.post(
      '/api/cards/:id/approval/approve',
      { schema: { params: CardParamsSchema, body: ApprovalApproveRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await approveStep(ctx, s.user, req.params.id, req.body);
        return getCardDetail(ctx, s.user.id, req.params.id);
      },
    );

    /** The diff the runner uploaded at the review handoff (code-v6), for the owner approval's diff view. */
    app.get('/api/cards/:id/diff', { schema: { params: CardParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return cardDiff(ctx.pool, s.user, req.params.id);
    });

    app.post(
      '/api/cards/:id/approval/send-back',
      { schema: { params: CardParamsSchema, body: ApprovalSendBackRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await sendBackStep(ctx, s.user, req.params.id, req.body);
        return getCardDetail(ctx, s.user.id, req.params.id);
      },
    );
  };
}
