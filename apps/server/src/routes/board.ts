import {
  AddBoardNoteRequestSchema,
  BoardDecisionParamsSchema,
  BoardNoteParamsSchema,
  BoardParamsSchema,
  BoardResolveDecisionRequestSchema,
  BoardRoomParamsSchema,
  BoardSayRequestSchema,
  CreateBoardRequestSchema,
  MergeBoardNotesRequestSchema,
  PatchBoardNoteRequestSchema,
  PatchBoardRequestSchema,
  SaveBoardRoomRequestSchema,
  StartBoardRequestSchema,
  SuggestCastRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireOrg } from '../auth/guards.ts';
import { whoOf } from '../auth/org-context.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

/**
 * Boardroom (docs/ARCHITECTURE.md section 38.2). A boardroom is a session thread (`/api/sessions`, messages from
 * `GET /api/threads/:id/messages`); these routes are its orchestration: the state the page shows, the owner's messages and
 * decisions, the whiteboard, the minutes and "Pull into PRD", plus saved casts ("rooms"). Every response is the fresh `state`.
 */
export function boardRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);
    const svc = () => ctx.services.board;
    const uid = (req: Parameters<typeof requireOrg>[1]) =>
      requireOrg(ctx, req).then((a) => a.session.user.id);

    app.post('/api/board', { schema: { body: CreateBoardRequestSchema } }, async (req, reply) => {
      const a = await requireOrg(ctx, req);
      reply.code(201);
      return { state: await svc().create(whoOf(a), req.body) };
    });

    app.post('/api/board/suggest', { schema: { body: SuggestCastRequestSchema } }, async (req, reply) => {
      const a = await requireOrg(ctx, req);
      reply.code(201);
      return { state: await svc().suggest(whoOf(a), req.body) };
    });

    app.get('/api/board-rooms', async (req) => {
      const a = await requireOrg(ctx, req);
      return { rooms: await svc().listRooms(whoOf(a)) };
    });
    app.post('/api/board-rooms', { schema: { body: SaveBoardRoomRequestSchema } }, async (req, reply) => {
      const a = await requireOrg(ctx, req);
      reply.code(201);
      return { room: await svc().saveRoom(whoOf(a), req.body) };
    });
    app.delete('/api/board-rooms/:id', { schema: { params: BoardRoomParamsSchema } }, async (req, reply) => {
      const a = await requireOrg(ctx, req);
      await svc().deleteRoom(whoOf(a), req.params.id);
      reply.code(204);
    });

    app.get('/api/board/:id', { schema: { params: BoardParamsSchema } }, async (req) => ({
      state: await svc().state(await uid(req), req.params.id),
    }));

    app.post(
      '/api/board/:id/start',
      { schema: { params: BoardParamsSchema, body: StartBoardRequestSchema } },
      async (req) => ({ state: await svc().start(await uid(req), req.params.id, req.body) }),
    );

    app.patch(
      '/api/board/:id',
      { schema: { params: BoardParamsSchema, body: PatchBoardRequestSchema } },
      async (req) => ({ state: await svc().patch(await uid(req), req.params.id, req.body) }),
    );

    app.post(
      '/api/board/:id/say',
      { schema: { params: BoardParamsSchema, body: BoardSayRequestSchema } },
      async (req, reply) => {
        reply.code(201);
        return await svc().say(await uid(req), req.params.id, req.body.body);
      },
    );

    for (const verb of ['pause', 'resume', 'continue', 'end'] as const)
      app.post(`/api/board/:id/${verb}`, { schema: { params: BoardParamsSchema } }, async (req) => ({
        state: await svc()[verb](await uid(req), req.params.id),
      }));

    app.post('/api/board/:id/minutes', { schema: { params: BoardParamsSchema } }, async (req, reply) => {
      reply.code(202);
      return { state: await svc().requestMinutes(await uid(req), req.params.id) };
    });

    app.post(
      '/api/board/:id/pull-into-prd',
      { schema: { params: BoardParamsSchema } },
      async (req, reply) => {
        const a = await requireOrg(ctx, req);
        reply.code(201);
        return await svc().pullIntoPrd(whoOf(a), req.params.id);
      },
    );

    app.post(
      '/api/board/:id/decisions/:decisionId/resolve',
      { schema: { params: BoardDecisionParamsSchema, body: BoardResolveDecisionRequestSchema } },
      async (req) => ({
        state: await svc().resolveDecision(await uid(req), req.params.id, req.params.decisionId, req.body),
      }),
    );

    app.post(
      '/api/board/:id/notes',
      { schema: { params: BoardParamsSchema, body: AddBoardNoteRequestSchema } },
      async (req, reply) => {
        reply.code(201);
        return { state: await svc().addNote(await uid(req), req.params.id, req.body.column, req.body.text) };
      },
    );
    app.post(
      '/api/board/:id/notes/merge',
      { schema: { params: BoardParamsSchema, body: MergeBoardNotesRequestSchema } },
      async (req) => ({
        state: await svc().mergeNotes(await uid(req), req.params.id, req.body.noteIds, req.body.text),
      }),
    );
    app.patch(
      '/api/board/:id/notes/:noteId',
      { schema: { params: BoardNoteParamsSchema, body: PatchBoardNoteRequestSchema } },
      async (req) => ({
        state: await svc().patchNote(await uid(req), req.params.id, req.params.noteId, req.body),
      }),
    );
    app.delete(
      '/api/board/:id/notes/:noteId',
      { schema: { params: BoardNoteParamsSchema } },
      async (req) => ({
        state: await svc().removeNote(await uid(req), req.params.id, req.params.noteId),
      }),
    );
    app.post(
      '/api/board/:id/notes/:noteId/vote',
      { schema: { params: BoardNoteParamsSchema } },
      async (req) => ({
        state: await svc().voteNote(await uid(req), req.params.id, req.params.noteId),
      }),
    );
  };
}
