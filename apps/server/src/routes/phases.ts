import {
  AssignCardPhaseRequestSchema,
  CardParamsSchema,
  ConfirmMergedRequestSchema,
  CreateDeployTargetRequestSchema,
  CreatePhaseRequestSchema,
  FollowupDefaultsResponseSchema,
  IdParamsSchema,
  PatchDeployTargetRequestSchema,
  PatchPhaseRequestSchema,
  PhaseByNumberParamsSchema,
  PhaseParamsSchema,
  ReopenPhaseRequestSchema,
  SetFollowupsRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guards.ts';
import { requireProjectMember } from '../authz/scope.ts';
import {
  addDeployTarget,
  listDeployTargets,
  listMemberWorkstations,
  removeDeployTarget,
  toTargetDto,
  updateDeployTarget,
} from '../commands/deploy-targets.ts';
import {
  assignCardToPhase,
  confirmCardMerged,
  createPhase,
  getFollowupDefaults,
  reopenPhase,
  setFollowupDefaults,
  setPhaseFollowups,
  updatePhase,
} from '../commands/phases.ts';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import { notFound } from '../errors.ts';
import { getCardDetail } from '../queries/cards.ts';
import { getPhase, getPhaseByNumber, listPhases } from '../queries/phases.ts';
import { typed } from './util.ts';

/** Phases, follow-ups, deploy targets (docs/design/phases.md A10). Any active member of the project may use them. */
export function phaseRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/projects/:id/phases', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return { phases: await listPhases(ctx, s.user.id, req.params.id) };
    });

    app.post(
      '/api/projects/:id/phases',
      { schema: { params: IdParamsSchema, body: CreatePhaseRequestSchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        const id = await createPhase(ctx, s.user, req.params.id, req.body);
        ctx.services.dispatcher.trigger();
        reply.code(201);
        return getPhase(ctx, s.user.id, id);
      },
    );

    app.get('/api/phases/:id', { schema: { params: PhaseParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return getPhase(ctx, s.user.id, req.params.id);
    });

    app.get(
      '/api/phases/by-number/:projectKey/:number',
      { schema: { params: PhaseByNumberParamsSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        return getPhaseByNumber(ctx, s.user.id, req.params.projectKey, req.params.number);
      },
    );

    app.patch(
      '/api/phases/:id',
      { schema: { params: PhaseParamsSchema, body: PatchPhaseRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await updatePhase(ctx, s.user, req.params.id, req.body);
        return getPhase(ctx, s.user.id, req.params.id);
      },
    );

    app.put(
      '/api/phases/:id/followups',
      { schema: { params: PhaseParamsSchema, body: SetFollowupsRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await setPhaseFollowups(ctx, s.user, req.params.id, req.body.followups);
        return getPhase(ctx, s.user.id, req.params.id);
      },
    );

    app.post(
      '/api/phases/:id/reopen',
      { schema: { params: PhaseParamsSchema, body: ReopenPhaseRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await reopenPhase(ctx, s.user, req.params.id, req.body.reason);
        return getPhase(ctx, s.user.id, req.params.id);
      },
    );

    app.put(
      '/api/cards/:id/phase',
      { schema: { params: CardParamsSchema, body: AssignCardPhaseRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await assignCardToPhase(ctx, s.user, req.params.id, req.body);
        return getCardDetail(ctx, s.user.id, req.params.id);
      },
    );

    app.post(
      '/api/cards/:id/confirm-merged',
      { schema: { params: CardParamsSchema, body: ConfirmMergedRequestSchema.default({}) } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await confirmCardMerged(ctx, s.user, req.params.id, req.body.note);
        return getCardDetail(ctx, s.user.id, req.params.id);
      },
    );

    app.get('/api/projects/:id/followup-defaults', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return { followups: await getFollowupDefaults(ctx, s.user, req.params.id) };
    });

    app.put(
      '/api/projects/:id/followup-defaults',
      { schema: { params: IdParamsSchema, body: FollowupDefaultsResponseSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await setFollowupDefaults(ctx, s.user, req.params.id, req.body.followups);
        return { followups: await getFollowupDefaults(ctx, s.user, req.params.id) };
      },
    );

    app.get('/api/projects/:id/deploy-targets', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      await requireProjectMember(ctx.pool, s.user.id, req.params.id);
      return { targets: (await listDeployTargets(ctx.pool, req.params.id)).map(toTargetDto) };
    });

    // Any project member sees the workstations of every member (needed to name one in a remote deploy target).
    app.get('/api/projects/:id/workstations', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      await requireProjectMember(ctx.pool, s.user.id, req.params.id);
      return { workstations: await listMemberWorkstations(ctx.pool, req.params.id, s.user.id) };
    });

    app.post(
      '/api/projects/:id/deploy-targets',
      { schema: { params: IdParamsSchema, body: CreateDeployTargetRequestSchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        const id = await addDeployTarget(ctx, s.user, req.params.id, req.body);
        reply.code(201);
        const t = (await listDeployTargets(ctx.pool, req.params.id)).find((x) => x.id === id);
        return toTargetDto(t ?? notFound());
      },
    );

    app.patch(
      '/api/deploy-targets/:id',
      { schema: { params: IdParamsSchema, body: PatchDeployTargetRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await updateDeployTarget(ctx, s.user, req.params.id, req.body);
        const row = await one(ctx.pool, 'SELECT project_id FROM deploy_targets WHERE id=$1', [req.params.id]);
        const t = (await listDeployTargets(ctx.pool, row?.project_id)).find((x) => x.id === req.params.id);
        return toTargetDto(t ?? notFound());
      },
    );

    app.delete('/api/deploy-targets/:id', { schema: { params: IdParamsSchema } }, async (req, reply) => {
      const s = await requireUser(ctx, req);
      await removeDeployTarget(ctx, s.user, req.params.id);
      reply.code(204);
    });
  };
}
