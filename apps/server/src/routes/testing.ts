import {
  CardParamsSchema,
  FinalizeCardRequestSchema,
  IdParamsSchema,
  RegressionRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guards.ts';
import { requestFinalize } from '../commands/finalize.ts';
import { requestRegression } from '../commands/regression.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

/** M4: manager-triggered finalize (until the BA exists) and regression runs. */
export function testingRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.post(
      '/api/cards/:id/finalize',
      { schema: { params: CardParamsSchema, body: FinalizeCardRequestSchema.default({}) } },
      async (req) => {
        const s = await requireUser(ctx, req);
        return requestFinalize(ctx, s.user, req.params.id, req.body);
      },
    );

    app.post(
      '/api/projects/:id/regression',
      { schema: { params: IdParamsSchema, body: RegressionRequestSchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        const r = await requestRegression(ctx, s.user, req.params.id, req.body.platform);
        ctx.services.dispatcher.trigger();
        reply.code(201);
        return r;
      },
    );
  };
}
