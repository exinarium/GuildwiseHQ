import { CreateIntakeRequestSchema, IntakeParamsSchema } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireOrg } from '../auth/guards.ts';
import { getIntake, listIntakes, startIntake } from '../commands/intake.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

/** BA intake (M7): `POST /api/intakes` opens the chat with the BA; the conversation itself runs over the chat socket. */
export function intakeRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/intakes', async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin', feature: 'integrations' });
      return { intakes: await listIntakes(ctx, a.orgId) };
    });

    app.post('/api/intakes', { schema: { body: CreateIntakeRequestSchema } }, async (req, reply) => {
      const a = await requireOrg(ctx, req, { min: 'admin', feature: 'integrations' });
      const intake = await startIntake(ctx, a.session.user, { id: a.orgId, role: a.role }, req.body);
      reply.code(201);
      return { intake };
    });

    app.get('/api/intakes/:id', { schema: { params: IntakeParamsSchema } }, async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin', feature: 'integrations' });
      return { intake: await getIntake(ctx, a.orgId, req.params.id) };
    });
  };
}
