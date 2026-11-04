import {
  type CeoActionName,
  MOVE_BLOCK_LABEL,
  type MoveAgentsOffParams,
  MoveAgentsOffParamsSchema,
  type MoveAllAgentsResponse,
  type MoveWorkstationParams,
  MoveWorkstationParamsSchema,
  type OrgRole,
  type RehomeAgentRequest,
} from '@aom/shared';
import { checkAgentMove, moveAllAgents, rehomeAgent } from '../commands/sharing.ts';
import { one, type Row, rows } from '../db/sql.ts';
import { conflict, HttpError } from '../errors.ts';
import { orgWorkstationSql } from '../queries/move-targets.ts';
import { agentByName, refuse } from './actions.ts';
import type { ActionDef, ActionEnv } from './types.ts';

/** One of the Owner's workstations by name or id (the active one first), or the refusal text. */
async function ownerTarget(env: ActionEnv, ref: string): Promise<{ ws: Row } | { refuse: string }> {
  const db = env.ctx.pool;
  const ws = await one(
    db,
    `SELECT id, name, connected FROM workstations
        WHERE (id::text=$2 OR lower(name)=lower($2)) AND (user_id=$3 OR simulation_org_id=$1)
        ORDER BY (status='active') DESC LIMIT 1`,
    [env.orgId, ref, env.owner.id],
  );
  if (ws) return { ws };
  const member = await one(
    db,
    `SELECT w.name FROM workstations w
          WHERE (w.id::text=$2 OR lower(w.name)=lower($2)) AND ${orgWorkstationSql('w', '$1::uuid')} LIMIT 1`,
    [env.orgId, ref],
  );
  return {
    refuse: member
      ? `${member.name} belongs to another member: the owner moves agents there in the UI (Agents, Move to workstation)`
      : 'workstation not found in this organization',
  };
}

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
    const t = await ownerTarget(env, p.targetWorkstationId);
    if ('refuse' in t) return { ...base, refuse: t.refuse };
    const ws = t.ws;
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

type BulkOutcome = Pick<MoveAllAgentsResponse, 'moved' | 'blocked'>;

/** One line per agent: what the CEO reads, what the CLI prints, what the audit keeps. */
function bulkLines(o: BulkOutcome, verb: 'moved' | 'will move'): string {
  const claims = o.moved.flatMap((m) => m.releasedClaims);
  return [
    ...(o.moved.length ? [`${verb}: ${o.moved.map((m) => m.name).join(', ')}`] : []),
    ...(claims.length ? [`claims released: ${claims.join(', ')}`] : []),
    ...o.blocked.map((b) => `blocked: ${b.name}: ${MOVE_BLOCK_LABEL[b.reason]}: ${b.message}`),
  ].join('\n');
}

const stateOf = (w: Row): string => (w.status !== 'active' ? 'removed' : w.connected ? 'online' : 'offline');

/** The workstation (any status, any owner) that holds this organization's agents, by id or name. */
async function sourceWorkstation(env: ActionEnv, ref: string): Promise<{ ws: Row } | { refuse: string }> {
  const list = await rows(
    env.ctx.pool,
    `SELECT w.id, w.name, w.status, w.connected, (w.id::text = $2) AS by_id
       FROM workstations w
      WHERE (w.id::text = $2 OR lower(w.name) = lower($2))
        AND EXISTS (SELECT 1 FROM agents a WHERE a.workstation_id = w.id AND a.org_id = $1 AND a.status <> 'retired')
      ORDER BY (w.id::text = $2) DESC, w.status, w.id LIMIT 5`,
    [env.orgId, ref],
  );
  if (list.length === 0) return { refuse: `workstation ${ref} holds no agents of this organization` };
  if (list.length > 1 && !list[0]?.by_id)
    return {
      refuse: `${list.length} workstations are named ${ref}: give its id (${list.map((w) => `${w.id} ${stateOf(w)}`).join(', ')})`,
    };
  return { ws: list[0] as Row };
}

const OWNER_ROLE: OrgRole = 'owner';

/**
 * `move-agents-off`: the owner's bulk move (GWP-75) run for the CEO. `moveAllAgents` does every per-agent check and
 * the claim release; the dry run in `prepare` is the preview the UI shows. The rules of its own: the source is offline
 * or removed, and the target is one of the Owner's own workstations.
 */
const moveAgentsOff: ActionDef<MoveAgentsOffParams> = {
  cls: 'agent.move_workstation',
  schema: MoveAgentsOffParamsSchema,
  auditRefusals: true,
  describe: (_p, pr) => {
    const d = pr.data as { src: Row; to: string; preview: BulkOutcome } | undefined;
    if (!d) return `Move the agents of ${pr.subjectLabel} to another workstation`;
    const stay = d.preview.blocked.map((b) => `${b.name}: ${MOVE_BLOCK_LABEL[b.reason]}`).join(', ');
    return `Move ${d.preview.moved.length} agent(s) (${d.preview.moved.map((m) => m.name).join(', ')}) from ${d.src.name} (${stateOf(d.src)}) to ${d.to}${stay ? `; staying: ${stay}` : ''}`;
  },
  async prepare(env, p) {
    const found = await sourceWorkstation(env, p.from);
    if ('refuse' in found) return refuse(found.refuse);
    const src = found.ws;
    const base = {
      subjectKind: 'workstation',
      subjectId: src.id as string,
      subjectLabel: src.name as string,
    };
    if (src.status === 'active' && src.connected)
      return { ...base, refuse: `${src.name} is online: move its agents one by one with move-workstation` };
    const t = await ownerTarget(env, p.to);
    if ('refuse' in t) return { ...base, refuse: t.refuse };
    const who = { userId: env.owner.id, orgId: env.orgId, role: OWNER_ROLE };
    let preview: MoveAllAgentsResponse;
    try {
      preview = await moveAllAgents(env.ctx, who, src.id, { targetWorkstationId: t.ws.id }, { dryRun: true });
    } catch (err) {
      if (err instanceof HttpError) return { ...base, refuse: err.message };
      throw err;
    }
    const o: BulkOutcome = { moved: preview.moved, blocked: preview.blocked };
    if (o.moved.length === 0)
      return {
        ...base,
        refuse: `no agent can move from ${src.name} to ${t.ws.name}:\n${bulkLines(o, 'will move')}`,
      };
    return { ...base, data: { src, target: t.ws, to: t.ws.name, preview: o } };
  },
  async execute(env, _p, pr) {
    const { src, target } = pr.data as { src: Row; target: Row };
    const who = { userId: env.owner.id, orgId: env.orgId, role: OWNER_ROLE };
    const r = await moveAllAgents(env.ctx, who, src.id, { targetWorkstationId: target.id });
    const o: BulkOutcome = { moved: r.moved, blocked: r.blocked };
    if (o.moved.length === 0)
      throw conflict(
        'nothing_moved',
        `no agent moved from ${src.name} to ${target.name}:\n${bulkLines(o, 'moved')}`,
      );
    env.ctx.services.dispatcher.trigger();
    const total = o.moved.length + o.blocked.length;
    return {
      message: `Moved ${o.moved.length} of ${total} agent(s) from ${src.name} to ${target.name}${target.connected ? '' : ` (${target.name} is offline: they work once it connects)`}.\n${bulkLines(o, 'moved')}${r.needsUnsandboxedAck ? '\nthe owner can accept running without a sandbox in the UI (Agents, Move all agents)' : ''}`,
      result: { sourceWorkstationId: src.id, targetWorkstationId: target.id, ...o },
    };
  },
};

export const ACTIONS7: Partial<Record<CeoActionName, ActionDef>> = {
  'move-workstation': moveWorkstation,
  'move-agents-off': moveAgentsOff,
};
