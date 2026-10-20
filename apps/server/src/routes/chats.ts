import { ArchiveAllChatsRequestSchema, ChatParamsSchema, CreateChatRequestSchema } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guards.ts';
import {
  archiveAllChats,
  createChat,
  deleteChat,
  getChat,
  listChats,
  setChatArchived,
} from '../commands/chats.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

export function chatRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/chats', async (req) => {
      const s = await requireUser(ctx, req);
      return { chats: await listChats(ctx, s.user.id) };
    });

    app.post('/api/chats', { schema: { body: CreateChatRequestSchema } }, async (req, reply) => {
      const s = await requireUser(ctx, req);
      const id = await createChat(ctx, s.user, req.body);
      reply.code(201);
      return { chat: await getChat(ctx, s.user.id, id) };
    });

    // Close (archive) and restore are per user; delete is permanent and only for the creator of a chat not linked to a card.
    // Registered before `/:id/...` routes: "archive-all" is a fixed path.
    app.post(
      '/api/chats/archive-all',
      { schema: { body: ArchiveAllChatsRequestSchema.nullish() } },
      async (req) => {
        const s = await requireUser(ctx, req);
        return { archived: await archiveAllChats(ctx, s.user, req.body?.exceptThreadIds) };
      },
    );

    app.post('/api/chats/:id/close', { schema: { params: ChatParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return { chat: await setChatArchived(ctx, s.user, req.params.id, true) };
    });

    app.post('/api/chats/:id/restore', { schema: { params: ChatParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return { chat: await setChatArchived(ctx, s.user, req.params.id, false) };
    });

    app.delete('/api/chats/:id', { schema: { params: ChatParamsSchema } }, async (req, reply) => {
      const s = await requireUser(ctx, req);
      await deleteChat(ctx, s.user, req.params.id);
      reply.code(204);
    });

    app.get('/api/chats/:id', { schema: { params: ChatParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return { chat: await getChat(ctx, s.user.id, req.params.id) };
    });
  };
}
