import {
  ArchiveQuerySchema,
  BoardQuerySchema,
  CancelCardRequestSchema,
  CardParamsSchema,
  CardSearchQuerySchema,
  CommentRequestSchema,
  CreateCardRequestSchema,
  MoveCardRequestSchema,
  PatchCardRequestSchema,
  ReleaseCardRequestSchema,
  ReopenCardRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guards.ts';
import { loadVisibleCard } from '../authz/scope.ts';
import { handleMentions } from '../commands/agent-mentions.ts';
import { sendCardToBa } from '../commands/ba-intake.ts';
import {
  cancelCard,
  commentOnCard,
  createCard,
  moveCardWithNotice,
  patchCard,
  releaseBackoff,
  releaseCard,
  reopenCard,
  specifyCard,
} from '../commands/cards.ts';
import type { Ctx } from '../context.ts';
import { iso, one } from '../db/sql.ts';
import { getArchive, getBoard, getCardDetail, searchCards, toCardDto } from '../queries/cards.ts';
import { typed } from './util.ts';

export function cardRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/board', { schema: { querystring: BoardQuerySchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return getBoard(ctx, s.user.id, req.query.projectId, req.query.phaseId);
    });

    app.get('/api/archive', { schema: { querystring: ArchiveQuerySchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return getArchive(ctx, s.user.id, req.query);
    });

    app.get('/api/search/cards', { schema: { querystring: CardSearchQuerySchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return searchCards(ctx.pool, s.user.id, req.query.q, req.query.limit);
    });

    app.post('/api/cards', { schema: { body: CreateCardRequestSchema } }, async (req, reply) => {
      const s = await requireUser(ctx, req);
      const { cardId, missing, scoping } = await createCard(ctx, s.user, req.body);
      const { card } = await loadVisibleCard(ctx.pool, s.user.id, cardId);
      reply.code(201);
      return {
        card: await toCardDto(ctx, card),
        ...(missing
          ? {
              missing,
              specified: false,
              ...(scoping ? { baQueued: scoping.queued } : {}),
              message: scoping
                ? `Saved as a draft: ${scoping.text}.`
                : `Saved as a draft, not specified: required fields are missing (${missing.join(', ')}).`,
            }
          : req.body.specify
            ? { specified: true }
            : {}),
      };
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

    app.post('/api/cards/:id/send-to-ba', { schema: { params: CardParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      const { cardId, next } = await sendCardToBa(ctx, s.user, req.params.id);
      return { ...(await getCardDetail(ctx, s.user.id, cardId)), baNotice: next.text };
    });

    app.post(
      '/api/cards/:id/comments',
      { schema: { params: CardParamsSchema, body: CommentRequestSchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        const { cardId, messageId } = await commentOnCard(ctx, s.user, req.params.id, req.body.body);
        // @agent mentions (S-B2): started after the comment is saved; a refusal never fails the comment
        const mentions = await handleMentions(ctx, s.user, cardId, messageId, req.body.body).catch((err) => {
          ctx.log.error({ err }, 'mentions failed');
          return [];
        });
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
          ...(mentions.length ? { mentions } : {}),
        };
      },
    );

    app.post(
      '/api/cards/:id/move',
      { schema: { params: CardParamsSchema, body: MoveCardRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        const moved = await moveCardWithNotice(ctx, s.user, req.params.id, req.body.toStage, req.body.reason);
        const detail = await getCardDetail(ctx, s.user.id, moved.cardId);
        return moved.notice ? { ...detail, moveNotice: moved.notice } : detail;
      },
    );

    app.post(
      '/api/cards/:id/reopen',
      { schema: { params: CardParamsSchema, body: ReopenCardRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        const id = await reopenCard(ctx, s.user, req.params.id, req.body.toStage, req.body.reason);
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
        const id = await cancelCard(ctx, s.user, req.params.id, req.body.reason, {
          alsoCancelChildren: req.body.alsoCancelChildren,
        });
        return getCardDetail(ctx, s.user.id, id);
      },
    );
  };
}
