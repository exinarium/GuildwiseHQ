import {
  AddNoteRequestSchema,
  AnswerQuestionRequestSchema,
  CreateDiscoveryRequestSchema,
  DiscoveryNoteParamsSchema,
  DiscoveryParamsSchema,
  DiscoveryProposalParamsSchema,
  DiscoveryQuestionParamsSchema,
  PatchDiscoveryRequestSchema,
  PatchNoteRequestSchema,
  ResolveDiscoveryProposalRequestSchema,
  SayRequestSchema,
  SessionTimeActionSchema,
  SetPhaseRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOrg } from '../auth/guards.ts';
import { whoOf } from '../auth/org-context.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

const DraftRequest = z.object({ kind: z.enum(['brief', 'prd']) });

/**
 * Discovery Studio (docs/ARCHITECTURE.md section 38). A discovery session is a session thread (`/api/sessions`, messages
 * from `GET /api/threads/:id/messages`); these routes are its facilitation: the state the page shows, the owner's answers,
 * the panel, proposals, phases, pause and the PRD hand-off. Every response is the fresh `state`.
 */
export function discoveryRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);
    const svc = () => ctx.services.discovery;

    app.post('/api/discovery', { schema: { body: CreateDiscoveryRequestSchema } }, async (req, reply) => {
      const a = await requireOrg(ctx, req);
      reply.code(201);
      return { state: await svc().create(whoOf(a), req.body) };
    });

    app.get('/api/discovery/:id', { schema: { params: DiscoveryParamsSchema } }, async (req) => {
      const a = await requireOrg(ctx, req);
      return { state: await svc().state(a.session.user.id, req.params.id) };
    });

    app.patch(
      '/api/discovery/:id',
      { schema: { params: DiscoveryParamsSchema, body: PatchDiscoveryRequestSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req);
        return { state: await svc().patch(a.session.user.id, req.params.id, req.body) };
      },
    );

    app.post(
      '/api/discovery/:id/questions/:questionId/answer',
      { schema: { params: DiscoveryQuestionParamsSchema, body: AnswerQuestionRequestSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req);
        return {
          state: await svc().answer(a.session.user.id, req.params.id, req.params.questionId, req.body),
        };
      },
    );

    app.post(
      '/api/discovery/:id/say',
      { schema: { params: DiscoveryParamsSchema, body: SayRequestSchema } },
      async (req, reply) => {
        const a = await requireOrg(ctx, req);
        reply.code(201);
        return await svc().say(a.session.user.id, req.params.id, req.body.body);
      },
    );

    app.post(
      '/api/discovery/:id/notes',
      { schema: { params: DiscoveryParamsSchema, body: AddNoteRequestSchema } },
      async (req, reply) => {
        const a = await requireOrg(ctx, req);
        reply.code(201);
        return {
          state: await svc().addNote(a.session.user.id, req.params.id, req.body.section, req.body.text),
        };
      },
    );

    app.patch(
      '/api/discovery/:id/notes/:noteId',
      { schema: { params: DiscoveryNoteParamsSchema, body: PatchNoteRequestSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req);
        return {
          state: await svc().patchNote(a.session.user.id, req.params.id, req.params.noteId, req.body),
        };
      },
    );

    app.delete(
      '/api/discovery/:id/notes/:noteId',
      { schema: { params: DiscoveryNoteParamsSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req);
        return { state: await svc().removeNote(a.session.user.id, req.params.id, req.params.noteId) };
      },
    );

    app.post(
      '/api/discovery/:id/proposals/:proposalId/resolve',
      { schema: { params: DiscoveryProposalParamsSchema, body: ResolveDiscoveryProposalRequestSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req);
        return {
          state: await svc().resolveProposal(
            a.session.user.id,
            req.params.id,
            req.params.proposalId,
            req.body,
          ),
        };
      },
    );

    app.post(
      '/api/discovery/:id/phase',
      { schema: { params: DiscoveryParamsSchema, body: SetPhaseRequestSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req);
        return { state: await svc().setPhase(a.session.user.id, req.params.id, req.body.phase) };
      },
    );

    app.post('/api/discovery/:id/pause', { schema: { params: DiscoveryParamsSchema } }, async (req) => {
      const a = await requireOrg(ctx, req);
      return { state: await svc().pause(a.session.user.id, req.params.id) };
    });

    app.post('/api/discovery/:id/resume', { schema: { params: DiscoveryParamsSchema } }, async (req) => {
      const a = await requireOrg(ctx, req);
      return { state: await svc().resume(a.session.user.id, req.params.id) };
    });

    app.post('/api/discovery/:id/continue', { schema: { params: DiscoveryParamsSchema } }, async (req) => {
      const a = await requireOrg(ctx, req);
      return { state: await svc().continue(a.session.user.id, req.params.id) };
    });

    app.post(
      '/api/discovery/:id/draft',
      { schema: { params: DiscoveryParamsSchema, body: DraftRequest } },
      async (req, reply) => {
        const a = await requireOrg(ctx, req);
        reply.code(202);
        return { state: await svc().requestDraft(a.session.user.id, req.params.id, req.body.kind) };
      },
    );

    app.post(
      '/api/discovery/:id/validate',
      { schema: { params: DiscoveryParamsSchema } },
      async (req, reply) => {
        const a = await requireOrg(ctx, req);
        reply.code(202);
        return { state: await svc().requestValidation(a.session.user.id, req.params.id) };
      },
    );

    app.post(
      '/api/discovery/:id/time',
      { schema: { params: DiscoveryParamsSchema, body: SessionTimeActionSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req);
        return { state: await svc().timeAction(a.session.user.id, req.params.id, req.body) };
      },
    );

    app.post('/api/discovery/:id/hand-to-ba', { schema: { params: DiscoveryParamsSchema } }, async (req) => {
      const a = await requireOrg(ctx, req);
      return await svc().handToBa(a.session.user.id, req.params.id);
    });
  };
}
