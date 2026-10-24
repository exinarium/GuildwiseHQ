import { createHash } from 'node:crypto';
import {
  agentHandle,
  DELEGATE_GRANT_LIMITS,
  type DelegateGrantDto,
  type DelegateGrantsDto,
  type DelegateOwnerKind,
  type DelegateProfile,
  type DelegateTargetOption,
  type DelegateTargetSpec,
  type DelegationSpec,
  type DelegationStepDto,
  isKnownChoice,
  isTemplateTagged,
  type ModelChoice,
  profileOfPermissions,
  RoleDefinitionSchema,
  runtimeRoleProblem,
  type SetDelegateExclusionRequest,
  type SetDelegateGrantRequest,
  streamId,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { effectiveRegistry } from '../capabilities/registry.ts';
import { loadRole } from '../catalogue/loader.ts';
import { manageableAgent } from '../commands/agents.ts';
import { orgScope, userActor } from '../commands/common.ts';
import { canManageSession, loadSession } from '../commands/sessions.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import { runtimeProblem, runtimeReports } from './offer.ts';

/** Agents that never delegate and are never delegated to: the CEO and the DevOps engineer hold wider powers. */
const isSpecialAgent = (a: Row): boolean =>
  a.is_devops === true || a.role_key === 'ceo' || a.role_key === 'devops';

/** The raw grant rows of an owner, oldest first (a stable order, so handles stay the same). */
export async function grantRows(
  db: Queryable,
  ownerKind: DelegateOwnerKind,
  ownerId: string,
  /** Q66: also the role's grants this agent was excluded from (flagged `excluded`), for the pages; never for what is in force. */
  includeExcluded = false,
): Promise<Row[]> {
  if (ownerKind === 'agent') {
    // An agent also has the grants of its role (Q61): every agent of the role, the future hires included. A per-agent grant can
    // add targets and never take one of the role's away, so for the same target the role's grant is the one in force. An Owner or
    // Admin can exclude one agent from a target its role grants (Q66): that grant is then not this agent's (an explicit grant to the
    // agent itself for the same target stays).
    const all = await rows(
      db,
      `SELECT g.*, (g.owner_kind = 'role') AS inherited, (x.agent_id IS NOT NULL) AS excluded
         FROM delegate_grants g
         LEFT JOIN delegate_exclusions x ON x.agent_id = $1 AND g.owner_kind = 'role'
              AND x.target_kind = g.target_kind AND x.target_key = g.target_key
        WHERE (g.owner_kind='agent' AND g.owner_id=$1)
           OR (g.owner_kind='role' AND (g.org_id, g.owner_key) = (SELECT a.org_id, a.role_key FROM agents a WHERE a.id=$1))
        ORDER BY (g.owner_kind = 'role') DESC, g.granted_at, g.target_kind, g.target_key`,
      [ownerId],
    );
    const seen = new Set<string>();
    const keep = (g: Row): boolean => {
      const k = `${g.target_kind}:${g.target_key}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    };
    const inForce = all.filter((g) => g.excluded !== true).filter(keep);
    if (!includeExcluded) return inForce;
    // the excluded ones follow, for the page to show them struck out
    return [...inForce, ...all.filter((g) => g.excluded === true).filter(keep)];
  }
  return rows(
    db,
    `SELECT *, false AS inherited, false AS excluded FROM delegate_grants WHERE owner_kind=$1 AND owner_id=$2 ORDER BY granted_at, target_kind, target_key`,
    [ownerKind, ownerId],
  );
}

/**
 * The id a role's grants are kept under: derived from the organization and the role key, the same on every replay. (A UUID by
 * shape, version 5 style: the event and the table want one.)
 */
export function roleOwnerId(orgId: string, roleKey: string): string {
  const h = createHash('sha256').update(`delegate-role:${orgId}:${roleKey}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** A grant row with the handle the caller types for it. Agent handles are unique among the owner's grants. */
export async function grantsWithHandles(
  db: Queryable,
  ownerKind: DelegateOwnerKind,
  ownerId: string,
  includeExcluded = false,
): Promise<Array<{ row: Row; handle: string; agent?: Row }>> {
  const out: Array<{ row: Row; handle: string; agent?: Row }> = [];
  const taken = new Set<string>();
  for (const row of await grantRows(db, ownerKind, ownerId, includeExcluded)) {
    if (row.target_kind === 'persona') {
      out.push({ row, handle: row.target_key });
      continue;
    }
    const agent = await one(db, 'SELECT * FROM agents WHERE id=$1 AND org_id=$2', [
      row.target_key,
      row.org_id,
    ]);
    const handle = agentHandle(agent?.name ?? 'agent', taken, row.target_key);
    // an excluded grant is shown, not in force: it must not change the handle of one that is
    if (row.excluded !== true) taken.add(handle);
    out.push({ row, handle, ...(agent ? { agent } : {}) });
  }
  return out;
}

/** What a hired agent runs on and may do as a delegate: the server's word, from the agent's row and its role. */
async function agentTarget(
  db: Queryable,
  agent: Row,
): Promise<{
  model: ModelChoice;
  profile: DelegateProfile;
  instructions: string;
  permissions: Row['permissions'];
}> {
  const role = await loadRole(db, agent.org_id, agent.role_key, agent.role_version);
  const def = role ? RoleDefinitionSchema.safeParse(role.definition) : undefined;
  const text = def?.success
    ? [
        `# You are ${agent.name}, ${def.data.name}`,
        def.data.instructions,
        ...def.data.coreRules.map((r) => `- ${r}`),
      ].join('\n\n')
    : `# You are ${agent.name}`;
  return {
    model: { runtime: agent.runtime, model: agent.model },
    profile: profileOfPermissions(agent.permissions ?? { allowedTools: [] }),
    instructions: text.slice(0, 40_000),
    permissions: agent.permissions,
  };
}

/** Why a granted agent cannot be a delegate now (retired, special), or null. */
function agentProblem(agent: Row | undefined): string | null {
  if (!agent) return 'this agent no longer exists';
  if (agent.status === 'retired') return 'this agent is retired';
  if (isSpecialAgent(agent)) return 'this agent cannot be a delegate';
  return null;
}

/**
 * The targets an owner was granted, as the runner is told at the start of a shift, chat or session turn. Undefined when there
 * is none (the runner then offers no delegation at all). The server checks every call again in `delegate.begin`.
 */
export async function delegationSpecFor(
  db: Queryable,
  ownerKind: DelegateOwnerKind,
  ownerId: string,
): Promise<DelegationSpec | undefined> {
  const grants = await grantsWithHandles(db, ownerKind, ownerId);
  if (grants.length === 0) return undefined;
  const reg = new Map<string, { name: string; description: string }>();
  const orgId = grants[0]?.row.org_id as string;
  for (const i of (await effectiveRegistry(db, orgId, { kind: 'persona' })).items)
    reg.set(i.key, { name: i.name, description: i.description });
  const targets: DelegateTargetSpec[] = [];
  for (const g of grants) {
    const common = {
      handle: g.handle,
      key: g.row.target_key as string,
      maxCalls: g.row.max_calls as number,
      timeoutSec: g.row.timeout_sec as number,
      maxProfile: (g.row.max_profile ?? null) as DelegateProfile | null,
      ...(g.row.model_runtime && g.row.model_name
        ? { modelOverride: { runtime: g.row.model_runtime as string, model: g.row.model_name as string } }
        : {}),
    };
    if (g.row.target_kind === 'persona') {
      const p = reg.get(g.row.target_key);
      targets.push({
        kind: 'persona',
        ...common,
        name: p?.name ?? g.row.target_key,
        description: p?.description ?? '',
      });
      continue;
    }
    if (agentProblem(g.agent) || !g.agent) continue;
    const t = await agentTarget(db, g.agent);
    targets.push({
      kind: 'agent',
      ...common,
      name: g.agent.name,
      description: `${g.agent.name} (${g.agent.role_key})`,
      runtime: t.model.runtime,
      model: t.model.model,
      profile: t.profile,
      instructions: t.instructions,
      permissions: t.permissions,
    });
  }
  return targets.length ? { targets } : undefined;
}

// ------------------------------------------------------------------------------------------------------ the pages

async function dtoFor(
  ctx: Ctx,
  ownerKind: DelegateOwnerKind,
  ownerId: string,
  canManage: boolean,
  userId: string,
  workstationId: string | null,
  orgId: string,
  roleKey: string | null = null,
  canExclude = false,
): Promise<DelegateGrantsDto> {
  const grants = await grantsWithHandles(ctx.pool, ownerKind, ownerId, true);
  const reports = await runtimeReports(ctx.pool, workstationId);
  const personas = new Map(
    (await effectiveRegistry(ctx.pool, orgId, { kind: 'persona', userId })).items.map((i) => [i.key, i]),
  );
  const out: DelegateGrantDto[] = [];
  for (const g of grants) {
    const base = {
      targetKind: g.row.target_kind,
      targetKey: g.row.target_key,
      handle: g.handle,
      maxCalls: g.row.max_calls,
      timeoutSec: g.row.timeout_sec,
      maxProfile: g.row.max_profile ?? null,
      grantedAt: iso(g.row.granted_at) as string,
      grantedBy: g.row.granted_by ?? null,
      modelOverride:
        g.row.model_runtime && g.row.model_name ? `${g.row.model_runtime}:${g.row.model_name}` : null,
      inherited: g.row.inherited === true,
      excluded: g.row.excluded === true,
    };
    if (g.row.target_kind === 'persona') {
      const p = personas.get(g.row.target_key);
      out.push({
        ...base,
        targetName: p?.name ?? g.row.target_key,
        profile: null,
        model: null,
        problem: p
          ? p.usable === false
            ? (p.unusableReason ?? 'this persona is not usable yet')
            : null
          : 'this persona is not in the registry',
      });
      continue;
    }
    const problem = agentProblem(g.agent);
    const model = g.agent ? `${g.agent.runtime}:${g.agent.model}` : null;
    out.push({
      ...base,
      targetName: g.agent?.name ?? 'a removed agent',
      profile: g.agent ? profileOfPermissions(g.agent.permissions ?? { allowedTools: [] }) : null,
      model,
      problem:
        problem ??
        (g.agent && workstationId
          ? runtimeProblem(reports, { runtime: g.agent.runtime, model: g.agent.model }, orgId)
          : null),
    });
  }
  return { ownerKind, ownerId, canManage, canExclude, roleKey, grants: out };
}

async function agentOwner(
  db: Queryable,
  user: AuthSession['user'],
  agentId: string,
): Promise<{ agent: Row; canManage: boolean }> {
  const a = await one(db, 'SELECT * FROM agents WHERE id=$1', [agentId]);
  if (!a) throw notFound('agent not found');
  const role = await orgRoleOf(db, user.id, a.org_id);
  if (!role) throw notFound('agent not found');
  return { agent: a, canManage: role === 'owner' || role === 'admin' || a.manager_user_id === user.id };
}

export async function getAgentDelegateGrants(
  ctx: Ctx,
  user: AuthSession['user'],
  agentId: string,
): Promise<DelegateGrantsDto> {
  const { agent, canManage } = await agentOwner(ctx.pool, user, agentId);
  const orgRole = await orgRoleOf(ctx.pool, user.id, agent.org_id);
  return dtoFor(
    ctx,
    'agent',
    agentId,
    canManage,
    user.id,
    agent.workstation_id ?? null,
    agent.org_id,
    agent.role_key ?? null,
    orgRole === 'owner' || orgRole === 'admin',
  );
}

export async function getSessionDelegateGrants(
  ctx: Ctx,
  user: AuthSession['user'],
  threadId: string,
): Promise<DelegateGrantsDto> {
  const t = await loadSession(ctx.pool, user.id, threadId);
  return dtoFor(
    ctx,
    'session',
    threadId,
    await canManageSession(ctx.pool, user.id, t),
    user.id,
    t.workstation_id ?? null,
    t.org_id,
  );
}

/** A target the owner may be given: checked on the way in, so a grant never names something the granter cannot see. */
async function assertGrantable(
  db: Queryable,
  user: AuthSession['user'],
  orgId: string,
  ownerKind: DelegateOwnerKind,
  ownerId: string,
  req: SetDelegateGrantRequest,
  roleKey?: string,
): Promise<void> {
  if (req.targetKind === 'persona') {
    const reg = await effectiveRegistry(db, orgId, { kind: 'persona', usableOnly: true, userId: user.id });
    if (!reg.items.some((i) => i.key === req.targetKey))
      throw badRequest(
        'unknown_persona',
        `"${req.targetKey}" is not a persona you can grant (it must be approved and visible to you)`,
      );
    await assertGrantModel(db, orgId, ownerKind, ownerId, req, undefined, roleKey);
    return;
  }
  const t = await one(db, 'SELECT * FROM agents WHERE id=$1 AND org_id=$2', [req.targetKey, orgId]);
  const problem = agentProblem(t);
  if (problem || !t) throw badRequest('unknown_agent', problem ?? 'unknown agent');
  if (ownerKind === 'agent' && t.id === ownerId)
    throw badRequest('self_delegation', 'an agent cannot delegate to itself');
  // a role's grant would reach the target itself too: the target may not be an agent of that role
  if (ownerKind === 'role' && roleKey && t.role_key === roleKey)
    throw badRequest('self_delegation', 'a role cannot delegate to its own agents');
  await assertGrantModel(db, orgId, ownerKind, ownerId, req, t, roleKey);
}

/**
 * The model a grant sets for its owner (Q62) must be one the product knows, take the target (the same role check the runner
 * applies, `runtimeRoleProblem`) and be offered where the owner works: the workstation of the agent or of the session; for a role,
 * the workstations of its agents. The caller never chooses (`--model` stays refused): this is the grant maker's choice.
 */
async function assertGrantModel(
  db: Queryable,
  orgId: string,
  ownerKind: DelegateOwnerKind,
  ownerId: string,
  req: SetDelegateGrantRequest,
  target: Row | undefined,
  roleKey?: string,
): Promise<void> {
  const model = req.grant?.model;
  if (!model) return;
  if (!isKnownChoice(model))
    throw badRequest(
      'unknown_model',
      `the model "${model.runtime}:${model.model}" is not one this product offers`,
    );
  // the target must be able to run on the runtime with the tools it will have (a working child on Codex, say, needs a shell)
  const profile: DelegateProfile =
    req.grant?.maxProfile ??
    (target ? profileOfPermissions(target.permissions ?? { allowedTools: [] }) : 'read_only');
  const tools =
    profile === 'shell' ? ['read', 'edit', 'shell'] : profile === 'edit' ? ['read', 'edit'] : ['read'];
  const bad = runtimeRoleProblem(model.runtime, {
    roleKey: target ? String(target.role_key) : 'delegate',
    isDevops: false,
    permissions: {
      allowedTools: tools as never,
      writableGlobs: target?.permissions?.writableGlobs ?? null,
      browser: false,
    },
  });
  if (bad) throw badRequest('model_not_for_target', `${model.runtime}:${model.model}: ${bad}`);
  // offered where the owner works
  let stations: Array<string | null> = [];
  if (ownerKind === 'agent')
    stations = [
      (await one(db, 'SELECT workstation_id FROM agents WHERE id=$1', [ownerId]))?.workstation_id ?? null,
    ];
  else if (ownerKind === 'session')
    stations = [
      (await one(db, 'SELECT workstation_id FROM threads WHERE id=$1', [ownerId]))?.workstation_id ?? null,
    ];
  else
    stations = (
      await rows(
        db,
        `SELECT DISTINCT workstation_id FROM agents WHERE org_id=$1 AND role_key=$2 AND status <> 'retired'`,
        [orgId, roleKey ?? ''],
      )
    ).map((r) => r.workstation_id as string | null);
  for (const ws of stations) {
    if (!ws) continue;
    const problem = runtimeProblem(await runtimeReports(db, ws), model, orgId);
    if (problem) throw badRequest('runtime_unavailable', problem);
  }
}

async function setGrant(
  ctx: Ctx,
  user: AuthSession['user'],
  ownerKind: DelegateOwnerKind,
  ownerId: string,
  orgId: string,
  req: SetDelegateGrantRequest,
  tx: Tx,
  roleKey?: string,
): Promise<void> {
  const had = await one(
    tx,
    'SELECT 1 FROM delegate_grants WHERE owner_kind=$1 AND owner_id=$2 AND target_kind=$3 AND target_key=$4',
    [ownerKind, ownerId, req.targetKind, req.targetKey],
  );
  if (req.grant === null && !had) {
    // a target the agent has only through its role cannot be taken away on the agent (Q61): it is changed on the role
    if (ownerKind === 'agent') {
      const viaRole = await one(
        tx,
        `SELECT g.owner_key FROM delegate_grants g JOIN agents a ON a.id=$1
          WHERE g.owner_kind='role' AND g.org_id=a.org_id AND g.owner_key=a.role_key AND g.target_kind=$2 AND g.target_key=$3`,
        [ownerId, req.targetKind, req.targetKey],
      );
      if (viaRole)
        throw conflict(
          'granted_by_role',
          `This target comes from the role "${viaRole.owner_key}": every agent of the role has it. Change it on the role, or have an Owner or Admin exclude this agent from it.`,
        );
    }
    return;
  }
  if (req.grant !== null) {
    await assertGrantable(tx, user, orgId, ownerKind, ownerId, req, roleKey);
    if (!had) {
      const n = await one(
        tx,
        'SELECT count(*)::int AS n FROM delegate_grants WHERE owner_kind=$1 AND owner_id=$2',
        [ownerKind, ownerId],
      );
      if ((n?.n ?? 0) >= DELEGATE_GRANT_LIMITS.maxGrantsPerOwner)
        throw badRequest(
          'too_many_grants',
          `at most ${DELEGATE_GRANT_LIMITS.maxGrantsPerOwner} delegation targets per ${ownerKind}`,
        );
    }
  }
  await ctx.store.append(
    [
      {
        streamId:
          ownerKind === 'agent'
            ? streamId.agent(ownerId)
            : ownerKind === 'role'
              ? streamId.org(orgId)
              : streamId.thread(ownerId),
        event: {
          type: 'DelegateGrantChanged',
          payload: {
            ownerKind,
            ownerId,
            ...(ownerKind === 'session' ? { threadId: ownerId } : {}),
            ...(ownerKind === 'role' && roleKey ? { roleKey } : {}),
            orgId,
            targetKind: req.targetKind,
            targetKey: req.targetKey,
            granted: req.grant !== null,
            ...(req.grant
              ? {
                  maxCalls: req.grant.maxCalls,
                  timeoutSec: req.grant.timeoutSec,
                  maxProfile: req.grant.maxProfile,
                  model: req.grant.model,
                }
              : {}),
            changedBy: user.id,
          },
        },
        actor: userActor(user.id),
        scope: orgScope(orgId),
      },
    ],
    { tx },
  );
}

/**
 * Owners, Admins and the agent's manager (the HR rule) grant or revoke an agent's delegation targets. Off by default; an event
 * per change is the audit trail.
 */
export async function setAgentDelegateGrant(
  ctx: Ctx,
  user: AuthSession['user'],
  agentId: string,
  req: SetDelegateGrantRequest,
): Promise<DelegateGrantsDto> {
  await withAppendTx(ctx.pool, async (tx) => {
    const a = await manageableAgent(tx, user, agentId);
    if (a.status === 'retired') throw conflict('agent_retired', 'agent is retired');
    if (isSpecialAgent(a)) throw badRequest('delegation_unavailable', 'this agent cannot delegate');
    await setGrant(ctx, user, 'agent', agentId, a.org_id, req, tx);
  });
  return getAgentDelegateGrants(ctx, user, agentId);
}

/**
 * Q66: an Owner or Admin excludes ONE agent from a target its role grants (`excluded: true`), or takes the exclusion back. The
 * role's grant is untouched and every other agent of the role keeps it. Only a target the role really grants can be excluded.
 * The event is the audit trail.
 */
export async function setAgentDelegateExclusion(
  ctx: Ctx,
  user: AuthSession['user'],
  agentId: string,
  req: SetDelegateExclusionRequest,
): Promise<DelegateGrantsDto> {
  await withAppendTx(ctx.pool, async (tx) => {
    const a = await one(tx, 'SELECT * FROM agents WHERE id=$1', [agentId]);
    if (!a) throw notFound('agent not found');
    const role = await orgRoleOf(tx, user.id, a.org_id);
    if (!role) throw notFound('agent not found');
    if (role !== 'owner' && role !== 'admin')
      throw forbidden('only an Owner or Admin can exclude an agent from a target its role grants');
    if (a.status === 'retired') throw conflict('agent_retired', 'agent is retired');
    const viaRole = await one(
      tx,
      `SELECT 1 FROM delegate_grants WHERE owner_kind='role' AND org_id=$1 AND owner_key=$2 AND target_kind=$3 AND target_key=$4`,
      [a.org_id, a.role_key, req.targetKind, req.targetKey],
    );
    const had = await one(
      tx,
      'SELECT 1 FROM delegate_exclusions WHERE agent_id=$1 AND target_kind=$2 AND target_key=$3',
      [agentId, req.targetKind, req.targetKey],
    );
    if (req.excluded && !viaRole)
      throw badRequest(
        'not_granted_by_role',
        `The role "${a.role_key}" does not grant this target: there is nothing to exclude this agent from`,
      );
    if (req.excluded === !!had) return; // already so: nothing to record
    await ctx.store.append(
      [
        {
          streamId: streamId.agent(agentId),
          event: {
            type: 'DelegateExclusionChanged',
            payload: {
              agentId,
              orgId: a.org_id,
              targetKind: req.targetKind,
              targetKey: req.targetKey,
              excluded: req.excluded,
              changedBy: user.id,
            },
          },
          actor: userActor(user.id),
          scope: orgScope(a.org_id),
        },
      ],
      { tx },
    );
  });
  return getAgentDelegateGrants(ctx, user, agentId);
}

/** The creator of a session (an Owner or Admin in it may override) grants its facilitator and Chair their targets. */
export async function setSessionDelegateGrant(
  ctx: Ctx,
  user: AuthSession['user'],
  threadId: string,
  req: SetDelegateGrantRequest,
): Promise<DelegateGrantsDto> {
  await withAppendTx(ctx.pool, async (tx) => {
    const t = await loadSession(tx, user.id, threadId, true);
    if (!(await canManageSession(tx, user.id, t)))
      throw forbidden('only the session creator, an Owner or an Admin can change its delegation');
    if ((t.session_config as { archived?: boolean } | null)?.archived)
      throw conflict('session_archived', 'This session is archived and read-only.');
    await setGrant(ctx, user, 'session', threadId, t.org_id, req, tx);
  });
  return getSessionDelegateGrants(ctx, user, threadId);
}

/** What a grant picker offers: the usable personas the viewer can see and the org's other agents, each marked when granted. */
export async function delegateTargetOptions(
  ctx: Ctx,
  user: AuthSession['user'],
  ownerKind: DelegateOwnerKind,
  ownerId: string,
): Promise<DelegateTargetOption[]> {
  const orgId =
    ownerKind === 'agent'
      ? (await agentOwner(ctx.pool, user, ownerId)).agent.org_id
      : (await loadSession(ctx.pool, user.id, ownerId)).org_id;
  const granted = new Set(
    (await grantRows(ctx.pool, ownerKind, ownerId)).map((g) => `${g.target_kind}:${g.target_key}`),
  );
  return targetOptions(ctx, user, orgId, granted, {
    excludeAgentId: ownerKind === 'agent' ? ownerId : undefined,
  });
}

async function targetOptions(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  granted: Set<string>,
  except: { excludeAgentId?: string | undefined; excludeRoleKey?: string | undefined },
): Promise<DelegateTargetOption[]> {
  const out: DelegateTargetOption[] = [];
  const reg = await effectiveRegistry(ctx.pool, orgId, {
    kind: 'persona',
    usableOnly: true,
    userId: user.id,
  });
  for (const i of reg.items) {
    if (isTemplateTagged(i.tags)) continue;
    out.push({
      targetKind: 'persona',
      targetKey: i.key,
      name: i.name,
      description: i.description,
      model: null,
      profile: null,
      granted: granted.has(`persona:${i.key}`),
    });
  }
  const agents = await rows(
    ctx.pool,
    `SELECT * FROM agents WHERE org_id=$1 AND status <> 'retired' AND NOT is_devops AND role_key NOT IN ('ceo','devops')
        AND id <> $2 AND role_key <> $3 ORDER BY name`,
    [orgId, except.excludeAgentId ?? '00000000-0000-0000-0000-000000000000', except.excludeRoleKey ?? ''],
  );
  for (const a of agents)
    out.push({
      targetKind: 'agent',
      targetKey: a.id,
      name: a.name,
      description: `${a.role_key}, ${a.runtime}:${a.model}`,
      model: `${a.runtime}:${a.model}`,
      profile: profileOfPermissions(a.permissions ?? { allowedTools: [] }),
      granted: granted.has(`agent:${a.id}`),
    });
  return out;
}

// ------------------------------------------------------------------------------------------------------ role grants (Q61)

/** A role the grants can be made on: any role of the organization except the CEO and the DevOps engineer, which never delegate. */
async function assertRole(db: Queryable, orgId: string, roleKey: string): Promise<void> {
  if (roleKey === 'ceo' || roleKey === 'devops')
    throw badRequest('delegation_unavailable', 'this role cannot delegate');
  const role = await loadRole(db, orgId, roleKey);
  if (!role) throw notFound('role not found');
}

/** The delegation targets of a role: every agent of the role has them, the agents hired later too. Owners and Admins only. */
export async function getRoleDelegateGrants(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  roleKey: string,
): Promise<DelegateGrantsDto> {
  await assertRole(ctx.pool, orgId, roleKey);
  return dtoFor(ctx, 'role', roleOwnerId(orgId, roleKey), true, user.id, null, orgId, roleKey);
}

/**
 * Owners and Admins grant or revoke a role's delegation targets (Q61): the same rules as an agent's grants, applied to every agent
 * of the role. Each change is an event (`DelegateGrantChanged` with the role key): the audit trail.
 */
export async function setRoleDelegateGrant(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  roleKey: string,
  req: SetDelegateGrantRequest,
): Promise<DelegateGrantsDto> {
  await withAppendTx(ctx.pool, async (tx) => {
    await assertRole(tx, orgId, roleKey);
    await setGrant(ctx, user, 'role', roleOwnerId(orgId, roleKey), orgId, req, tx, roleKey);
  });
  return getRoleDelegateGrants(ctx, user, orgId, roleKey);
}

export async function roleDelegateTargetOptions(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  roleKey: string,
): Promise<DelegateTargetOption[]> {
  await assertRole(ctx.pool, orgId, roleKey);
  const granted = new Set(
    (await grantRows(ctx.pool, 'role', roleOwnerId(orgId, roleKey))).map(
      (g) => `${g.target_kind}:${g.target_key}`,
    ),
  );
  return targetOptions(ctx, user, orgId, granted, { excludeRoleKey: roleKey });
}

// ------------------------------------------------------------------------------------------------------ sub-steps

/** The delegations of a card or a session as sub-steps: target, model, tool profile, duration, cost and the result summary. */
export async function delegationSteps(
  db: Queryable,
  by: { cardId: string } | { threadId: string },
): Promise<DelegationStepDto[]> {
  const r = await rows(
    db,
    `SELECT shift_id, parent_id, model, cost_usd_micros, cost_unknown, ended_at, delegate_target, delegate_target_name,
            delegate_target_kind, delegate_profile, delegate_outcome, delegate_duration_ms, delegate_summary, delegate_native, delegate_narrowed_from
       FROM shift_costs
      WHERE kind='delegate' AND ${'cardId' in by ? 'card_id' : 'delegate_thread_id'} = $1
      ORDER BY ended_at, shift_id LIMIT 200`,
    ['cardId' in by ? by.cardId : by.threadId],
  );
  return r.map((x) => ({
    delegateId: x.shift_id,
    callerId: x.parent_id,
    target: x.delegate_target ?? 'delegate',
    targetName: x.delegate_target_name ?? x.delegate_target ?? 'delegate',
    targetKind: x.delegate_target_kind ?? null,
    model: x.model,
    profile: x.delegate_profile ?? null,
    outcome: x.delegate_outcome ?? 'ok',
    durationMs: x.delegate_duration_ms ?? null,
    costUsd: x.cost_unknown ? null : Number(x.cost_usd_micros) / 1_000_000,
    costUnknown: x.cost_unknown === true,
    summary: x.delegate_summary ?? null,
    native: x.delegate_native === true,
    narrowedFrom: x.delegate_narrowed_from ?? null,
    at: iso(x.ended_at) as string,
  }));
}
