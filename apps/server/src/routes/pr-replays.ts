import {
  MarkFindingRequestSchema,
  SetReviewTargetsRequestSchema,
  StartReplayRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/guards.ts';
import { projectRole } from '../authz/scope.ts';
import {
  cancelReplay,
  markReplayFinding,
  recordFindingShown,
  retryFailedReplayRuns,
  setReviewTargets,
  startReplay,
} from '../commands/pr-replays.ts';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import { notFound } from '../errors.ts';
import { getProjectDetail } from '../queries/misc.ts';
import { getReplayDto, listReplayFindings, listReplays, nextReplayFinding } from '../queries/pr-replays.ts';
import { typed } from './util.ts';

const IdParams = z.object({ id: z.uuid() });
const HeldQuery = z.object({ held: z.enum(['0', '1']).optional() });

/** The 20-PR replay: start, progress, blind marking, result and the owner's targets. */
export const prReplayRoutes = (ctx: Ctx) => async (fastify: FastifyInstance) => {
  const app = typed(fastify);

  /** Role of the user on the replay's project; 404 for a non-member. */
  async function replayAccess(userId: string, replayId: string) {
    const rp = await one(ctx.pool, 'SELECT project_id FROM pr_replays WHERE id=$1', [replayId]);
    if (!rp) throw notFound('replay not found');
    const role = await projectRole(ctx.pool, userId, rp.project_id as string);
    if (!role) throw notFound('replay not found');
    return role;
  }

  app.post(
    '/api/projects/:id/pr-replays',
    { schema: { params: IdParams, body: StartReplayRequestSchema } },
    async (req, reply) => {
      const s = await requireUser(ctx, req);
      reply.code(201);
      return startReplay(ctx, s.user, req.params.id, req.body);
    },
  );

  app.get('/api/projects/:id/pr-replays', { schema: { params: IdParams } }, async (req) => {
    const s = await requireUser(ctx, req);
    return { replays: await listReplays(ctx.pool, s.user.id, req.params.id) };
  });

  app.get('/api/pr-replays/:id', { schema: { params: IdParams } }, async (req) => {
    const s = await requireUser(ctx, req);
    const role = await replayAccess(s.user.id, req.params.id);
    const dto = await getReplayDto(ctx.pool, req.params.id, role === 'owner');
    if (!dto) throw notFound('replay not found');
    return dto;
  });

  app.post('/api/pr-replays/:id/cancel', { schema: { params: IdParams } }, async (req) => {
    const s = await requireUser(ctx, req);
    return cancelReplay(ctx, s.user, req.params.id);
  });

  app.post('/api/pr-replays/:id/retry-failed', { schema: { params: IdParams } }, async (req) => {
    const s = await requireUser(ctx, req);
    return retryFailedReplayRuns(ctx, s.user, req.params.id);
  });

  app.get('/api/pr-replays/:id/next-finding', { schema: { params: IdParams } }, async (req) => {
    const s = await requireUser(ctx, req);
    const role = await replayAccess(s.user.id, req.params.id);
    return { next: await nextReplayFinding(ctx.pool, req.params.id, role === 'owner') };
  });

  app.get(
    '/api/pr-replays/:id/findings',
    { schema: { params: IdParams, querystring: HeldQuery } },
    async (req) => {
      const s = await requireUser(ctx, req);
      const role = await replayAccess(s.user.id, req.params.id);
      return {
        findings: await listReplayFindings(ctx.pool, req.params.id, {
          held: req.query.held === '1',
          canMark: role === 'owner',
        }),
      };
    },
  );

  app.post('/api/pr-replay-findings/:id/shown', { schema: { params: IdParams } }, async (req, reply) => {
    const s = await requireUser(ctx, req);
    await recordFindingShown(ctx, s.user, req.params.id);
    reply.code(204);
    return null;
  });

  app.put(
    '/api/pr-replay-findings/:id/mark',
    { schema: { params: IdParams, body: MarkFindingRequestSchema } },
    async (req) => {
      const s = await requireUser(ctx, req);
      return markReplayFinding(ctx, s.user, req.params.id, req.body);
    },
  );

  app.put(
    '/api/projects/:id/review-targets',
    { schema: { params: IdParams, body: SetReviewTargetsRequestSchema } },
    async (req) => {
      const s = await requireUser(ctx, req);
      await setReviewTargets(ctx, s.user, req.params.id, req.body);
      return getProjectDetail(ctx, s.user.id, req.params.id);
    },
  );
};
