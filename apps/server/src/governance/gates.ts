import { randomUUID } from 'node:crypto';
import {
  GATE_APPROVAL_TTL_MS,
  GATE_DESK_SUBKIND,
  GATE_INFO,
  type GateClass,
  type SetAgentGateRequest,
  streamId,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { manageableAgent } from '../commands/agents.ts';
import { orgScope, projectScope, SYSTEM_ACTOR, userActor } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';

/** After a rejection the same ask is not raised again for this long (the agent is told, and does not nag). */
const REJECTED_QUIET_MS = 3600_000;

export async function gatedClassesOf(db: Queryable, agentId: string): Promise<Set<GateClass>> {
  const r = await rows<{ action_class: GateClass }>(
    db,
    'SELECT action_class FROM agent_action_gates WHERE agent_id=$1',
    [agentId],
  );
  return new Set(r.map((x) => x.action_class));
}

export async function isGated(db: Queryable, agentId: string, cls: GateClass): Promise<boolean> {
  return !!(await one(db, 'SELECT 1 FROM agent_action_gates WHERE agent_id=$1 AND action_class=$2', [
    agentId,
    cls,
  ]));
}

/**
 * Turns a gate on or off. Whoever manages the agent may turn one on (a gate only narrows); turning one off needs an Owner
 * or Admin. Defaults stay as they are: an agent has no gate until somebody sets one (the CEO keeps its own policy).
 */
export async function setAgentGate(
  ctx: Ctx,
  user: AuthSession['user'],
  agentId: string,
  req: SetAgentGateRequest,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const a = await manageableAgent(tx, user, agentId);
    if (a.status === 'retired') throw conflict('agent_retired', 'agent is retired');
    if (a.role_key === 'ceo')
      throw badRequest(
        'ceo_policy',
        'the CEO keeps its own policy (Settings > CEO): gates do not apply to it',
      );
    const info = GATE_INFO[req.actionClass];
    if (info.enforcement === 'always')
      throw badRequest('always_gated', `${info.label} always asks the manager: there is nothing to switch`);
    if (info.enforcement === 'not_enforced')
      throw badRequest('not_enforced', `${info.label} cannot be gated yet: ${info.note}`);
    const had = await isGated(tx, agentId, req.actionClass);
    if (had === req.gated) return;
    if (!req.gated) {
      const role = await orgRoleOf(tx, user.id, a.org_id);
      if (role !== 'owner' && role !== 'admin')
        throw forbidden('only an Owner or an Admin can take an approval gate off');
    }
    await ctx.store.append(
      [
        {
          streamId: streamId.agent(agentId),
          event: {
            type: 'AgentGateSet',
            payload: {
              agentId,
              orgId: a.org_id,
              actionClass: req.actionClass,
              gated: req.gated,
              by: user.id,
            },
          },
          actor: userActor(user.id),
          scope: orgScope(a.org_id),
        },
      ],
      { tx },
    );
  });
}

export type GateOutcome = { ok: true } | { ok: false; message: string };

export interface GateAsk {
  agent: Row;
  actionClass: GateClass;
  /** The target of the action: the retry must match it, so an approval for one delegate is not one for another. */
  fingerprint: string;
  /** Said to the approver: what the agent wants to do. */
  summary: string;
  projectId?: string | null | undefined;
  cardId?: string | null | undefined;
}

/**
 * The choke point for a gated action. Not gated: ok. Gated: an approval the agent has not used yet (and is not older than two
 * hours) is used up and the action goes on; otherwise a desk item asks and the agent is told to wait and retry the same
 * command. A recent rejection is reported without asking again. Runs on its own transaction.
 */
export async function gateAction(ctx: Ctx, ask: GateAsk): Promise<GateOutcome> {
  const { agent, actionClass, fingerprint } = ask;
  if (!(await isGated(ctx.pool, agent.id, actionClass))) return { ok: true };
  const label = GATE_INFO[actionClass].label.toLowerCase();
  const now = ctx.clock.now();
  return withAppendTx(ctx.pool, async (tx): Promise<GateOutcome> => {
    const latest = await rows(
      tx,
      `SELECT * FROM gated_actions WHERE agent_id=$1 AND action_class=$2 AND fingerprint=$3
        ORDER BY requested_at DESC LIMIT 5 FOR UPDATE`,
      [agent.id, actionClass, fingerprint],
    );
    const usable = latest.find(
      (r) =>
        r.status === 'approved' &&
        r.decided_at &&
        now.getTime() - new Date(r.decided_at).getTime() <= GATE_APPROVAL_TTL_MS,
    );
    if (usable) {
      await ctx.store.append(
        [
          {
            streamId: streamId.agent(agent.id),
            event: {
              type: 'GatedActionUsed',
              payload: { requestId: usable.request_id, orgId: agent.org_id, agentId: agent.id },
            },
            actor: SYSTEM_ACTOR,
            scope: orgScope(agent.org_id),
          },
        ],
        { tx },
      );
      return { ok: true };
    }
    if (latest.some((r) => r.status === 'pending'))
      return {
        ok: false,
        message: `approval_pending: the manager has not decided yet whether you may ${label} (${ask.summary}). Do not retry in a loop: carry on with other work; once it is approved, the same command goes through.`,
      };
    const rejected = latest.find((r) => r.status === 'rejected');
    if (rejected?.decided_at && now.getTime() - new Date(rejected.decided_at).getTime() < REJECTED_QUIET_MS)
      return {
        ok: false,
        message: `approval_rejected: the manager said no to this (${ask.summary}). Do not try it again; carry on without it or ask on the card or in the chat what they would like instead.`,
      };
    const requestId = randomUUID();
    const deskItemId = randomUUID();
    const scope = ask.projectId ? projectScope(agent.org_id, ask.projectId) : orgScope(agent.org_id);
    const events: AppendInput[] = [
      {
        streamId: streamId.desk(deskItemId),
        event: {
          type: 'DeskItemCreated',
          payload: {
            deskItemId,
            kind: 'approval',
            subkind: GATE_DESK_SUBKIND,
            title: `Allow ${agent.name} to ${label}?`,
            body: `${agent.name} wants to ${label}: ${ask.summary}\n\nThis agent is set to ask before it does this. Approve to let its next attempt go through (once); reject to say no.`,
            options: [],
            blocking: false,
            pinned: false,
            affectedCardIds: ask.cardId ? [ask.cardId] : [],
            ...(ask.projectId ? { projectId: ask.projectId } : {}),
            ...(ask.cardId ? { cardId: ask.cardId } : {}),
            askedBy: { kind: 'agent', agentId: agent.id },
            data: { requestId, agentId: agent.id, actionClass },
            subjectKey: `agent_gate:${agent.id}:${actionClass}:${fingerprint}`.slice(0, 300),
          },
        },
        actor: SYSTEM_ACTOR,
        scope,
      } as AppendInput,
      {
        streamId: streamId.agent(agent.id),
        event: {
          type: 'GatedActionRequested',
          payload: {
            requestId,
            orgId: agent.org_id,
            agentId: agent.id,
            actionClass,
            fingerprint: fingerprint.slice(0, 300),
            summary: ask.summary.slice(0, 500),
            deskItemId,
            ...(ask.projectId ? { projectId: ask.projectId } : {}),
            ...(ask.cardId ? { cardId: ask.cardId } : {}),
          },
        },
        actor: SYSTEM_ACTOR,
        scope: orgScope(agent.org_id),
      },
    ];
    await ctx.store.append(events, { tx });
    return {
      ok: false,
      message: `approval_required: ${agent.name} is set to ask before it may ${label}. A request is on the manager's desk (${ask.summary}). Do not retry in a loop: carry on with other work; once it is approved, the same command goes through.`,
    };
  });
}

/** Desk resolution of a gate item (inside the desk transaction): the request is decided; the agent's retry uses the approval. */
export async function resolveGateItemIn(
  ctx: Ctx,
  tx: Tx,
  user: { id: string },
  item: Row,
  resolution: 'approved' | 'rejected' | 'acknowledged' | 'dismissed',
): Promise<void> {
  if (resolution === 'acknowledged')
    throw badRequest('wrong_resolution', 'a gated action is approved or rejected');
  // Not the card's owner by default: the Owner and Admins, the agent's manager, or the person who set the gate decide
  // (the gate exists to keep a person in the loop that someone chose).
  const gateAgentId = (item.data as { agentId?: string } | null)?.agentId;
  const gateClass = (item.data as { actionClass?: string } | null)?.actionClass;
  const orgRole = await orgRoleOf(tx, user.id, item.org_id);
  if (orgRole !== 'owner' && orgRole !== 'admin') {
    const agent = gateAgentId
      ? await one(tx, 'SELECT manager_user_id FROM agents WHERE id=$1', [gateAgentId])
      : null;
    const gate =
      gateAgentId && gateClass
        ? await one(tx, 'SELECT set_by FROM agent_action_gates WHERE agent_id=$1 AND action_class=$2', [
            gateAgentId,
            gateClass,
          ])
        : null;
    if (agent?.manager_user_id !== user.id && gate?.set_by !== user.id)
      throw forbidden(
        'only an Owner or Admin, the agent’s manager or the person who set this gate can decide it',
      );
  }
  const requestId = (item.data as { requestId?: string } | null)?.requestId;
  if (!requestId) return;
  await ctx.store.append(
    [
      {
        streamId: streamId.agent((item.data as { agentId: string }).agentId),
        event: {
          type: 'GatedActionDecided',
          payload: {
            requestId,
            orgId: item.org_id,
            decision: resolution === 'approved' ? 'approved' : 'rejected',
            decidedBy: user.id,
            deskItemId: item.id,
          },
        },
        actor: userActor(user.id),
        scope: orgScope(item.org_id),
      },
    ],
    { tx },
  );
}
