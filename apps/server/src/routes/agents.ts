import {
  AgentsQuerySchema,
  HireAgentRequestSchema,
  IdParamsSchema,
  NameSuggestionsQuerySchema,
  PatchAgentRequestSchema,
  RerollAgentAvatarRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireOrg, requireUser } from '../auth/guards.ts';
import { fireAgent, hireAgent, patchAgent, suggestNames } from '../commands/agents.ts';
import { rerollAgentAvatar } from '../commands/avatar.ts';
import type { Ctx } from '../context.ts';
import { notFound } from '../errors.ts';
import { getAgentDto, listAgents } from '../queries/agents.ts';
import { typed } from './util.ts';

export function agentRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    const one = async (userId: string, id: string) => {
      const a = await getAgentDto(ctx, userId, id);
      if (!a) throw notFound('agent not found');
      return a;
    };

    app.get('/api/agents', { schema: { querystring: AgentsQuerySchema } }, async (req) => {
      const a = await requireOrg(ctx, req);
      return {
        agents: await listAgents(ctx, a.session.user.id, a.orgId, req.query.projectId, req.query.department),
      };
    });

    app.get(
      '/api/agents/name-suggestions',
      { schema: { querystring: NameSuggestionsQuerySchema } },
      async (req) => {
        const a = await requireOrg(ctx, req);
        return { names: await suggestNames(ctx, a.orgId, req.query.theme, req.query.count) };
      },
    );

    app.post('/api/agents', { schema: { body: HireAgentRequestSchema } }, async (req, reply) => {
      const a = await requireOrg(ctx, req);
      const id = await hireAgent(ctx, a.session.user, { id: a.orgId }, req.body);
      reply.code(201);
      return one(a.session.user.id, id);
    });

    app.patch(
      '/api/agents/:id',
      { schema: { params: IdParamsSchema, body: PatchAgentRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        const { acknowledgeUnsandboxed, ...changes } = req.body;
        await patchAgent(ctx, s.user, req.params.id, changes, acknowledgeUnsandboxed);
        return one(s.user.id, req.params.id);
      },
    );

    // "Re-roll face": a new generated face for the agent (the org owner, or the manager who hired it).
    app.post(
      '/api/agents/:id/avatar/reroll',
      { schema: { params: IdParamsSchema, body: RerollAgentAvatarRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await rerollAgentAvatar(ctx, s.user, req.params.id, req.body);
        return { agent: await one(s.user.id, req.params.id) };
      },
    );

    app.post('/api/agents/:id/fire', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      const { releasedCardIds } = await fireAgent(ctx, s.user, req.params.id);
      return { agent: await one(s.user.id, req.params.id), releasedCardIds };
    });
  };
}
