import { ChatParamsSchema, CreateChatRequestSchema } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guards.ts';
import { createChat, getChat, listChats } from '../commands/chats.ts';
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

    app.get('/api/chats/:id', { schema: { params: ChatParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return { chat: await getChat(ctx, s.user.id, req.params.id) };
    });
  };
}
