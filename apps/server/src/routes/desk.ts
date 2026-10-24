import {
  AcknowledgeAllCeoDecisionsResponseSchema,
  AnswerDeskItemRequestSchema,
  CorrectCeoDecisionRequestSchema,
  DeskItemParamsSchema,
  DeskQuerySchema,
  DismissDeskItemRequestSchema,
  ResolveDeskItemRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/guards.ts';
import { requestedOrgId, resolveOrgId } from '../auth/org-context.ts';
import { acknowledgeAllCeoDecisions, acknowledgeCeoDecision, correctCeoDecision } from '../ceo/decisions.ts';
import { answerDeskItem, dismissDeskItem, resolveDeskItem } from '../commands/desk.ts';
import type { Ctx } from '../context.ts';
import { notFound } from '../errors.ts';
import { applyDeskAction, previewDeskAction } from '../push/desk-actions.ts';
import { getDeskDto, listDesk } from '../queries/desk.ts';
import { typed } from './util.ts';

export function deskRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    const dto = async (userId: string, id: string) => {
      const item = await getDeskDto(ctx.pool, userId, id);
      if (!item) throw notFound('desk item not found');
      return item;
    };

    app.get('/api/desk', { schema: { querystring: DeskQuerySchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      const orgId = await resolveOrgId(ctx, s, requestedOrgId(req));
      return listDesk(ctx.pool, s.user.id, orgId, req.query);
    });

    // The CEO's own decisions, for the Owner and Admins to acknowledge or correct (informational items).
    app.post(
      '/api/desk/ceo-decisions/acknowledge-all',
      { schema: { response: { 200: AcknowledgeAllCeoDecisionsResponseSchema } } },
      async (req) => {
        const s = await requireUser(ctx, req);
        const orgId = await resolveOrgId(ctx, s, requestedOrgId(req));
        if (!orgId) throw notFound('organization not found');
        return { acknowledged: await acknowledgeAllCeoDecisions(ctx, s.user, orgId) };
      },
    );

    app.post(
      '/api/desk/:id/ceo-decision/acknowledge',
      { schema: { params: DeskItemParamsSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await acknowledgeCeoDecision(ctx, s.user, req.params.id);
        return dto(s.user.id, req.params.id);
      },
    );

    app.post(
      '/api/desk/:id/ceo-decision/correct',
      { schema: { params: DeskItemParamsSchema, body: CorrectCeoDecisionRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        const r = await correctCeoDecision(ctx, s.user, req.params.id, req.body);
        return { item: await dto(s.user.id, req.params.id), applied: r.applied };
      },
    );

    // S-B1: the one-tap link of a notification. GET only shows what it would do (safe to prefetch); POST applies, for the
    // signed-in person the link was made for, once.
    const TokenParams = z.object({ token: z.string().min(20).max(300) });
    app.get('/api/m/desk/:token', { schema: { params: TokenParams } }, async (req, reply) => {
      void reply.header('cache-control', 'no-store');
      const s = await requireUser(ctx, req);
      return previewDeskAction(ctx, s.user, req.params.token);
    });
    app.post('/api/m/desk/:token/apply', { schema: { params: TokenParams } }, async (req, reply) => {
      void reply.header('cache-control', 'no-store');
      const s = await requireUser(ctx, req);
      return applyDeskAction(ctx, s.user, req.params.token);
    });

    app.post(
      '/api/desk/:id/answer',
      { schema: { params: DeskItemParamsSchema, body: AnswerDeskItemRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        const r = await answerDeskItem(ctx, s.user, req.params.id, req.body);
        return { item: await dto(s.user.id, req.params.id), ...r };
      },
    );

    app.post(
      '/api/desk/:id/resolve',
      { schema: { params: DeskItemParamsSchema, body: ResolveDeskItemRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await resolveDeskItem(ctx, s.user, req.params.id, req.body);
        return dto(s.user.id, req.params.id);
      },
    );

    app.post(
      '/api/desk/:id/dismiss',
      { schema: { params: DeskItemParamsSchema, body: DismissDeskItemRequestSchema.optional() } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await dismissDeskItem(ctx, s.user, req.params.id, req.body?.note);
        return dto(s.user.id, req.params.id);
      },
    );
  };
}
