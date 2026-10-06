import {
  AdoptableSchedulesResponseSchema,
  AdoptRequestSchema,
  AdoptResponseSchema,
  CreateInterestRequestSchema,
  CreateInterestResponseSchema,
  DeleteInterestQuerySchema,
  IdParamsSchema,
  InterestDetailResponseSchema,
  InterestsQuerySchema,
  InterestsResponseSchema,
  InterestTasteRequestSchema,
  OkResponseSchema,
  PatchInterestRequestSchema,
  RunInterestResponseSchema,
  TasteSeedRequestSchema,
  TasteSeedResponseSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireOrg, requireUserWithFeature } from '../auth/guards.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import {
  adoptSchedules,
  assertCanEditInterest,
  createInterest,
  deleteInterest,
  resyncTasteSeed,
  setInterestTaste,
  setTasteSeed,
  updateInterest,
} from '../commands/interests.ts';
import { runFeedNow } from '../commands/schedules.ts';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import { conflict, forbidden, notFound } from '../errors.ts';
import {
  adoptableSchedules,
  getInterestDto,
  interestDetail,
  listInterests,
  projectHasVault,
  tasteProjects,
} from '../queries/interests.ts';
import { typed } from './util.ts';

export function interestRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/interests', { schema: { querystring: InterestsQuerySchema } }, async (req) => {
      const s = await requireUserWithFeature(ctx, req, 'interests');
      return InterestsResponseSchema.parse({
        interests: await listInterests(ctx.pool, s.user.id, ctx.clock.now(), req.query),
        tasteProjects: await tasteProjects(ctx.pool, s.user.id),
        adoptableCount: (await adoptableSchedules(ctx.pool, s.user.id)).length,
      });
    });

    app.get('/api/interests/adoptable', async (req) => {
      const s = await requireUserWithFeature(ctx, req, 'interests');
      return AdoptableSchedulesResponseSchema.parse({
        schedules: await adoptableSchedules(ctx.pool, s.user.id),
      });
    });

    app.post('/api/interests/adopt', { schema: { body: AdoptRequestSchema } }, async (req) => {
      const s = await requireUserWithFeature(ctx, req, 'interests');
      return AdoptResponseSchema.parse({ results: await adoptSchedules(ctx, s.user, req.body.scheduleIds) });
    });

    app.get('/api/interests/:id', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUserWithFeature(ctx, req, 'interests');
      const d = await interestDetail(ctx.pool, s.user.id, req.params.id, ctx.clock.now());
      if (!d) throw notFound('interest not found');
      return InterestDetailResponseSchema.parse(d);
    });

    app.post('/api/interests', { schema: { body: CreateInterestRequestSchema } }, async (req, reply) => {
      const a = await requireOrg(ctx, req, { feature: 'interests' });
      const id = await createInterest(ctx, a.session.user, { id: a.orgId, role: a.role }, req.body);
      reply.code(201);
      return CreateInterestResponseSchema.parse({ id });
    });

    app.patch(
      '/api/interests/:id',
      { schema: { params: IdParamsSchema, body: PatchInterestRequestSchema } },
      async (req) => {
        const s = await requireUserWithFeature(ctx, req, 'interests');
        await updateInterest(ctx, s.user, req.params.id, req.body);
        return getInterestDto(ctx.pool, s.user.id, req.params.id, ctx.clock.now());
      },
    );

    app.delete(
      '/api/interests/:id',
      { schema: { params: IdParamsSchema, querystring: DeleteInterestQuerySchema } },
      async (req) => {
        const s = await requireUserWithFeature(ctx, req, 'interests');
        await deleteInterest(ctx, s.user, req.params.id, { keepSchedule: req.query.keepSchedule });
        return OkResponseSchema.parse({ ok: true });
      },
    );

    app.post('/api/interests/:id/run', { schema: { params: IdParamsSchema } }, async (req, reply) => {
      const s = await requireUserWithFeature(ctx, req, 'interests');
      const i = await getInterestDto(ctx.pool, s.user.id, req.params.id, ctx.clock.now());
      if (!i) throw notFound('interest not found');
      if (!i.scheduleId) throw conflict('no_feed_project', 'this interest has no feed project to run');
      if (!i.canRun) throw forbidden('you are not a member of the feed project');
      // "Run now" follows the interest's edit rule (its creator, or a higher role in the organization).
      const row = await one(ctx.pool, 'SELECT * FROM interests WHERE id=$1', [req.params.id]);
      if (row) await assertCanEditInterest(ctx.pool, s.user.id, row);
      const r = await runFeedNow(ctx, s.user, { scheduleId: i.scheduleId });
      reply.code(201);
      return RunInterestResponseSchema.parse(r);
    });

    app.put(
      '/api/interests/:id/taste',
      { schema: { params: IdParamsSchema, body: InterestTasteRequestSchema } },
      async (req) => {
        const s = await requireUserWithFeature(ctx, req, 'interests');
        await setInterestTaste(ctx, s.user, req.params.id, req.body.rules);
        return OkResponseSchema.parse({ ok: true });
      },
    );

    const seedOf = async (userId: string, projectId: string) => {
      const p = await loadVisibleProject(ctx.pool, userId, projectId);
      const r = await one(ctx.pool, 'SELECT version, rules FROM taste_seeds WHERE project_id=$1', [p.id]);
      return TasteSeedResponseSchema.parse({
        projectId: p.id,
        version: r?.version ?? 0,
        rules: r?.rules ?? [],
        hasVault: await projectHasVault(ctx.pool, p.id),
      });
    };

    app.get('/api/projects/:id/taste-seed', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUserWithFeature(ctx, req, 'interests');
      return seedOf(s.user.id, req.params.id);
    });

    app.put(
      '/api/projects/:id/taste-seed',
      { schema: { params: IdParamsSchema, body: TasteSeedRequestSchema } },
      async (req) => {
        const s = await requireUserWithFeature(ctx, req, 'interests');
        await setTasteSeed(ctx, s.user, req.params.id, req.body.rules);
        return seedOf(s.user.id, req.params.id);
      },
    );

    app.post('/api/projects/:id/taste-seed/resync', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUserWithFeature(ctx, req, 'interests');
      await resyncTasteSeed(ctx, s.user, req.params.id);
      return seedOf(s.user.id, req.params.id);
    });
  };
}
