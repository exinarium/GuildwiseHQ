import {
  AddReferenceBodySchema,
  ContinueBodySchema,
  CreateJourneyBodySchema,
  InstanceFiltersSchema,
  JOURNEY_TEMPLATES,
  PlaybookBodySchema,
  SaveJourneyBodySchema,
  StartInstanceBodySchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOrg } from '../auth/guards.ts';
import { whoOf } from '../auth/org-context.ts';
import {
  addReference,
  archiveJourney,
  cancelInstance,
  continueStep,
  createJourney,
  getInstance,
  getJourney,
  getRecord,
  listInstances,
  listJourneys,
  runStepPlaybook,
  saveJourney,
  startInstance,
} from '../commands/journeys.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

/** Journeys (docs/investigations/GWP-66): definitions, the shared record, instances. Bodies are strict zod schemas. */
export function journeyRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);
    const Id = z.object({ id: z.uuid() });
    const member = async (req: Parameters<typeof requireOrg>[1]) =>
      whoOf(await requireOrg(ctx, req, { min: 'member' }));

    app.get('/api/journey-templates', async (req) => {
      await member(req);
      return { items: JOURNEY_TEMPLATES };
    });
    app.get(
      '/api/journeys',
      { schema: { querystring: z.object({ projectId: z.uuid().optional() }) } },
      async (req) => listJourneys(ctx, await member(req), req.query.projectId),
    );
    app.post('/api/journeys', { schema: { body: CreateJourneyBodySchema } }, async (req, reply) => {
      const out = await createJourney(ctx, await member(req), req.body);
      reply.code(201);
      return out;
    });
    app.get(
      '/api/journeys/:id',
      {
        schema: { params: Id, querystring: z.object({ version: z.coerce.number().int().min(1).optional() }) },
      },
      async (req) => getJourney(ctx, await member(req), req.params.id, req.query.version),
    );
    app.put('/api/journeys/:id', { schema: { params: Id, body: SaveJourneyBodySchema } }, async (req) =>
      saveJourney(ctx, await member(req), req.params.id, req.body.definition, req.body.baseVersion),
    );
    app.post('/api/journeys/:id/archive', { schema: { params: Id } }, async (req) =>
      archiveJourney(ctx, await member(req), req.params.id),
    );

    app.get('/api/journey-instances', { schema: { querystring: InstanceFiltersSchema } }, async (req) =>
      listInstances(ctx, await member(req), req.query),
    );
    app.post('/api/journey-instances', { schema: { body: StartInstanceBodySchema } }, async (req, reply) => {
      const out = await startInstance(ctx, await member(req), req.body);
      reply.code(201);
      return out;
    });
    app.get('/api/journey-instances/:id', { schema: { params: Id } }, async (req) =>
      getInstance(ctx, await member(req), req.params.id),
    );
    app.post(
      '/api/journey-instances/:id/continue',
      { schema: { params: Id, body: ContinueBodySchema } },
      async (req) => continueStep(ctx, await member(req), req.params.id, req.body.visit),
    );
    app.post('/api/journey-instances/:id/cancel', { schema: { params: Id } }, async (req) =>
      cancelInstance(ctx, await member(req), req.params.id),
    );
    app.post(
      '/api/journey-instances/:id/playbook',
      { schema: { params: Id, body: PlaybookBodySchema } },
      async (req, reply) => {
        const out = await runStepPlaybook(
          ctx,
          await member(req),
          req.params.id,
          req.body.visit,
          req.body.workstationId,
        );
        reply.code(201);
        return out;
      },
    );

    app.get('/api/journey-records/:id', { schema: { params: Id } }, async (req) =>
      getRecord(ctx, await member(req), req.params.id),
    );
    app.post(
      '/api/journey-records/:id/references',
      { schema: { params: Id, body: AddReferenceBodySchema } },
      async (req) => addReference(ctx, await member(req), req.params.id, req.body),
    );
  };
}
