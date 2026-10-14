import {
  canManageCard,
  IdParamsSchema,
  isOrgManager,
  ShiftsQuerySchema,
  StopShiftRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guards.ts';
import { orgRoleOf } from '../auth/org-context.ts';
import { projectRole } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { exec, one, rows } from '../db/sql.ts';
import { conflict, forbidden, notFound } from '../errors.ts';
import { SHIFT_SELECT, toShiftDto } from '../queries/cards.ts';
import { typed } from './util.ts';

/**
 * Visible = the shift's card is in one of the user's projects, or (no card: a chat, DevOps or BA shift) the user is an
 * Owner or Admin of its organization or it runs on one of their own workstations.
 */
const VISIBLE = `(EXISTS (SELECT 1 FROM project_members pm WHERE pm.user_id = $1 AND pm.status='active' AND pm.project_id = c.project_id)
  OR (s.card_id IS NULL AND (EXISTS (SELECT 1 FROM org_members om WHERE om.org_id = s.org_id AND om.user_id = $1
        AND om.status = 'active' AND om.role IN ('owner','admin'))
      OR EXISTS (SELECT 1 FROM workstations w WHERE w.id = s.workstation_id AND w.user_id = $1))))`;

export function shiftRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/shifts', { schema: { querystring: ShiftsQuerySchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      const list = await rows(
        ctx.pool,
        `${SHIFT_SELECT} WHERE ${VISIBLE} AND ($2::uuid IS NULL OR s.agent_id = $2) AND ($3::uuid IS NULL OR s.card_id = $3) AND ($4::boolean IS NOT TRUE OR s.status <> 'ended')
          ORDER BY s.started_at DESC LIMIT 200`,
        [s.user.id, req.query.agentId ?? null, req.query.cardId ?? null, req.query.active === '1'],
      );
      return { shifts: list.map(toShiftDto) };
    });

    app.get('/api/shifts/:id', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      const row = await one(ctx.pool, `${SHIFT_SELECT} WHERE s.id = $2 AND ${VISIBLE}`, [
        s.user.id,
        req.params.id,
      ]);
      if (!row) throw notFound('shift not found');
      return toShiftDto(row);
    });

    /** The card's owner or project owner; for a shift without a card, its workstation's owner or an org manager. */
    const loadForStop = async (userId: string, shiftId: string) => {
      const row = await one(ctx.pool, `${SHIFT_SELECT} WHERE s.id = $2 AND ${VISIBLE}`, [userId, shiftId]);
      if (!row) throw notFound('shift not found');
      if (row.status === 'ended') throw conflict('shift_ended', 'shift has already ended');
      if (row.card_id) {
        const card = await one(ctx.pool, 'SELECT project_id, owner_user_id FROM cards WHERE id=$1', [
          row.card_id,
        ]);
        const role = card ? await projectRole(ctx.pool, userId, card.project_id) : null;
        if (!card || !canManageCard({ userId, projectRole: role, cardOwnerUserId: card.owner_user_id })) {
          throw forbidden('only the card owner or the project owner can stop a shift');
        }
      } else {
        const own = await one(ctx.pool, 'SELECT 1 FROM workstations WHERE id=$1 AND user_id=$2', [
          row.workstation_id,
          userId,
        ]);
        if (!own && !isOrgManager({ orgRole: await orgRoleOf(ctx.pool, userId, row.org_id) }))
          throw forbidden('only the organization Owner and Admins can stop this shift');
      }
      return row;
    };

    /**
     * Stops a shift. By default the card goes back in the queue; `keepCard` keeps it with the same agent, which starts
     * a fresh shift (only for a card shift). The runner saves the work in the worktree either way.
     */
    app.post(
      '/api/shifts/:id/stop',
      { schema: { params: IdParamsSchema, body: StopShiftRequestSchema.optional() } },
      async (req) => {
        const s = await requireUser(ctx, req);
        const row = await loadForStop(s.user.id, req.params.id);
        const keep = req.body?.keepCard === true && !!row.card_id;
        if (keep) await exec(ctx.pool, 'UPDATE shifts SET stop_keep_card=true WHERE id=$1', [row.id]);
        const sent = ctx.services.gateway.stopShift(row.workstation_id, row.id, 'manager');
        return { ok: true, sent };
      },
    );

    /** "Stop the running command": the agent's commands are killed, the shift goes on and the agent sees the command fail. */
    app.post('/api/shifts/:id/kill-tools', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      const row = await loadForStop(s.user.id, req.params.id);
      const sent = ctx.services.gateway.killTools(row.workstation_id, row.id);
      return { ok: true, sent };
    });
  };
}
