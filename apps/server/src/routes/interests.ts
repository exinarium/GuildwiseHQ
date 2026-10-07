import {
  CreateInterestRequestSchema,
  CreateInterestResponseSchema,
  DeleteInterestRequestSchema,
  DeliverInterestResponseSchema,
  DigestItemsResponseSchema,
  EligibleAgentsResponseSchema,
  IdParamsSchema,
  InterestDeliveriesResponseSchema,
  InterestDetailResponseSchema,
  InterestMemberRequestSchema,
  InterestRunDetailResponseSchema,
  InterestRunsQuerySchema,
  InterestRunsResponseSchema,
  InterestsQuerySchema,
  InterestsResponseSchema,
  InterestTasteRequestSchema,
  isOrgManager,
  OkResponseSchema,
  PatchInterestRequestSchema,
  RunInterestRequestSchema,
  RunInterestResponseSchema,
} from '@aom/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireUser, requireUserWithFeature } from '../auth/guards.ts';
import {
  loadOrg,
  orgRoleOf,
  rankInOrg,
  requestedOrgId,
  requireFeature,
  resolveOrgId,
} from '../auth/org-context.ts';
import { deliveredInLastDay, deliverInterestNow, runInterest } from '../commands/interest-runs.ts';
import {
  archiveInterest,
  createInterest,
  deleteInterest,
  restoreInterest,
  resyncInterestTaste,
  setInterestTaste,
  shareInterest,
  unshareInterest,
  updateInterest,
} from '../commands/interests.ts';
import type { Ctx } from '../context.ts';
import { forbidden, notFound } from '../errors.ts';
import { toDigestDto } from '../queries/digests.ts';
import {
  eligibleAgents,
  getInterestDto,
  interestDeliveries,
  interestDetail,
  interestItems,
  interestRunDetail,
  interestRuns,
  listInterests,
} from '../queries/interests.ts';
import { reportingOf } from '../reporter/settings.ts';
import { typed } from './util.ts';

const RunParamsSchema = z.object({ id: z.uuid(), runId: z.uuid() });
const MemberParamsSchema = z.object({ id: z.uuid(), userId: z.uuid() });
const DigestQuerySchema = z.object({ status: z.enum(['unrated', 'all']).default('all') });

export function interestRoutes(ctx: Ctx) {
  /**
   * The organization a new interest goes to: the tab's. A guest (no membership, access to a shared project of it) may
   * create any interest there, private to them unless shared (owner decision).
   */
  async function creationOrg(req: FastifyRequest) {
    const s = await requireUser(ctx, req);
    const requested = requestedOrgId(req);
    const orgId = requested ?? (await resolveOrgId(ctx, s, null));
    if (!orgId) throw forbidden('you do not belong to an organization');
    const org = await loadOrg(ctx.pool, orgId);
    if (!org) throw notFound('organization not found');
    if ((await rankInOrg(ctx.pool, s.user.id, orgId)) < 1)
      throw forbidden('you have no access to this organization');
    requireFeature(org, 'interests');
    return { session: s, orgId, role: await orgRoleOf(ctx.pool, s.user.id, orgId) };
  }

  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/interests', { schema: { querystring: InterestsQuerySchema } }, async (req) => {
      const s = await requireUserWithFeature(ctx, req, 'interests');
      const orgId = await resolveOrgId(ctx, s, requestedOrgId(req)).catch(() => null);
      const reporting = orgId ? await reportingOf(ctx.pool, orgId) : null;
      const role = orgId ? await orgRoleOf(ctx.pool, s.user.id, orgId) : null;
      return InterestsResponseSchema.parse({
        interests: await listInterests(ctx.pool, s.user.id, ctx.clock.now(), req.query),
        quietCap: reporting?.interestDigestCap ?? null,
        deliveredToday: orgId ? await deliveredInLastDay(ctx.pool, orgId, ctx.clock.now()) : 0,
        canSetCap: isOrgManager({ orgRole: role }),
      });
    });

    app.get('/api/interests/:id', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUserWithFeature(ctx, req, 'interests');
      const d = await interestDetail(ctx.pool, s.user.id, req.params.id, ctx.clock.now());
      if (!d) throw notFound('interest not found');
      return InterestDetailResponseSchema.parse(d);
    });

    app.post('/api/interests', { schema: { body: CreateInterestRequestSchema } }, async (req, reply) => {
      const a = await creationOrg(req);
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

    app.post('/api/interests/:id/archive', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUserWithFeature(ctx, req, 'interests');
      await archiveInterest(ctx, s.user, req.params.id);
      return OkResponseSchema.parse({ ok: true });
    });

    app.post('/api/interests/:id/restore', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUserWithFeature(ctx, req, 'interests');
      await restoreInterest(ctx, s.user, req.params.id);
      return OkResponseSchema.parse({ ok: true });
    });

    app.delete(
      '/api/interests/:id',
      { schema: { params: IdParamsSchema, querystring: DeleteInterestRequestSchema } },
      async (req) => {
        const s = await requireUserWithFeature(ctx, req, 'interests');
        await deleteInterest(ctx, s.user, req.params.id, req.query.confirmSlug);
        return OkResponseSchema.parse({ ok: true });
      },
    );

    app.post(
      '/api/interests/:id/run',
      { schema: { params: IdParamsSchema, body: RunInterestRequestSchema.optional() } },
      async (req, reply) => {
        const s = await requireUserWithFeature(ctx, req, 'interests');
        const r = await runInterest(
          ctx,
          s.user,
          req.params.id,
          RunInterestRequestSchema.parse(req.body ?? {}),
        );
        reply.code(201);
        return RunInterestResponseSchema.parse(r);
      },
    );

    app.post('/api/interests/:id/deliver', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUserWithFeature(ctx, req, 'interests');
      return DeliverInterestResponseSchema.parse(await deliverInterestNow(ctx, s.user, req.params.id));
    });

    app.get(
      '/api/interests/:id/runs',
      { schema: { params: IdParamsSchema, querystring: InterestRunsQuerySchema } },
      async (req) => {
        const s = await requireUserWithFeature(ctx, req, 'interests');
        const r = await interestRuns(ctx.pool, s.user.id, req.params.id, req.query);
        if (!r) throw notFound('interest not found');
        return InterestRunsResponseSchema.parse(r);
      },
    );

    app.get('/api/interests/:id/runs/:runId', { schema: { params: RunParamsSchema } }, async (req) => {
      const s = await requireUserWithFeature(ctx, req, 'interests');
      const r = await interestRunDetail(ctx.pool, s.user.id, req.params.id, req.params.runId);
      if (!r) throw notFound('run not found');
      return InterestRunDetailResponseSchema.parse(r);
    });

    app.get('/api/interests/:id/deliveries', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUserWithFeature(ctx, req, 'interests');
      const r = await interestDeliveries(ctx.pool, s.user.id, req.params.id);
      if (!r) throw notFound('interest not found');
      return InterestDeliveriesResponseSchema.parse(r);
    });

    app.get(
      '/api/interests/:id/digest',
      { schema: { params: IdParamsSchema, querystring: DigestQuerySchema } },
      async (req) => {
        const s = await requireUserWithFeature(ctx, req, 'interests');
        const r = await interestItems(ctx.pool, s.user.id, req.params.id, req.query.status);
        if (!r) throw notFound('interest not found');
        return DigestItemsResponseSchema.parse({ items: r.map(toDigestDto) });
      },
    );

    app.put(
      '/api/interests/:id/taste',
      { schema: { params: IdParamsSchema, body: InterestTasteRequestSchema } },
      async (req) => {
        const s = await requireUserWithFeature(ctx, req, 'interests');
        await setInterestTaste(ctx, s.user, req.params.id, req.body.rules);
        return OkResponseSchema.parse({ ok: true });
      },
    );

    app.post('/api/interests/:id/taste/resync', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUserWithFeature(ctx, req, 'interests');
      await resyncInterestTaste(ctx, s.user, req.params.id);
      return OkResponseSchema.parse({ ok: true });
    });

    app.get('/api/interests/:id/agents/eligible', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUserWithFeature(ctx, req, 'interests');
      const r = await eligibleAgents(ctx.pool, s.user.id, req.params.id, ctx.clock.now());
      if (!r) throw notFound('interest not found');
      return EligibleAgentsResponseSchema.parse(r);
    });

    app.post(
      '/api/interests/:id/members',
      { schema: { params: IdParamsSchema, body: InterestMemberRequestSchema } },
      async (req) => {
        const s = await requireUserWithFeature(ctx, req, 'interests');
        await shareInterest(ctx, s.user, req.params.id, req.body.userId);
        return OkResponseSchema.parse({ ok: true });
      },
    );

    app.delete(
      '/api/interests/:id/members/:userId',
      { schema: { params: MemberParamsSchema } },
      async (req) => {
        const s = await requireUserWithFeature(ctx, req, 'interests');
        await unshareInterest(ctx, s.user, req.params.id, req.params.userId);
        return OkResponseSchema.parse({ ok: true });
      },
    );
  };
}
