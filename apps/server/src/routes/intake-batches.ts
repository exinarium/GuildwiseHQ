import { BatchItemParamsSchema, BatchParamsSchema, CreateBatchRequestSchema } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireOrg } from '../auth/guards.ts';
import { cancelBatch, createBatch, getBatch, listBatches, retryBatchItem } from '../commands/intake-batch.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

/** Batch intake (#63): hand the BA a list of tickets. Same rights as starting an intake chat (Owner and Admins). */
export function intakeBatchRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);
    const guard = (req: Parameters<typeof requireOrg>[1]) =>
      requireOrg(ctx, req, { min: 'admin', feature: 'integrations' });

    app.get('/api/intake/batches', async (req) => {
      const a = await guard(req);
      return { batches: await listBatches(ctx, a.orgId) };
    });

    app.post('/api/intake/batches', { schema: { body: CreateBatchRequestSchema } }, async (req, reply) => {
      const a = await guard(req);
      const batch = await createBatch(ctx, a.session.user, { id: a.orgId, role: a.role }, req.body);
      reply.code(201);
      return { batch };
    });

    app.get('/api/intake/batches/:id', { schema: { params: BatchParamsSchema } }, async (req) => {
      const a = await guard(req);
      return { batch: await getBatch(ctx, a.orgId, req.params.id) };
    });

    app.post('/api/intake/batches/:id/cancel', { schema: { params: BatchParamsSchema } }, async (req) => {
      const a = await guard(req);
      return { batch: await cancelBatch(ctx, a.session.user, { id: a.orgId, role: a.role }, req.params.id) };
    });

    app.post(
      '/api/intake/batches/:id/items/:itemId/retry',
      { schema: { params: BatchItemParamsSchema } },
      async (req) => {
        const a = await guard(req);
        return {
          batch: await retryBatchItem(
            ctx,
            a.session.user,
            { id: a.orgId, role: a.role },
            req.params.id,
            req.params.itemId,
          ),
        };
      },
    );
  };
}
