import {
  AnswerProposalRequestSchema,
  ConfirmSuiteRequestSchema,
  ExtendRunRequestSchema,
  IdParamsSchema,
  PlanConsentRequestSchema,
  ProposalsQuerySchema,
  ResolveProposalRequestSchema,
  RestartRunRequestSchema,
  RunsQuerySchema,
  SaveRunPlanRequestSchema,
  SetIntegrationTestsRequestSchema,
  SetRunSettingsRequestSchema,
  SetTargetSecretRequestSchema,
  SetupScanRequestSchema,
  StartRunRequestSchema,
  TestRunPlanRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/guards.ts';
import { confirmSuite, getIntegrationTests, setIntegrationTests } from '../commands/integration-tests.ts';
import {
  allowPlanOnWorkstation,
  discardWorkstationPlan,
  getRunPlanOverview,
  saveRunPlan,
  testRunPlan,
} from '../commands/run-plans.ts';
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
import { answerProposal, listProposals, resolveProposal, startScan } from '../commands/setup-proposals.ts';
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

    // Guided run steps (docs/design/deploy-run-ux-design.md): the project-wide plan, the scan and its proposals.
    app.get('/api/projects/:id/run-plan', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return getRunPlanOverview(ctx, s.user, req.params.id);
    });

    app.put(
      '/api/projects/:id/run-plan',
      { schema: { params: IdParamsSchema, body: SaveRunPlanRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        const saved = await saveRunPlan(ctx, s.user, req.params.id, req.body);
        const overview = await getRunPlanOverview(ctx, s.user, req.params.id);
        return {
          ...overview,
          saved: {
            version: saved.version,
            scope: saved.workstationId ? ('workstation' as const) : ('project' as const),
            // computers whose own steps still win over the project's
            computersWithOwnSteps: saved.workstationId
              ? []
              : overview.workstationPlans.map((w) => w.workstationName ?? 'a computer'),
          },
        };
      },
    );

    app.delete(
      '/api/projects/:id/run-plan/:planId',
      { schema: { params: z.object({ id: z.uuid(), planId: z.uuid() }) } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await discardWorkstationPlan(ctx, s.user, req.params.id, req.params.planId);
        return getRunPlanOverview(ctx, s.user, req.params.id);
      },
    );

    app.post(
      '/api/projects/:id/run-plan/test',
      { schema: { params: IdParamsSchema, body: TestRunPlanRequestSchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        const { environment, ran } = await testRunPlan(ctx, s.user, req.params.id, req.body);
        reply.code(201);
        return { environment, ran };
      },
    );

    app.post(
      '/api/projects/:id/run-plan/:planId/consent',
      {
        schema: {
          params: z.object({ id: z.uuid(), planId: z.uuid() }),
          body: PlanConsentRequestSchema,
        },
      },
      async (req) => {
        const s = await requireUser(ctx, req);
        await allowPlanOnWorkstation(ctx, s.user, req.params.id, req.params.planId, req.body.workstationId);
        return getRunPlanOverview(ctx, s.user, req.params.id);
      },
    );

    app.post(
      '/api/projects/:id/scan',
      { schema: { params: IdParamsSchema, body: SetupScanRequestSchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        const r = await startScan(ctx, s.user, req.params.id, req.body);
        reply.code(202);
        return r;
      },
    );

    app.get(
      '/api/projects/:id/proposals',
      { schema: { params: IdParamsSchema, querystring: ProposalsQuerySchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        return { proposals: await listProposals(ctx, s.user, req.params.id, req.query.area) };
      },
    );

    app.post(
      '/api/setup-proposals/:id/resolve',
      { schema: { params: IdParamsSchema, body: ResolveProposalRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await resolveProposal(ctx, s.user, req.params.id, req.body.outcome);
        return { ok: true };
      },
    );

    app.post(
      '/api/setup-proposals/:id/answers',
      { schema: { params: IdParamsSchema, body: AnswerProposalRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        return answerProposal(ctx, s.user, req.params.id, req.body.answers, req.body.confirmed);
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
