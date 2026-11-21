import { IdParamsSchema, OwnershipTransferSchema } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guards.ts';
import { requireStepUp } from '../auth/step-up.ts';
import { decideTransfer, transferForOwner } from '../commands/platform-transfer.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

/**
 * The Owner's side of a platform ownership transfer (R17-3): the consent page reads it, and the Owner approves (signed in,
 * with "Confirm it's you") or vetoes. Only the organization's current Owner sees it; 404 for everyone else.
 */
export function ownershipTransferRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/org/ownership-transfers/:id', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return OwnershipTransferSchema.parse(await transferForOwner(ctx, s, req.params.id));
    });
    app.post(
      '/api/org/ownership-transfers/:id/approve',
      { schema: { params: IdParamsSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await transferForOwner(ctx, s, req.params.id);
        requireStepUp(ctx, s);
        return OwnershipTransferSchema.parse(await decideTransfer(ctx, s, req.params.id, 'approved'));
      },
    );
    app.post('/api/org/ownership-transfers/:id/veto', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return OwnershipTransferSchema.parse(await decideTransfer(ctx, s, req.params.id, 'vetoed'));
    });
  };
}
