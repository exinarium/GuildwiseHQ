import {
  CardParamsSchema,
  DecisionPolicyRequestSchema,
  IdParamsSchema,
  MemberParamsSchema,
  RehomeAgentRequestSchema,
  ShareProjectRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guards.ts';
import {
  answerShare,
  listProjectInvitations,
  previewRemoval,
  rehomeAgent,
  rehomeCard,
  removeMember,
  setDecisionPolicy,
  shareProject,
} from '../commands/sharing.ts';
import type { Ctx } from '../context.ts';
import { notFound } from '../errors.ts';
import { getAgentDto } from '../queries/agents.ts';
import { getCardDetail } from '../queries/cards.ts';
import { getProjectDetail } from '../queries/misc.ts';
import { typed } from './util.ts';

/** Shared projects, member removal, agent re-homing, decision policy and card re-home (M3). */
export function sharingRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/project-invitations', async (req) => {
      const s = await requireUser(ctx, req);
      return { invitations: await listProjectInvitations(ctx, s.user.id) };
    });

    app.post(
      '/api/projects/:id/members',
      { schema: { params: IdParamsSchema, body: ShareProjectRequestSchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        await shareProject(ctx, s.user, req.params.id, req.body.email);
        reply.code(201);
        return getProjectDetail(ctx, s.user.id, req.params.id);
      },
    );

    app.post('/api/projects/:id/members/accept', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      await answerShare(ctx, s.user, req.params.id, true);
      return getProjectDetail(ctx, s.user.id, req.params.id);
    });

    app.post('/api/projects/:id/members/decline', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      await answerShare(ctx, s.user, req.params.id, false);
      return { ok: true };
    });

    app.get(
      '/api/projects/:id/members/:userId/removal-preview',
      { schema: { params: MemberParamsSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        return previewRemoval(ctx, s.user, req.params.id, req.params.userId);
      },
    );

    app.delete(
      '/api/projects/:id/members/:userId',
      { schema: { params: MemberParamsSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        const r = await removeMember(ctx, s.user, req.params.id, req.params.userId);
        return { project: await getProjectDetail(ctx, s.user.id, req.params.id), ...r };
      },
    );

    app.post(
      '/api/agents/:id/rehome',
      { schema: { params: IdParamsSchema, body: RehomeAgentRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await rehomeAgent(ctx, s.user, req.params.id, req.body);
        const a = await getAgentDto(ctx, s.user.id, req.params.id);
        if (!a) throw notFound('agent not found');
        return a;
      },
    );

    app.post(
      '/api/cards/:id/decision-policy',
      { schema: { params: CardParamsSchema, body: DecisionPolicyRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        const id = await setDecisionPolicy(ctx, s.user, req.params.id, req.body);
        return getCardDetail(ctx, s.user.id, id);
      },
    );

    app.post('/api/cards/:id/rehome', { schema: { params: CardParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      const id = await rehomeCard(ctx, s.user, req.params.id);
      ctx.services.dispatcher.trigger();
      return getCardDetail(ctx, s.user.id, id);
    });
  };
}
