import {
  PlaybookGrantsDtoSchema,
  PlaybookRunRequestSchema,
  PlaybookRunResponseSchema,
  SetPlaybookGrantRequestSchema,
  SlashCommandsQuerySchema,
  SlashCommandsResponseSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOrg } from '../auth/guards.ts';
import { whoOf } from '../auth/org-context.ts';
import type { Ctx } from '../context.ts';
import {
  getPlaybookGrants,
  runPlaybookSession,
  setPlaybookGrant,
  slashCommands,
} from '../sessions/playbooks.ts';
import { typed } from './util.ts';

/** Playbooks as `/` commands (docs/ARCHITECTURE.md section 38.10): the menu, starting a guided session, and agent grants. */
export function playbookRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get(
      '/api/slash-commands',
      { schema: { querystring: SlashCommandsQuerySchema, response: { 200: SlashCommandsResponseSchema } } },
      async (req) => {
        const a = await requireOrg(ctx, req, { min: 'member' });
        return {
          items: await slashCommands(ctx, whoOf(a), {
            context: req.query.context,
            projectId: req.query.projectId,
          }),
        };
      },
    );

    app.post(
      '/api/playbooks/run',
      { schema: { body: PlaybookRunRequestSchema, response: { 201: PlaybookRunResponseSchema } } },
      async (req, reply) => {
        const a = await requireOrg(ctx, req, { min: 'member' });
        reply.code(201);
        return runPlaybookSession(ctx, whoOf(a), req.body);
      },
    );

    const AgentParams = z.object({ id: z.uuid() });
    app.get(
      '/api/agents/:id/playbook-grants',
      { schema: { params: AgentParams, response: { 200: PlaybookGrantsDtoSchema } } },
      async (req) => {
        const a = await requireOrg(ctx, req, { min: 'member' });
        return getPlaybookGrants(ctx, a.session.user, req.params.id);
      },
    );
    app.put(
      '/api/agents/:id/playbook-grants',
      {
        schema: {
          params: AgentParams,
          body: SetPlaybookGrantRequestSchema,
          response: { 200: PlaybookGrantsDtoSchema },
        },
      },
      async (req) => {
        const a = await requireOrg(ctx, req, { min: 'member' });
        return setPlaybookGrant(ctx, a.session.user, req.params.id, req.body);
      },
    );
  };
}
