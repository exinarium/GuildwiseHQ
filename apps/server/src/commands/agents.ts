import { randomUUID } from 'node:crypto';
import {
  type AgentChanges,
  canHireAgent,
  canManageAgent,
  type HireAgentRequest,
  streamId,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { projectRole } from '../authz/scope.ts';
import { loadRole } from '../catalogue/loader.ts';
import type { Ctx } from '../context.ts';
import { one, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { cardMessage, orgScope, projectScope, userActor } from './common.ts';

const NAMES: Record<string, string[]> = {
  default: [
    'Ada',
    'Alan',
    'Grace',
    'Linus',
    'Margaret',
    'Dennis',
    'Barbara',
    'Ken',
    'Radia',
    'Edsger',
    'Hedy',
    'Tim',
    'Donald',
    'Frances',
    'Guido',
    'Bjarne',
    'Katherine',
    'Claude',
    'Vint',
    'Sophie',
    'Niklaus',
    'Annie',
    'Brian',
    'Lynn',
    'Leslie',
    'Shafi',
    'Jean',
    'Mary',
    'Anita',
    'Whitfield',
    'Karen',
    'Yukihiro',
    'Rob',
    'Evelyn',
    'Joan',
    'Seymour',
    'Marissa',
    'Fernando',
    'Betty',
    'Ivan',
  ],
  birds: [
    'Heron',
    'Kestrel',
    'Wren',
    'Osprey',
    'Finch',
    'Plover',
    'Egret',
    'Swift',
    'Lark',
    'Merlin',
    'Tern',
    'Robin',
    'Ibis',
    'Crane',
    'Sparrow',
    'Falcon',
    'Curlew',
    'Magpie',
    'Starling',
    'Nuthatch',
  ],
  trees: [
    'Alder',
    'Birch',
    'Cedar',
    'Elm',
    'Hazel',
    'Juniper',
    'Larch',
    'Maple',
    'Oak',
    'Poplar',
    'Rowan',
    'Spruce',
    'Willow',
    'Yew',
    'Aspen',
    'Beech',
    'Cypress',
    'Hawthorn',
    'Linden',
    'Sycamore',
  ],
};

/** Names not used in the org (retired agents' names count as used, they are never reused). */
export async function suggestNames(
  ctx: Ctx,
  orgId: string,
  theme: string | undefined,
  count: number,
): Promise<string[]> {
  const used = new Set(
    (await rows<{ n: string }>(ctx.pool, 'SELECT lower(name) AS n FROM agents WHERE org_id=$1', [orgId])).map(
      (r) => r.n,
    ),
  );
  const pool = NAMES[(theme ?? 'default').toLowerCase()] ?? NAMES.default ?? [];
  const out = pool.filter((n) => !used.has(n.toLowerCase())).slice(0, count);
  // Out of fresh names: derive numbered variants.
  for (let i = 2; out.length < count; i++) {
    for (const base of pool) {
      const candidate = `${base} ${i}`;
      if (!used.has(candidate.toLowerCase())) out.push(candidate);
      if (out.length >= count) break;
    }
  }
  return out;
}

async function enforceHireCap(ctx: Ctx, tx: Tx, orgId: string, roleKey: string) {
  if (!ctx.config.firstRunHireCap) return;
  const r = await one(
    tx,
    `SELECT count(*)::int AS n FROM agents WHERE org_id=$1 AND role_key=$2 AND status IN ('active','needs_rehome') AND NOT is_devops`,
    [orgId, roleKey],
  );
  const cap = roleKey === 'builder' ? 2 : 1;
  if (Number(r?.n) >= cap) {
    throw conflict(
      'hire_cap_reached',
      `first-run cap reached: at most ${cap} active ${roleKey}${cap > 1 ? 's' : ''} per organization`,
      { roleKey, cap },
    );
  }
}

export async function hireAgent(ctx: Ctx, user: AuthSession['user'], req: HireAgentRequest): Promise<string> {
  const agentId = randomUUID();
  await withAppendTx(ctx.pool, async (tx) => {
    const ws = await one(tx, `SELECT id FROM workstations WHERE id=$1 AND user_id=$2 AND status='active'`, [
      req.workstationId,
      user.id,
    ]);
    if (!ws) throw notFound('workstation not found');
    let orgId = user.id;
    let role: Awaited<ReturnType<typeof projectRole>> = null;
    if (req.projectId) {
      const p = await one(tx, 'SELECT org_id, status FROM projects WHERE id=$1', [req.projectId]);
      role = await projectRole(tx, user.id, req.projectId);
      if (!p || !role) throw notFound('project not found');
      orgId = p.org_id;
    }
    if (!canHireAgent({ userId: user.id, orgId, projectRole: role, projectScoped: !!req.projectId })) {
      throw forbidden('you cannot hire agents here');
    }
    const roleDef = await loadRole(tx, orgId, req.roleKey);
    if (!roleDef) throw badRequest('unknown_role', `role '${req.roleKey}' does not exist`);
    if (roleDef.definition.key === 'devops')
      throw badRequest('invalid_role', 'DevOps engineers are hired automatically per workstation');
    if (!roleDef.definition.seniorityLevels.includes(req.seniority)) {
      throw badRequest(
        'invalid_seniority',
        `${roleDef.definition.name} is available as: ${roleDef.definition.seniorityLevels.join(', ')}`,
      );
    }
    if (await one(tx, 'SELECT 1 FROM agents WHERE org_id=$1 AND lower(name)=lower($2)', [orgId, req.name])) {
      throw conflict(
        'name_taken',
        `the name '${req.name}' is already used in this organization (retired agents keep their names)`,
      );
    }
    await enforceHireCap(ctx, tx, orgId, req.roleKey);
    const dm = roleDef.definition.defaultModel;
    await ctx.store.append(
      [
        {
          streamId: streamId.agent(agentId),
          event: {
            type: 'AgentHired',
            payload: {
              agentId,
              orgId,
              projectId: req.projectId,
              hiredByUserId: user.id,
              workstationId: req.workstationId,
              name: req.name,
              roleKey: roleDef.key,
              roleVersion: roleDef.version,
              seniority: req.seniority,
              runtime: req.runtime ?? dm.runtime,
              model: req.model ?? dm.model,
              effort: req.effort ?? dm.effort,
              skills: req.skills ?? roleDef.definition.skills,
              permissions: roleDef.definition.permissions,
              capacity: req.capacity,
              isDevops: false,
            },
          },
          actor: userActor(user.id),
          scope: req.projectId ? projectScope(orgId, req.projectId) : orgScope(orgId),
        },
      ],
      { tx },
    );
  });
  return agentId;
}

async function manageableAgent(tx: Tx, user: AuthSession['user'], agentId: string): Promise<Row> {
  const a = await one(
    tx,
    `SELECT a.* FROM agents a WHERE a.id=$1 AND (
        a.org_id = $2 OR a.manager_user_id = $2
        OR (a.project_id IS NOT NULL AND EXISTS (SELECT 1 FROM project_members pm
              WHERE pm.project_id = a.project_id AND pm.user_id = $2 AND pm.status='active')))`,
    [agentId, user.id],
  );
  if (!a) throw notFound('agent not found');
  if (!canManageAgent({ userId: user.id, orgId: a.org_id, managerUserId: a.manager_user_id })) {
    throw forbidden('only the organization owner or the hiring manager can do this');
  }
  return a;
}

const agentScope = (a: Row) => (a.project_id ? projectScope(a.org_id, a.project_id) : orgScope(a.org_id));

export async function patchAgent(
  ctx: Ctx,
  user: AuthSession['user'],
  agentId: string,
  changes: AgentChanges,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const a = await manageableAgent(tx, user, agentId);
    if (a.status === 'retired') throw conflict('agent_retired', 'agent is retired');
    const next: AgentChanges = { ...changes };
    if (changes.roleKey && changes.roleKey !== a.role_key) {
      const role = await loadRole(tx, a.org_id, changes.roleKey);
      if (!role) throw badRequest('unknown_role', `role '${changes.roleKey}' does not exist`);
      next.roleVersion = role.version;
    }
    await ctx.store.append(
      [
        {
          streamId: streamId.agent(agentId),
          event: { type: 'AgentChanged', payload: { agentId, changes: next } },
          actor: userActor(user.id),
          scope: agentScope(a),
        },
      ],
      { tx },
    );
  });
}

/** Releases claimed cards (last handoff attached), retires the agent and queues `agent.wipe` on its workstation. */
export async function fireAgent(
  ctx: Ctx,
  user: AuthSession['user'],
  agentId: string,
): Promise<{ releasedCardIds: string[] }> {
  return withAppendTx(ctx.pool, async (tx) => {
    const a = await manageableAgent(tx, user, agentId);
    if (a.status === 'retired') throw conflict('agent_retired', 'agent is already retired');
    const cards = await rows(
      tx,
      `SELECT c.*, (SELECT h.id FROM card_handoffs h WHERE h.card_id = c.id ORDER BY h.created_at DESC, h.event_seq DESC LIMIT 1) AS last_handoff_id
         FROM cards c WHERE c.claimed_by_agent_id=$1 AND c.claim_id IS NOT NULL`,
      [agentId],
    );
    const events: AppendInput[] = [];
    for (const c of cards) {
      events.push({
        streamId: streamId.card(c.id),
        event: {
          type: 'ClaimReleased',
          payload: {
            cardId: c.id,
            claimId: c.claim_id,
            agentId,
            reason: 'agent_retired',
            lastHandoffId: c.last_handoff_id ?? undefined,
          },
        },
        actor: userActor(user.id),
        scope: projectScope(c.org_id, c.project_id),
      });
      events.push(
        cardMessage(
          c,
          { kind: 'system' },
          'system',
          `${a.name} was let go; the card is back in the queue with the last handoff attached.`,
        ),
      );
    }
    events.push({
      streamId: streamId.agent(agentId),
      event: {
        type: 'AgentRetired',
        payload: { agentId, by: user.id, releasedCardIds: cards.map((c) => c.id) },
      },
      actor: userActor(user.id),
      scope: agentScope(a),
    });
    await ctx.store.append(events, { tx });
    if (a.workstation_id) await enqueueRunnerCommand(tx, a.workstation_id, 'agent.wipe', { agentId });
    return { releasedCardIds: cards.map((c) => c.id as string) };
  });
}
