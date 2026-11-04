import {
  type CeoActionName,
  type MoveWorkstationParams,
  MoveWorkstationParamsSchema,
  type RehomeAgentRequest,
} from '@aom/shared';
import { checkAgentMove, rehomeAgent } from '../commands/sharing.ts';
import { one, type Row } from '../db/sql.ts';
import { HttpError } from '../errors.ts';
import { orgWorkstationSql } from '../queries/move-targets.ts';
import { agentByName, refuse } from './actions.ts';
import type { ActionDef } from './types.ts';

/**
 * `move-workstation`: the owner/admin move of GWP-59, run for the CEO. The rules of the move itself come from
 * `checkAgentMove` (in `prepare`, to refuse early) and from `rehomeAgent` (in `execute`, which checks again inside its
 * transaction). The one rule of its own: like `hire` and `scale`, the CEO only uses the Owner's own workstations.
 */
const moveWorkstation: ActionDef<MoveWorkstationParams> = {
  cls: 'agent.move_workstation',
  schema: MoveWorkstationParamsSchema,
  auditRefusals: true,
  describe: (_p, pr) =>
    `Move ${pr.subjectLabel} from ${pr.data?.from ?? 'no workstation'} to ${pr.data?.to ?? 'another workstation'}`,
  async prepare(env, p) {
    const db = env.ctx.pool;
    const a = await agentByName(db, env.orgId, p.agentId);
    if (!a) return refuse(`agent ${p.agentId} not found in this organization`);
    const base = {
      subjectKind: 'agent',
      subjectId: a.id as string,
      subjectLabel: `${a.name} (${a.role_key})`,
      targetAgentId: a.id as string,
    };
    const ws = await one(
      db,
      `SELECT id, name, connected FROM workstations
        WHERE (id::text=$2 OR lower(name)=lower($2)) AND (user_id=$3 OR simulation_org_id=$1)
        ORDER BY (status='active') DESC LIMIT 1`,
      [env.orgId, p.targetWorkstationId, env.owner.id],
    );
    if (!ws) {
      const member = await one(
        db,
        `SELECT w.name FROM workstations w
          WHERE (w.id::text=$2 OR lower(w.name)=lower($2)) AND ${orgWorkstationSql('w', '$1::uuid')} LIMIT 1`,
        [env.orgId, p.targetWorkstationId],
      );
      return {
        ...base,
        refuse: member
          ? `${member.name} belongs to another member: the owner moves agents there in the UI (Agents, Move to workstation)`
          : 'workstation not found in this organization',
      };
    }
    const req: RehomeAgentRequest = {
      workstationId: ws.id,
      runtime: a.runtime,
      model: a.model,
      acknowledgeUnsandboxed: false,
    };
    try {
      await checkAgentMove(env.ctx, db, { userId: env.owner.id }, a, req, {
        releaseHeldClaims: true,
      });
    } catch (err) {
      if (err instanceof HttpError) return { ...base, refuse: err.message };
      throw err;
    }
    const from = a.workstation_id
      ? await one(db, 'SELECT name FROM workstations WHERE id=$1', [a.workstation_id])
      : undefined;
    return { ...base, data: { agent: a, ws, req, from: from?.name ?? null, to: ws.name } };
  },
  async execute(env, _p, pr) {
    const { agent: a, ws, req } = pr.data as { agent: Row; ws: Row; req: RehomeAgentRequest };
    await rehomeAgent(env.ctx, env.owner, a.id, req);
    return {
      message: `${a.name} moved to ${ws.name}${ws.connected ? '' : ` (${ws.name} is offline: it works once it connects)`}.`,
      result: { agentId: a.id, fromWorkstationId: a.workstation_id ?? null, toWorkstationId: ws.id },
    };
  },
};

export const ACTIONS7: Partial<Record<CeoActionName, ActionDef>> = { 'move-workstation': moveWorkstation };
