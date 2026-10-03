import {
  CreateScheduleRequestSchema,
  IdParamsSchema,
  OkResponseSchema,
  PatchScheduleRequestSchema,
  RunFeedRequestSchema,
  SchedulesQuerySchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guards.ts';
import {
  createSchedule,
  deleteSchedule,
  getScheduleDto,
  listSchedules,
  patchSchedule,
  runFeedNow,
} from '../commands/schedules.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

export function scheduleRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/schedules', { schema: { querystring: SchedulesQuerySchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return { schedules: await listSchedules(ctx.pool, s.user.id, req.query.projectId) };
    });

    app.post('/api/schedules', { schema: { body: CreateScheduleRequestSchema } }, async (req, reply) => {
      const s = await requireUser(ctx, req);
      const id = await createSchedule(ctx, s.user, req.body);
      reply.code(201);
      return getScheduleDto(ctx.pool, s.user.id, id);
    });

    app.patch(
      '/api/schedules/:id',
      { schema: { params: IdParamsSchema, body: PatchScheduleRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await patchSchedule(ctx, s.user, req.params.id, req.body);
        return getScheduleDto(ctx.pool, s.user.id, req.params.id);
      },
    );

    app.delete('/api/schedules/:id', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      await deleteSchedule(ctx, s.user, req.params.id);
      return OkResponseSchema.parse({ ok: true });
    });

    app.post('/api/schedules/:id/run', { schema: { params: IdParamsSchema } }, async (req, reply) => {
      const s = await requireUser(ctx, req);
      const r = await runFeedNow(ctx, s.user, { scheduleId: req.params.id });
      reply.code(201);
      return r;
    });

    app.post(
      '/api/projects/:id/feed/run',
      { schema: { params: IdParamsSchema, body: RunFeedRequestSchema.optional() } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        const r = await runFeedNow(ctx, s.user, {
          projectId: req.params.id,
          ...(req.body?.scheduleId ? { scheduleId: req.body.scheduleId } : {}),
        });
        reply.code(201);
        return r;
      },
    );
  };
}
