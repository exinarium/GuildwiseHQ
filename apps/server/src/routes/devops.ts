import {
  CreateDevOpsRequestSchema,
  DevOpsRequestsQuerySchema,
  IdParamsSchema,
  PatchDevOpsAccessRequestSchema,
  ResolveDevOpsApprovalRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guards.ts';
import { resetAgent } from '../commands/agents.ts';
import {
  createDevOpsRequest,
  getDevOpsRequest,
  listDevOpsRequests,
  patchDevOpsAccess,
  resolveDevOpsApproval,
} from '../commands/devops.ts';
import type { Ctx } from '../context.ts';
import { notFound } from '../errors.ts';
import { listAgents } from '../queries/agents.ts';
import { workstationDtos } from '../queries/misc.ts';
import { typed } from './util.ts';

export function devopsRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/devops/requests', { schema: { querystring: DevOpsRequestsQuerySchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return { requests: await listDevOpsRequests(ctx, s.user.id, req.query) };
    });

    app.post('/api/devops/requests', { schema: { body: CreateDevOpsRequestSchema } }, async (req, reply) => {
      const s = await requireUser(ctx, req);
      const id = await createDevOpsRequest(ctx, s.user, req.body);
      ctx.services.dispatcher.trigger();
      reply.code(201);
      return getDevOpsRequest(ctx, s.user.id, id);
    });

    app.get('/api/devops/requests/:id', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return getDevOpsRequest(ctx, s.user.id, req.params.id);
    });

    /** Answers the approval of a `needs_approval` request (the M2 desk resolve calls the same command). */
    app.post(
      '/api/devops/requests/:id/resolve',
      { schema: { params: IdParamsSchema, body: ResolveDevOpsApprovalRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await resolveDevOpsApproval(ctx, s.user, req.params.id, req.body.resolution, req.body.note);
        return getDevOpsRequest(ctx, s.user.id, req.params.id);
      },
    );

    app.patch(
      '/api/workstations/:id/devops-access',
      { schema: { params: IdParamsSchema, body: PatchDevOpsAccessRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await patchDevOpsAccess(ctx, s.user, req.params.id, req.body);
        const [w] = await workstationDtos(ctx, 'w.id = $1 AND w.user_id = $2', [req.params.id, s.user.id]);
        if (!w) throw notFound('workstation not found');
        return w;
      },
    );

    app.post('/api/agents/:id/reset', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      await resetAgent(ctx, s.user, req.params.id);
      const a = (await listAgents(ctx, s.user.id)).find((x) => x.id === req.params.id);
      if (!a) throw notFound('agent not found');
      return a;
    });
  };
}
