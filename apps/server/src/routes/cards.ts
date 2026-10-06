import {
  BoardQuerySchema,
  CancelCardRequestSchema,
  CardParamsSchema,
  CardSearchQuerySchema,
  CommentRequestSchema,
  CreateCardRequestSchema,
  MoveCardRequestSchema,
  PatchCardRequestSchema,
  ReleaseCardRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guards.ts';
import { loadVisibleCard } from '../authz/scope.ts';
import {
  cancelCard,
  commentOnCard,
  createCard,
  moveCard,
  patchCard,
  releaseBackoff,
  releaseCard,
  specifyCard,
} from '../commands/cards.ts';
import type { Ctx } from '../context.ts';
import { iso, one } from '../db/sql.ts';
import { getBoard, getCardDetail, searchCards, toCardDto } from '../queries/cards.ts';
import { typed } from './util.ts';

export function cardRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/board', { schema: { querystring: BoardQuerySchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return getBoard(ctx, s.user.id, req.query.projectId, req.query.phaseId);
    });

    app.get('/api/search/cards', { schema: { querystring: CardSearchQuerySchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return searchCards(ctx.pool, s.user.id, req.query.q, req.query.limit);
    });

    app.post('/api/cards', { schema: { body: CreateCardRequestSchema } }, async (req, reply) => {
      const s = await requireUser(ctx, req);
      const { cardId, missing } = await createCard(ctx, s.user, req.body);
      const { card } = await loadVisibleCard(ctx.pool, s.user.id, cardId);
      reply.code(201);
      return { card: await toCardDto(ctx, card), ...(missing ? { missing } : {}) };
    });

    app.get('/api/cards/:id', { schema: { params: CardParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return getCardDetail(ctx, s.user.id, req.params.id);
    });

    app.patch(
      '/api/cards/:id',
      { schema: { params: CardParamsSchema, body: PatchCardRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        const id = await patchCard(ctx, s.user, req.params.id, req.body);
        return getCardDetail(ctx, s.user.id, id);
      },
    );

    app.post('/api/cards/:id/specify', { schema: { params: CardParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      const id = await specifyCard(ctx, s.user, req.params.id);
      return getCardDetail(ctx, s.user.id, id);
    });

    app.post(
      '/api/cards/:id/comments',
      { schema: { params: CardParamsSchema, body: CommentRequestSchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        const { cardId, messageId } = await commentOnCard(ctx, s.user, req.params.id, req.body.body);
        const m = await one(
          ctx.pool,
          `SELECT m.*, u.display_name AS user_name FROM thread_messages m LEFT JOIN users u ON u.id = m.author_user_id WHERE m.id=$1`,
          [messageId],
        );
        reply.code(201);
        return {
          id: messageId,
          threadId: cardId,
          authorKind: 'user',
          authorUserId: s.user.id,
          authorAgentId: null,
          authorName: m?.user_name ?? s.user.displayName,
          kind: 'comment',
          body: req.body.body,
          data: {},
          createdAt: iso(m?.created_at) ?? ctx.clock.now().toISOString(),
        };
      },
    );

    app.post(
      '/api/cards/:id/move',
      { schema: { params: CardParamsSchema, body: MoveCardRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        const id = await moveCard(ctx, s.user, req.params.id, req.body.toStage, req.body.reason);
        return getCardDetail(ctx, s.user.id, id);
      },
    );

    app.post(
      '/api/cards/:id/release',
      { schema: { params: CardParamsSchema, body: ReleaseCardRequestSchema.optional() } },
      async (req) => {
        const s = await requireUser(ctx, req);
        const id = await releaseCard(ctx, s.user, req.params.id, req.body?.reason);
        return getCardDetail(ctx, s.user.id, id);
      },
    );

    app.post(
      '/api/cards/:id/release-backoff',
      { schema: { params: CardParamsSchema, body: ReleaseCardRequestSchema.optional() } },
      async (req) => {
        const s = await requireUser(ctx, req);
        const id = await releaseBackoff(ctx, s.user, req.params.id, req.body?.reason);
        return getCardDetail(ctx, s.user.id, id);
      },
    );

    app.post(
      '/api/cards/:id/cancel',
      { schema: { params: CardParamsSchema, body: CancelCardRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        const id = await cancelCard(ctx, s.user, req.params.id, req.body.reason);
        return getCardDetail(ctx, s.user.id, id);
      },
    );
  };
}
