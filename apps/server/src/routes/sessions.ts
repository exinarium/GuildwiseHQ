import {
  ArchiveSessionRequestSchema,
  CreateSessionRequestSchema,
  ListSessionsQuerySchema,
  ParticipantInputSchema,
  PatchParticipantRequestSchema,
  PatchSessionRequestSchema,
  PostSessionMessageRequestSchema,
  QueueTurnRequestSchema,
  PostSessionMessageRequestSchema as SayRequestSchema,
  SessionParamsSchema,
  SessionParticipantParamsSchema,
  SessionTurnParamsSchema,
  StartPersonaChatRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireOrg } from '../auth/guards.ts';
import { whoOf } from '../auth/org-context.ts';
import {
  addParticipant,
  createSession,
  deleteSession,
  getSession,
  listSessions,
  patchSession,
  postSessionMessage,
  removeParticipant,
  setSessionArchived,
  updateParticipant,
} from '../commands/sessions.ts';
import type { Ctx } from '../context.ts';
import { sayToPersona, startPersonaChat } from '../sessions/persona-chat.ts';
import { typed } from './util.ts';

/**
 * Discovery and boardroom sessions: threads with participants and durable turns. The messages of a session are read with
 * `GET /api/threads/:id/messages`; live replies stream over the browser socket (`chat.delta`, `chat.done`, `session.turn`).
 */
export function sessionRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.post('/api/sessions', { schema: { body: CreateSessionRequestSchema } }, async (req, reply) => {
      const a = await requireOrg(ctx, req);
      const session = await createSession(ctx, whoOf(a), req.body);
      reply.code(201);
      return { session };
    });

    app.get('/api/sessions', { schema: { querystring: ListSessionsQuerySchema } }, async (req) => {
      const a = await requireOrg(ctx, req);
      return { sessions: await listSessions(ctx, whoOf(a), req.query) };
    });

    app.get('/api/sessions/:id', { schema: { params: SessionParamsSchema } }, async (req) => {
      const a = await requireOrg(ctx, req);
      return { session: await getSession(ctx, a.session.user.id, req.params.id) };
    });

    app.patch(
      '/api/sessions/:id',
      { schema: { params: SessionParamsSchema, body: PatchSessionRequestSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req);
        return { session: await patchSession(ctx, a.session.user.id, req.params.id, req.body) };
      },
    );

    app.post(
      '/api/sessions/:id/archive',
      { schema: { params: SessionParamsSchema, body: ArchiveSessionRequestSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req);
        return {
          session: await setSessionArchived(ctx, a.session.user.id, req.params.id, req.body.archived),
        };
      },
    );

    app.delete('/api/sessions/:id', { schema: { params: SessionParamsSchema } }, async (req, reply) => {
      const a = await requireOrg(ctx, req);
      await deleteSession(ctx, a.session.user.id, req.params.id);
      reply.code(204);
    });

    app.post(
      '/api/sessions/:id/participants',
      { schema: { params: SessionParamsSchema, body: ParticipantInputSchema } },
      async (req, reply) => {
        const a = await requireOrg(ctx, req);
        reply.code(201);
        return { participant: await addParticipant(ctx, a.session.user.id, req.params.id, req.body) };
      },
    );

    app.patch(
      '/api/sessions/:id/participants/:participantId',
      { schema: { params: SessionParticipantParamsSchema, body: PatchParticipantRequestSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req);
        return {
          participant: await updateParticipant(
            ctx,
            a.session.user.id,
            req.params.id,
            req.params.participantId,
            req.body,
          ),
        };
      },
    );

    app.delete(
      '/api/sessions/:id/participants/:participantId',
      { schema: { params: SessionParticipantParamsSchema } },
      async (req, reply) => {
        const a = await requireOrg(ctx, req);
        await removeParticipant(ctx, a.session.user.id, req.params.id, req.params.participantId);
        reply.code(204);
      },
    );

    app.post(
      '/api/sessions/:id/messages',
      { schema: { params: SessionParamsSchema, body: PostSessionMessageRequestSchema } },
      async (req, reply) => {
        const a = await requireOrg(ctx, req);
        reply.code(201);
        return { message: await postSessionMessage(ctx, a.session.user.id, req.params.id, req.body) };
      },
    );

    app.get('/api/sessions/:id/turns', { schema: { params: SessionParamsSchema } }, async (req) => {
      const a = await requireOrg(ctx, req);
      return { turns: await ctx.services.sessions.list(a.session.user.id, req.params.id) };
    });

    app.post(
      '/api/sessions/:id/turns',
      { schema: { params: SessionParamsSchema, body: QueueTurnRequestSchema } },
      async (req, reply) => {
        const a = await requireOrg(ctx, req);
        const turn = await ctx.services.sessions.queue(a.session.user.id, req.params.id, req.body);
        reply.code(202);
        return { turn };
      },
    );

    // Chat with a persona that is not hired: a one-to-one session on the user's own workstation (R3a).
    app.post(
      '/api/persona-chats',
      { schema: { body: StartPersonaChatRequestSchema } },
      async (req, reply) => {
        const a = await requireOrg(ctx, req);
        reply.code(201);
        return { session: await startPersonaChat(ctx, whoOf(a), req.body) };
      },
    );
    app.post(
      '/api/persona-chats/:id/say',
      { schema: { params: SessionParamsSchema, body: SayRequestSchema.pick({ body: true }) } },
      async (req, reply) => {
        const a = await requireOrg(ctx, req);
        reply.code(202);
        return sayToPersona(ctx, a.session.user.id, req.params.id, req.body.body);
      },
    );

    app.post(
      '/api/sessions/:id/turns/:turnId/cancel',
      { schema: { params: SessionTurnParamsSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req);
        return {
          turn: await ctx.services.sessions.cancel(a.session.user.id, req.params.id, req.params.turnId),
        };
      },
    );
  };
}
