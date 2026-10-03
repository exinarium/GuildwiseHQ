import { CreateIntakeRequestSchema, IntakeParamsSchema } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guards.ts';
import { getIntake, listIntakes, startIntake } from '../commands/intake.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

/** BA intake (M7): `POST /api/intakes` opens the chat with the BA; the conversation itself runs over the chat socket. */
export function intakeRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/intakes', async (req) => {
      const s = await requireUser(ctx, req);
      return { intakes: await listIntakes(ctx, s.user.id) };
    });

    app.post('/api/intakes', { schema: { body: CreateIntakeRequestSchema } }, async (req, reply) => {
      const s = await requireUser(ctx, req);
      const intake = await startIntake(ctx, s.user, req.body);
      reply.code(201);
      return { intake };
    });

    app.get('/api/intakes/:id', { schema: { params: IntakeParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return { intake: await getIntake(ctx, s.user.id, req.params.id) };
    });
  };
}
