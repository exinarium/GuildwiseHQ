import {
  ConfirmSuiteRequestSchema,
  ExtendRunRequestSchema,
  IdParamsSchema,
  RestartRunRequestSchema,
  RunsQuerySchema,
  SetIntegrationTestsRequestSchema,
  SetRunSettingsRequestSchema,
  SetTargetSecretRequestSchema,
  StartRunRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/guards.ts';
import { confirmSuite, getIntegrationTests, setIntegrationTests } from '../commands/integration-tests.ts';
import {
  dismissRun,
  extendRun,
  getRun,
  getRunSettings,
  listRuns,
  restartRun,
  retryRun,
  setRunSettings,
  startRun,
  stopRun,
} from '../commands/runs.ts';
import { setTargetSecret, targetSecretStatuses } from '../commands/target-secrets.ts';
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

    app.post(
      '/api/runs/:id/restart',
      { schema: { params: IdParamsSchema, body: RestartRunRequestSchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        const environment = await restartRun(ctx, s.user, req.params.id, req.body);
        reply.code(202);
        return { environment };
      },
    );

    app.post('/api/runs/:id/dismiss', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return { environment: await dismissRun(ctx, s.user, req.params.id) };
    });

    app.post('/api/runs/:id/retry', { schema: { params: IdParamsSchema } }, async (req, reply) => {
      const s = await requireUser(ctx, req);
      const environment = await retryRun(ctx, s.user, req.params.id);
      reply.code(201);
      return { environment };
    });

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

    // Integration tests of the tester (backlog #59): the project's mode and suites.
    app.get('/api/projects/:id/integration-tests', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return getIntegrationTests(ctx, s.user, req.params.id);
    });

    app.put(
      '/api/projects/:id/integration-tests',
      { schema: { params: IdParamsSchema, body: SetIntegrationTestsRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await setIntegrationTests(ctx, s.user, req.params.id, req.body);
        return getIntegrationTests(ctx, s.user, req.params.id);
      },
    );

    // Test accounts of a deploy target: the browser's sealed value for one name on one of the viewer's workstations.
    app.put(
      '/api/workstations/:id/target-secrets',
      { schema: { params: IdParamsSchema, body: SetTargetSecretRequestSchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        await setTargetSecret(ctx, s.user, req.params.id, req.body);
        reply.code(202);
        return { queued: true };
      },
    );

    app.get('/api/projects/:id/target-secrets', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return targetSecretStatuses(ctx, s.user, req.params.id);
    });

    app.post(
      '/api/projects/:id/integration-tests/suites/:name/confirm',
      {
        schema: {
          params: z.object({ id: z.uuid(), name: z.string().min(1).max(60) }),
          body: ConfirmSuiteRequestSchema,
        },
      },
      async (req) => {
        const s = await requireUser(ctx, req);
        await confirmSuite(ctx, s.user, req.params.id, req.params.name, req.body.confirmed);
        return getIntegrationTests(ctx, s.user, req.params.id);
      },
    );
  };
}
