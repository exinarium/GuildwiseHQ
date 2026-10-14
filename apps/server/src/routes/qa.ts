import {
  CardParamsSchema,
  QaAssignRequestSchema,
  QaPassRequestSchema,
  QaSendBackRequestSchema,
  QaSkipRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guards.ts';
import { assignQa, passQa, sendBackQa, skipQa } from '../commands/qa.ts';
import type { Ctx } from '../context.ts';
import { getCardDetail } from '../queries/cards.ts';
import { typed } from './util.ts';

/** Manual QA actions on a card (docs/design/manual-qa.md): pass, skip, send back, hand over. */
export function qaRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.post(
      '/api/cards/:id/qa/pass',
      { schema: { params: CardParamsSchema, body: QaPassRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await passQa(ctx, s.user, req.params.id, req.body);
        return getCardDetail(ctx, s.user.id, req.params.id);
      },
    );

    app.post(
      '/api/cards/:id/qa/skip',
      { schema: { params: CardParamsSchema, body: QaSkipRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await skipQa(ctx, s.user, req.params.id, req.body);
        return getCardDetail(ctx, s.user.id, req.params.id);
      },
    );

    app.post(
      '/api/cards/:id/qa/send-back',
      { schema: { params: CardParamsSchema, body: QaSendBackRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await sendBackQa(ctx, s.user, req.params.id, req.body);
        return getCardDetail(ctx, s.user.id, req.params.id);
      },
    );

    app.post(
      '/api/cards/:id/qa/assign',
      { schema: { params: CardParamsSchema, body: QaAssignRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await assignQa(ctx, s.user, req.params.id, req.body);
        return getCardDetail(ctx, s.user.id, req.params.id);
      },
    );
  };
}
