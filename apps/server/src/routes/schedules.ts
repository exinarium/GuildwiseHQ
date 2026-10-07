import {
  CreateScheduleRequestSchema,
  IdParamsSchema,
  OkResponseSchema,
  PatchScheduleRequestSchema,
  RunFeedRequestSchema,
  SchedulesQuerySchema,
} from '@aom/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireUser } from '../auth/guards.ts';
import { orgRoleOf, requestedOrgId, resolveOrgId } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import {
  createSchedule,
  deleteSchedule,
  getScheduleDto,
  listRuns,
  listSchedules,
  listSystemSchedules,
  type OrgCtx,
  patchSchedule,
  rotateWebhookSecret,
  runFeedNow,
  runScheduleNow,
  testSchedule,
} from '../commands/schedules.ts';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import { typed } from './util.ts';

export function scheduleRoutes(ctx: Ctx) {
  /**
   * The tab's organization for organization-level schedules. A guest, or a request for another organization, has none:
   * a schedule tied to a project needs no organization (its project decides).
   */
  const orgOf = async (req: FastifyRequest, s: AuthSession): Promise<OrgCtx | null> => {
    try {
      const orgId = await resolveOrgId(ctx, s, requestedOrgId(req));
      if (!orgId) return null;
      const role = await orgRoleOf(ctx.pool, s.user.id, orgId);
      return role ? { orgId, role } : null;
    } catch {
      return null;
    }
  };

  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/schedules', { schema: { querystring: SchedulesQuerySchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return {
        schedules: await listSchedules(ctx.pool, s.user.id, req.query.projectId),
        system: req.query.projectId ? [] : await listSystemSchedules(ctx, s.user.id),
      };
    });

    app.post('/api/schedules', { schema: { body: CreateScheduleRequestSchema } }, async (req, reply) => {
      const s = await requireUser(ctx, req);
      const r = await createSchedule(ctx, s.user, await orgOf(req, s), req.body);
      reply.code(201);
      return {
        ...(await getScheduleDto(ctx.pool, s.user.id, r.id)),
        ...(r.webhookSecret ? { webhookSecret: r.webhookSecret } : {}),
      };
    });

    app.patch(
      '/api/schedules/:id',
      { schema: { params: IdParamsSchema, body: PatchScheduleRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await patchSchedule(ctx, s.user, await orgOf(req, s), req.params.id, req.body);
        return getScheduleDto(ctx.pool, s.user.id, req.params.id);
      },
    );

    app.delete('/api/schedules/:id', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      await deleteSchedule(ctx, s.user, await orgOf(req, s), req.params.id);
      return OkResponseSchema.parse({ ok: true });
    });

    app.post('/api/schedules/:id/run', { schema: { params: IdParamsSchema } }, async (req, reply) => {
      const s = await requireUser(ctx, req);
      await getScheduleDto(ctx.pool, s.user.id, req.params.id);
      const row = await one(ctx.pool, 'SELECT kind FROM schedules WHERE id=$1', [req.params.id]);
      reply.code(201);
      // A feed schedule keeps its own path until feeds move to interests.
      if (row?.kind === 'feed') return runFeedNow(ctx, s.user, { scheduleId: req.params.id });
      return runScheduleNow(ctx, s.user, await orgOf(req, s), req.params.id);
    });

    app.get('/api/schedules/:id/runs', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return { runs: await listRuns(ctx, s.user.id, req.params.id) };
    });

    app.post('/api/schedules/:id/test', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return testSchedule(ctx, s.user, await orgOf(req, s), req.params.id);
    });

    app.post('/api/schedules/:id/rotate-secret', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return { webhookSecret: await rotateWebhookSecret(ctx, s.user, await orgOf(req, s), req.params.id) };
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
