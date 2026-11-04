import {
  CardParamsSchema,
  DecisionPolicyRequestSchema,
  IdParamsSchema,
  isOrgManager,
  MemberParamsSchema,
  MoveAllAgentsPreviewQuerySchema,
  MoveAllAgentsRequestSchema,
  MoveTargetsResponseSchema,
  RehomeAgentRequestSchema,
  ShareProjectRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireOrg, requireUser } from '../auth/guards.ts';
import { whoOf } from '../auth/org-context.ts';
import {
  answerShare,
  listProjectInvitations,
  loadMovableAgent,
  loadSourceWorkstation,
  moveAllAgents,
  previewRemoval,
  rehomeAgent,
  rehomeCard,
  removeMember,
  setDecisionPolicy,
  shareProject,
} from '../commands/sharing.ts';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import { forbidden, notFound } from '../errors.ts';
import { getAgentDto } from '../queries/agents.ts';
import { getCardDetail } from '../queries/cards.ts';
import { getProjectDetail } from '../queries/misc.ts';
import { agentHomes, listMoveTargets } from '../queries/move-targets.ts';
import { typed } from './util.ts';

/** Shared projects, member removal, agent re-homing, decision policy and card re-home (M3). */
export function sharingRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/project-invitations', async (req) => {
      const s = await requireUser(ctx, req);
      return { invitations: await listProjectInvitations(ctx, s.user.id) };
    });

    app.post(
      '/api/projects/:id/members',
      { schema: { params: IdParamsSchema, body: ShareProjectRequestSchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        await shareProject(ctx, s.user, req.params.id, req.body.email);
        reply.code(201);
        return getProjectDetail(ctx, s.user.id, req.params.id);
      },
    );

    app.post('/api/projects/:id/members/accept', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      await answerShare(ctx, s.user, req.params.id, true);
      return getProjectDetail(ctx, s.user.id, req.params.id);
    });

    app.post('/api/projects/:id/members/decline', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      await answerShare(ctx, s.user, req.params.id, false);
      return { ok: true };
    });

    app.get(
      '/api/projects/:id/members/:userId/removal-preview',
      { schema: { params: MemberParamsSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        return previewRemoval(ctx, s.user, req.params.id, req.params.userId);
      },
    );

    app.delete(
      '/api/projects/:id/members/:userId',
      { schema: { params: MemberParamsSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        const r = await removeMember(ctx, s.user, req.params.id, req.params.userId);
        return { project: await getProjectDetail(ctx, s.user.id, req.params.id), ...r };
      },
    );

    app.post(
      '/api/agents/:id/rehome',
      { schema: { params: IdParamsSchema, body: RehomeAgentRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await rehomeAgent(ctx, s.user, req.params.id, req.body);
        const a = await getAgentDto(ctx, s.user.id, req.params.id);
        if (!a) throw notFound('agent not found');
        return a;
      },
    );

    /** The workstations an Owner or Admin can move this agent to (same rule as the move itself). */
    app.get('/api/agents/:id/move-targets', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      const a = await loadMovableAgent(ctx.pool, s.user, req.params.id);
      return MoveTargetsResponseSchema.parse(await listMoveTargets(ctx.pool, a, s.user.id));
    });

    /** Workstations (any status) that hold agents the caller may move: all for an Owner or Admin, the hired ones otherwise. */
    app.get('/api/agents/workstations', async (req) => {
      const a = await requireOrg(ctx, req);
      return {
        workstations: await agentHomes(ctx.pool, a.orgId, a.session.user.id, {
          own: !isOrgManager({ orgRole: a.role }),
        }),
      };
    });

    /** Moves every agent of a workstation the caller may move to another one (partial success is reported). */
    app.post(
      '/api/workstations/:id/move-agents',
      { schema: { params: IdParamsSchema, body: MoveAllAgentsRequestSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req);
        const r = await moveAllAgents(ctx, whoOf(a), req.params.id, req.body);
        if (r.moved.length > 0) ctx.services.dispatcher.trigger();
        return r;
      },
    );

    /** What the move would do, without writing anything. */
    app.get(
      '/api/workstations/:id/move-agents/preview',
      { schema: { params: IdParamsSchema, querystring: MoveAllAgentsPreviewQuerySchema } },
      async (req) => {
        const a = await requireOrg(ctx, req);
        return moveAllAgents(ctx, whoOf(a), req.params.id, req.query, { dryRun: true });
      },
    );

    /** The workstations the agents of :id can move to (same rule as the single move). */
    app.get('/api/workstations/:id/move-targets', { schema: { params: IdParamsSchema } }, async (req) => {
      const a = await requireOrg(ctx, req);
      if (!(await loadSourceWorkstation(ctx.pool, a.orgId, req.params.id)))
        throw notFound('workstation not found in this organization', 'workstation_not_found');
      if (!isOrgManager({ orgRole: a.role })) {
        const own = await one(
          ctx.pool,
          `SELECT 1 FROM agents WHERE org_id=$1 AND workstation_id=$2 AND status <> 'retired'
             AND manager_user_id=$3 AND NOT is_builtin LIMIT 1`,
          [a.orgId, req.params.id, a.session.user.id],
        );
        if (!own)
          throw forbidden(
            'only the organization Owner and Admins, or the hiring manager of these agents, can move them',
          );
      }
      return MoveTargetsResponseSchema.parse(
        await listMoveTargets(
          ctx.pool,
          { org_id: a.orgId, workstation_id: req.params.id },
          a.session.user.id,
        ),
      );
    });

    app.post(
      '/api/cards/:id/decision-policy',
      { schema: { params: CardParamsSchema, body: DecisionPolicyRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        const id = await setDecisionPolicy(ctx, s.user, req.params.id, req.body);
        return getCardDetail(ctx, s.user.id, id);
      },
    );

    app.post('/api/cards/:id/rehome', { schema: { params: CardParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      const id = await rehomeCard(ctx, s.user, req.params.id);
      ctx.services.dispatcher.trigger();
      return getCardDetail(ctx, s.user.id, id);
    });
  };
}
