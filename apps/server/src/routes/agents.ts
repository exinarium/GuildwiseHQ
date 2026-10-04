import {
  AgentsQuerySchema,
  HireAgentRequestSchema,
  IdParamsSchema,
  NameSuggestionsQuerySchema,
  PatchAgentRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guards.ts';
import { fireAgent, hireAgent, patchAgent, suggestNames } from '../commands/agents.ts';
import type { Ctx } from '../context.ts';
import { notFound } from '../errors.ts';
import { listAgents } from '../queries/agents.ts';
import { typed } from './util.ts';

export function agentRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    const one = async (userId: string, id: string) => {
      const a = (await listAgents(ctx, userId)).find((x) => x.id === id);
      if (!a) throw notFound('agent not found');
      return a;
    };

    app.get('/api/agents', { schema: { querystring: AgentsQuerySchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return { agents: await listAgents(ctx, s.user.id, req.query.projectId, req.query.department) };
    });

    app.get(
      '/api/agents/name-suggestions',
      { schema: { querystring: NameSuggestionsQuerySchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        return { names: await suggestNames(ctx, s.user.id, req.query.theme, req.query.count) };
      },
    );

    app.post('/api/agents', { schema: { body: HireAgentRequestSchema } }, async (req, reply) => {
      const s = await requireUser(ctx, req);
      const id = await hireAgent(ctx, s.user, req.body);
      reply.code(201);
      return one(s.user.id, id);
    });

    app.patch(
      '/api/agents/:id',
      { schema: { params: IdParamsSchema, body: PatchAgentRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await patchAgent(ctx, s.user, req.params.id, req.body);
        return one(s.user.id, req.params.id);
      },
    );

    app.post('/api/agents/:id/fire', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      const { releasedCardIds } = await fireAgent(ctx, s.user, req.params.id);
      return { agent: await one(s.user.id, req.params.id), releasedCardIds };
    });
  };
}
