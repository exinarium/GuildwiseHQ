import {
  ExtendRunRequestSchema,
  IdParamsSchema,
  RunsQuerySchema,
  SetRunSettingsRequestSchema,
  StartRunRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guards.ts';
import {
  extendRun,
  getRun,
  getRunSettings,
  listRuns,
  setRunSettings,
  startRun,
  stopRun,
} from '../commands/runs.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

/** Run a branch (backlog #58): environments, and the Run & test settings of a project. */
export function runRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/runs', { schema: { querystring: RunsQuerySchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      const q = req.query;
      return {
        environments: await listRuns(ctx, s.user.id, {
          ...(q.projectId ? { projectId: q.projectId } : {}),
          ...(q.cardId ? { cardId: q.cardId } : {}),
          ...(q.workstationId ? { workstationId: q.workstationId } : {}),
          live: q.live !== 'false',
        }),
      };
    });

    app.post('/api/runs', { schema: { body: StartRunRequestSchema } }, async (req, reply) => {
      const s = await requireUser(ctx, req);
      const environment = await startRun(ctx, s.user, req.body);
      reply.code(201);
      return { environment };
    });

    app.get('/api/runs/:id', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return { environment: await getRun(ctx, s.user.id, req.params.id) };
    });

    app.post('/api/runs/:id/stop', { schema: { params: IdParamsSchema } }, async (req, reply) => {
      const s = await requireUser(ctx, req);
      const environment = await stopRun(ctx, s.user, req.params.id);
      reply.code(202);
      return { environment };
    });

    app.post(
      '/api/runs/:id/extend',
      { schema: { params: IdParamsSchema, body: ExtendRunRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        return { environment: await extendRun(ctx, s.user, req.params.id, req.body) };
      },
    );

    app.get('/api/projects/:id/run-settings', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return getRunSettings(ctx, s.user, req.params.id);
    });

    app.put(
      '/api/projects/:id/run-settings',
      { schema: { params: IdParamsSchema, body: SetRunSettingsRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await setRunSettings(ctx, s.user, req.params.id, req.body);
        return getRunSettings(ctx, s.user, req.params.id);
      },
    );
  };
}
