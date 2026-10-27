import { randomUUID } from 'node:crypto';
import {
  type AgentChanges,
  type AgentPermissions,
  canHireAgentInOrg,
  canManageAgentInOrg,
  canWidenPermissions,
  checkPermissions,
  claudeBackendRoleProblem,
  DEFAULT_AVATAR_STYLE,
  DEVOPS_ROLE_KEY,
  DIRECT_RUNTIME,
  type HireAgentRequest,
  isOrgManager,
  type PackProvenance,
  RUNTIME_GUARANTEES,
  randomAvatarSeed,
  runtimeRoleProblem,
  streamId,
  type UnsandboxedAck,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { projectRole } from '../authz/scope.ts';
import { qualifiedSkillKeys } from '../capabilities/agent-skills.ts';
import { isOthersPrivateRole, loadRole } from '../catalogue/loader.ts';
import type { Ctx } from '../context.ts';
import { one, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { assertWithinLimit } from '../orgs/limits.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { cardMessage, orgScope, projectScope, userActor } from './common.ts';
import { mcpServerCandidates } from './mcp-servers.ts';

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
  rivers: [
    'Danube',
    'Nile',
    'Orinoco',
    'Volga',
    'Yukon',
    'Tigris',
    'Zambezi',
    'Rhine',
    'Loire',
    'Mekong',
    'Indus',
    'Tagus',
    'Elbe',
    'Seine',
    'Limpopo',
    'Congo',
    'Ganges',
    'Thames',
    'Murray',
    'Niger',
  ],
  planets: [
    'Mercury',
    'Venus',
    'Mars',
    'Jupiter',
    'Saturn',
    'Neptune',
    'Titan',
    'Europa',
    'Callisto',
    'Triton',
    'Io',
    'Ganymede',
    'Rhea',
    'Oberon',
    'Miranda',
    'Ceres',
    'Phobos',
    'Enceladus',
    'Iapetus',
    'Charon',
  ],
};

/** Names not used in the org (retired agents' names count as used, they are never reused). */
export async function suggestNames(
  ctx: Pick<Ctx, 'pool'>,
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

/** Roles a role-less check still knows to be refused (the DevOps engineer, the CEO): no permissions needed. */
const NO_SHELL_NEEDED = { allowedTools: ['shell'], writableGlobs: null, browser: false };

/**
 * Throws `runtime_not_for_role` when this role cannot run on this runtime (or on a Claude Code backend model): the one rule hiring,
 * moving an agent, re-homing and the CEO's raise-model action share. A runtime without restrictions (Claude Code, the mock) passes.
 */
export function assertRuntimeFitsRole(
  runtimeId: string,
  role: { roleKey: string; isDevops?: boolean; permissions?: AgentPermissions; model?: string },
): void {
  const g = RUNTIME_GUARANTEES[runtimeId];
  if (g) {
    const refusedWithoutPermissions = role.isDevops || role.roleKey === 'devops' || role.roleKey === 'ceo';
    const problem = role.permissions
      ? runtimeRoleProblem(runtimeId, { ...role, permissions: role.permissions })
      : refusedWithoutPermissions
        ? runtimeRoleProblem(runtimeId, { ...role, permissions: NO_SHELL_NEEDED })
        : null;
    if (problem) throw badRequest('runtime_not_for_role', `${g.label} cannot run this agent: ${problem}`);
  }
  if (runtimeId === 'claude-code' && role.model) {
    const problem = claudeBackendRoleProblem(role.model, role);
    if (problem) throw badRequest('runtime_not_for_role', `this model cannot run this agent: ${problem}`);
  }
}

/**
 * A workstation's runtime may only take an agent when it can run one: `unavailable` is refused with the runner's reason;
 * `unsandboxed` needs the caller's explicit acknowledgement, which is returned for the event (who and when).
 */
export async function sandboxGate(
  ctx: Ctx,
  tx: Tx,
  userId: string,
  workstationId: string,
  runtimeId: string,
  acknowledged: boolean | undefined,
  /**
   * The agent's role (and model), when known: a CLI harness runtime refuses the roles its sandbox cannot confine
   * (`runtimeRoleProblem`), and a Bedrock, Vertex or gateway model the roles that work with the owner's own login.
   */
  role?: { roleKey: string; isDevops?: boolean; permissions?: AgentPermissions; model?: string },
): Promise<UnsandboxedAck | undefined> {
  // Agents work cards and shifts with a shell and edit tools. The direct API models (conversation only) are for session turns.
  if (runtimeId === DIRECT_RUNTIME)
    throw badRequest(
      'runtime_not_for_agents',
      'the direct API models have no shell or edit tools, so an agent cannot run on them: pick them for a Discovery or Boardroom seat instead',
    );
  if (role) assertRuntimeFitsRole(runtimeId, role);
  const ws = await one(tx, 'SELECT name, runtimes FROM workstations WHERE id=$1', [workstationId]);
  const rt = (
    ws?.runtimes as Array<{ id: string; sandbox?: string; sandboxReason?: string }> | undefined
  )?.find((r) => r.id === runtimeId);
  if (rt?.sandbox === 'unavailable')
    throw conflict(
      'sandbox_unavailable',
      `${ws?.name}: the ${runtimeId} runtime cannot run agents: ${rt.sandboxReason ?? 'the OS sandbox is unavailable'}`,
    );
  if (rt?.sandbox !== 'unsandboxed') return undefined;
  if (!acknowledged)
    throw conflict(
      'unsandboxed_ack_required',
      `${ws?.name} runs the ${runtimeId} runtime without an OS sandbox: an agent could read files your user can read, including the runner token. Run the runner in WSL2 to sandbox it, or set acknowledgeUnsandboxed to accept the risk.`,
    );
  return { by: userId, at: ctx.clock.now().toISOString() };
}

/**
 * Hires an agent (docs/design/organizations.md section 4.2): the Owner and Admins hire anything in the organization;
 * Members and Guests only onto their own workstation and only for a project they are on. `org` is the request's
 * organization (an org-wide hire); a project-scoped hire belongs to the project's organization.
 */
export async function hireAgent(
  ctx: Ctx,
  user: AuthSession['user'],
  org: { id: string },
  req: HireAgentRequest,
  /** R3a, hire from pack: where the agent came from, and permissions narrower than the role's (never wider). */
  extra: {
    provenance?: PackProvenance;
    permissions?: AgentPermissions;
    /**
     * Registers the role this agent is hired into, inside the hire transaction and after every authorization check, so a
     * refused hire leaves no role behind (describe-an-agent: the drafted role).
     */
    registerRole?: (tx: Tx, orgId: string) => Promise<void>;
  } = {},
): Promise<string> {
  const agentId = randomUUID();
  await withAppendTx(ctx.pool, async (tx) => {
    // Own workstation; or the organization's simulated workstation (a simulation organization's agents run there).
    const ws = await one(
      tx,
      `SELECT id, simulation_org_id FROM workstations WHERE id=$1 AND status='active' AND (user_id=$2 OR simulation_org_id=$3)`,
      [req.workstationId, user.id, org.id],
    );
    if (!ws) throw notFound('workstation not found');
    let orgId = org.id;
    let role: Awaited<ReturnType<typeof projectRole>> = null;
    // The agent belongs to the organization of the project it is hired for, or of the first project it is allowed on
    // (a guest hires into the organization that shared the project with them).
    const anchor = req.projectId ?? req.allowedProjectIds?.[0];
    if (anchor) {
      const p = await one(tx, 'SELECT org_id, status FROM projects WHERE id=$1', [anchor]);
      role = await projectRole(tx, user.id, anchor);
      if (!p || !role) throw notFound('project not found');
      if (p.status === 'archived')
        throw conflict('project_archived', 'this project is archived; unarchive it to hire');
      orgId = p.org_id;
    }
    const orgRole = await orgRoleOf(tx, user.id, orgId);
    // Where the agent may work: an explicit list (or null: any project), else the alias project, else any project.
    const allowed: string[] | null =
      req.allowedProjectIds !== undefined ? req.allowedProjectIds : req.projectId ? [req.projectId] : null;
    const allowedList = allowed === null ? null : [...new Set(allowed)];
    if (allowedList) await assertProjectsOfOrg(tx, orgId, allowedList);
    const focus = [...new Set(req.focusProjectIds ?? [])];
    assertFocusInside(focus, allowedList);
    if (focus.length) await assertProjectsOfOrg(tx, orgId, focus);
    if (
      !canHireAgentInOrg({
        orgRole,
        projectScoped: allowedList !== null && allowedList.length > 0,
        projectMember: allowedList !== null && (await memberOfAll(tx, user.id, allowedList)),
      })
    ) {
      throw forbidden('you cannot hire agents here');
    }
    // A workstation the organization does not use yet counts as one more (the DevOps engineer does not count).
    const uses = await one(
      tx,
      `SELECT 1 FROM agents WHERE org_id=$1 AND workstation_id=$2 AND status='active' AND NOT is_builtin LIMIT 1`,
      [orgId, req.workstationId],
    );
    if (!uses) await assertWithinLimit(ctx, tx, orgId, 'workstations');
    if (extra.registerRole) await extra.registerRole(tx, orgId);
    const roleDef = await loadRole(tx, orgId, req.roleKey);
    if (!roleDef) throw badRequest('unknown_role', `role '${req.roleKey}' does not exist`);
    // a role made from someone's private pack is that person's alone
    if (isOthersPrivateRole(roleDef.definition.source, user.id))
      throw badRequest('unknown_role', `role '${req.roleKey}' does not exist`);
    if (roleDef.definition.key === DEVOPS_ROLE_KEY)
      throw badRequest('invalid_role', 'DevOps engineers are hired automatically per workstation');
    if (roleDef.definition.key === 'ceo')
      throw badRequest(
        'invalid_role',
        'the CEO is built in: every organization has one, and it cannot be hired',
      );
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
    // Without an explicit runtime, an agent hired on the simulated workstation (or in a simulation organization) is a mock
    // agent: the simulated runner has no model to call, and real model names there only produce failing shifts.
    const simulated =
      !!ws.simulation_org_id ||
      !!(await one(tx, 'SELECT 1 FROM organizations WHERE id=$1 AND simulation', [orgId]));
    const dm =
      req.runtime === undefined && simulated
        ? { ...roleDef.definition.defaultModel, runtime: 'mock' as const, model: 'mock' }
        : roleDef.definition.defaultModel;
    const unsandboxedAck = await sandboxGate(
      ctx,
      tx,
      user.id,
      req.workstationId,
      req.runtime ?? dm.runtime,
      req.acknowledgeUnsandboxed,
      { roleKey: roleDef.key, permissions: roleDef.definition.permissions, model: req.model ?? dm.model },
    );
    // Skills named in the hire (typed by hand) are stored as the registry knows them: a bare pack skill name gets its pack.
    const skills = req.skills
      ? await qualifiedSkillKeys(tx, orgId, req.skills, { projectId: anchor ?? null, userId: user.id })
      : roleDef.definition.skills;
    await ctx.store.append(
      [
        {
          streamId: streamId.agent(agentId),
          event: {
            type: 'AgentHired',
            payload: {
              agentId,
              orgId,
              ...(req.projectId ? { projectId: req.projectId } : {}),
              allowedProjectIds: allowedList,
              ...(focus.length ? { focusProjectIds: focus } : {}),
              hiredByUserId: user.id,
              workstationId: req.workstationId,
              name: req.name,
              roleKey: roleDef.key,
              roleVersion: roleDef.version,
              seniority: req.seniority,
              runtime: req.runtime ?? dm.runtime,
              model: req.model ?? dm.model,
              effort: req.effort ?? dm.effort,
              skills,
              permissions: extra.permissions ?? roleDef.definition.permissions,
              capacity: req.capacity,
              isDevops: false,
              avatarSeed: randomAvatarSeed(),
              avatarStyle: DEFAULT_AVATAR_STYLE,
              ...(unsandboxedAck ? { unsandboxedAck } : {}),
              ...(extra.provenance ? { provenance: extra.provenance } : {}),
            },
          },
          actor: userActor(user.id),
          scope: orgScope(orgId),
        },
      ],
      { tx },
    );
  });
  return agentId;
}

/**
 * The agent when the user may change it: the Owner and Admins of its organization (any agent), or the manager who
 * hired it. An agent the user cannot see at all is a 404.
 */
export async function manageableAgent(tx: Tx, user: AuthSession['user'], agentId: string): Promise<Row> {
  const a = await one(
    tx,
    `SELECT a.* FROM agents a WHERE a.id=$1 AND (
        a.manager_user_id = $2
        OR EXISTS (SELECT 1 FROM org_members om WHERE om.org_id = a.org_id AND om.user_id = $2 AND om.status = 'active'
                    AND om.role IN ('owner','admin'))
        OR (NOT a.is_devops AND EXISTS (SELECT 1 FROM project_members pm JOIN projects pp ON pp.id = pm.project_id
              WHERE pp.org_id = a.org_id AND pp.kind = 'project' AND pm.user_id = $2 AND pm.status='active'
                AND (a.allowed_project_ids IS NULL OR pm.project_id = ANY (a.allowed_project_ids)))))`,
    [agentId, user.id],
  );
  if (!a) throw notFound('agent not found');
  const role = await orgRoleOf(tx, user.id, a.org_id);
  if (!canManageAgentInOrg({ userId: user.id, orgRole: role, managerUserId: a.manager_user_id })) {
    throw forbidden('only the organization Owner and Admins or the hiring manager can do this');
  }
  return a;
}

/** Agents belong to the organization: their events are organization events. */
export const agentScope = (a: Row) => orgScope(a.org_id);

export async function patchAgent(
  ctx: Ctx,
  user: AuthSession['user'],
  agentId: string,
  changes: AgentChanges,
  acknowledgeUnsandboxed?: boolean,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const a = await manageableAgent(tx, user, agentId);
    if (a.status === 'retired') throw conflict('agent_retired', 'agent is retired');
    if (a.is_devops) {
      // The built-in DevOps engineer is free, so it must not become a general-purpose agent (owner decision 15a):
      // only its model, effort and runtime can change. No other skills, permissions, role, seniority or capacity.
      const allowed = new Set(['model', 'effort', 'runtime']);
      const rejected = Object.keys(changes).filter((k) => !allowed.has(k));
      if (rejected.length)
        throw badRequest(
          'devops_fixed',
          `the DevOps engineer cannot be extended: only its model, effort and runtime can change (not ${rejected.join(', ')})`,
        );
    }
    const next: AgentChanges = { ...changes };
    const roleChanged = !!changes.roleKey && changes.roleKey !== a.role_key;
    const role = roleChanged
      ? await loadRole(tx, a.org_id, changes.roleKey as string)
      : await loadRole(tx, a.org_id, a.role_key, a.role_version);
    if (roleChanged) {
      if (!role) throw badRequest('unknown_role', `role '${changes.roleKey}' does not exist`);
      next.roleVersion = role.version;
      // A new role brings its own permissions; the old role's (a builder's commit right) must not carry over.
      if (!changes.permissions) next.permissions = role.definition.permissions;
    }
    if (changes.permissions && role) {
      // Permissions only ever narrow relative to the role definition; widening needs the organization owner and
      // never reaches past the role's hard limits (docs/ARCHITECTURE.md section on agent permissions).
      const check = checkPermissions(role.definition.permissions, changes.permissions);
      if (check.forbidden.length) throw badRequest('permissions_exceed_role', check.forbidden.join('; '));
      if (check.widened.length && !canWidenPermissions({ orgRole: await orgRoleOf(tx, user.id, a.org_id) }))
        throw forbidden(
          `only the organization Owner and Admins can widen permissions (${check.widened.join(', ')})`,
        );
    }
    if (changes.permissions) await assertMcpAdditions(tx, user, a, role, changes.permissions);
    // A model change alone can move the agent onto a backend credential (bedrock:, vertex:, gateway:) that some roles cannot take.
    if (next.model && !(next.runtime && next.runtime !== a.runtime))
      assertRuntimeFitsRole(next.runtime ?? a.runtime, {
        roleKey: next.roleKey ?? a.role_key,
        isDevops: a.is_devops === true,
        model: next.model,
      });
    const unsandboxedAck =
      next.runtime && next.runtime !== a.runtime && a.workstation_id
        ? await sandboxGate(ctx, tx, user.id, a.workstation_id, next.runtime, acknowledgeUnsandboxed, {
            roleKey: next.roleKey ?? a.role_key,
            isDevops: a.is_devops === true,
            model: next.model ?? a.model,
            ...((next.permissions ?? role?.definition.permissions)
              ? { permissions: (next.permissions ?? role?.definition.permissions) as AgentPermissions }
              : {}),
          })
        : undefined;
    await ctx.store.append(
      [
        {
          streamId: streamId.agent(agentId),
          event: {
            type: 'AgentChanged',
            payload: { agentId, changes: next, ...(unsandboxedAck ? { unsandboxedAck } : {}) },
          },
          actor: userActor(user.id),
          scope: agentScope(a),
        },
      ],
      { tx },
    );
  });
}

/**
 * Plugin MCP servers on an agent (`mcp:<server>` in its allowed tools): only the organization Owner may add one, and the
 * name must be a server the Owner's own workstations report. Entries the agent (or its role) already has are not
 * additions; removing is allowed for everyone who may change the agent.
 */
async function assertMcpAdditions(
  tx: Tx,
  user: AuthSession['user'],
  agent: Row,
  role: { definition: { permissions: { allowedTools: string[] } } } | null,
  proposed: { allowedTools: string[] },
): Promise<void> {
  const have = new Set<string>([
    ...((agent.permissions?.allowedTools ?? []) as string[]),
    ...(role?.definition.permissions.allowedTools ?? []),
  ]);
  const added = proposed.allowedTools.filter((t) => t.startsWith('mcp:') && !have.has(t));
  if (added.length === 0) return;
  if ((await orgRoleOf(tx, user.id, agent.org_id)) !== 'owner')
    throw forbidden('only the organization Owner can give an agent external tools (MCP servers)');
  const known = new Set((await mcpServerCandidates(tx, user.id, agent.org_id)).map((c) => c.name));
  const bad = added.map((t) => t.slice(4)).filter((n) => !known.has(n));
  if (bad.length > 0)
    throw badRequest(
      'invalid_mcp_server',
      'an MCP server must be one of the plugin servers reported by one of your own workstations',
      { servers: bad },
    );
}

/** 400 unless every project exists in the organization (a deleted or foreign project cannot be allowed). */
async function assertProjectsOfOrg(tx: Tx, orgId: string, projectIds: string[]): Promise<void> {
  if (projectIds.length === 0) return;
  const found = await rows<{ id: string }>(
    tx,
    `SELECT id FROM projects WHERE org_id=$1 AND kind='project' AND id = ANY($2::uuid[]) `,
    [orgId, projectIds],
  );
  if (found.length !== new Set(projectIds).size)
    throw badRequest('invalid_project', 'every project must be one of this organization');
}

/** Is the user an active member of every one of the projects? (An empty list is not.) */
async function memberOfAll(tx: Tx, userId: string, projectIds: string[]): Promise<boolean> {
  if (projectIds.length === 0) return false;
  const r = await one<{ n: string }>(
    tx,
    `SELECT count(DISTINCT project_id)::text AS n FROM project_members
      WHERE user_id=$1 AND status='active' AND project_id = ANY($2::uuid[])`,
    [userId, projectIds],
  );
  return Number(r?.n ?? 0) === new Set(projectIds).size;
}

/** The focus is a preference inside the allow-list: 400 `focus_not_allowed` for a project outside it. */
function assertFocusInside(focus: string[], allowed: string[] | null): void {
  if (allowed === null) return;
  const bad = focus.filter((f) => !allowed.includes(f));
  if (bad.length)
    throw badRequest('focus_not_allowed', 'focus projects must be projects the agent is allowed to work on');
}

/**
 * The manager sets where an agent may work (docs/design/restructure.md section 4): a list of projects, an empty list
 * (the agent works nowhere, "benched") or null for any project of the organization. The Owner and Admins may set
 * anything; a Member or Guest manager only a list of projects they are on. Focus projects outside the new list drop
 * out. The DevOps engineer is not subject to allow-lists (it works DevOps requests and hygiene only).
 */
export async function setAgentAllowedProjects(
  ctx: Ctx,
  user: AuthSession['user'],
  agentId: string,
  projectIds: string[] | null,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const a = await manageableAgent(tx, user, agentId);
    if (a.status === 'retired') throw conflict('agent_retired', 'agent is retired');
    if (a.is_devops)
      throw badRequest(
        'devops_fixed',
        'the DevOps engineer works DevOps requests only: allow-lists do not apply',
      );
    const list = projectIds === null ? null : [...new Set(projectIds)];
    if (list) await assertProjectsOfOrg(tx, a.org_id, list);
    const orgRole = await orgRoleOf(tx, user.id, a.org_id);
    const manager = isOrgManager({ orgRole });
    if (!manager && (list === null || (list.length > 0 && !(await memberOfAll(tx, user.id, list)))))
      throw forbidden('you can only allow an agent on projects you are on');
    const same = JSON.stringify(a.allowed_project_ids ?? null) === JSON.stringify(list);
    if (same) return;
    await ctx.store.append(
      [
        {
          streamId: streamId.agent(agentId),
          event: { type: 'AgentAllowedSet', payload: { agentId, projectIds: list, by: user.id } },
          actor: userActor(user.id),
          scope: agentScope(a),
        },
      ],
      { tx },
    );
  });
}

/** The manager sets the agent's focus projects: a soft preference, only among projects the agent may work. */
export async function setAgentFocusProjects(
  ctx: Ctx,
  user: AuthSession['user'],
  agentId: string,
  projectIds: string[],
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const a = await manageableAgent(tx, user, agentId);
    if (a.status === 'retired') throw conflict('agent_retired', 'agent is retired');
    if (a.is_devops)
      throw badRequest('devops_fixed', 'the DevOps engineer works DevOps requests only: it has no focus');
    const list = [...new Set(projectIds)];
    await assertProjectsOfOrg(tx, a.org_id, list);
    assertFocusInside(list, a.allowed_project_ids ?? null);
    if (JSON.stringify(a.focus_project_ids ?? []) === JSON.stringify(list)) return;
    await ctx.store.append(
      [
        {
          streamId: streamId.agent(agentId),
          event: { type: 'AgentFocusSet', payload: { agentId, projectIds: list, by: user.id } },
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
    if (a.is_devops)
      throw conflict('devops_cannot_be_fired', 'the DevOps engineer cannot be fired; reset it instead');
    if (a.role_key === 'ceo')
      throw conflict('builtin_agent', 'the CEO is built in and cannot be fired: pause it on the CEO page');
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

/** DevOps only: wipes the sandbox like a firing does, but the engineer stays (`AgentReset` + `agent.wipe`). */
export async function resetAgent(ctx: Ctx, user: AuthSession['user'], agentId: string): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const a = await manageableAgent(tx, user, agentId);
    if (!a.is_devops)
      throw conflict('not_devops', 'only the DevOps engineer can be reset; other agents are fired');
    if (a.status !== 'active') throw conflict('agent_inactive', 'agent is not active');
    await ctx.store.append(
      [
        {
          streamId: streamId.agent(agentId),
          event: { type: 'AgentReset', payload: { agentId } },
          actor: userActor(user.id),
          scope: agentScope(a),
        },
      ],
      { tx },
    );
    if (a.workstation_id) await enqueueRunnerCommand(tx, a.workstation_id, 'agent.wipe', { agentId });
  });
}

/** A manager pauses an agent: no new work (a running shift finishes). The CEO and the DevOps engineer are not paused this way. */
export async function setAgentPaused(
  ctx: Ctx,
  user: AuthSession['user'],
  agentId: string,
  paused: boolean,
  reason?: string,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const a = await manageableAgent(tx, user, agentId);
    if (a.status !== 'active') throw conflict('agent_inactive', 'agent is not active');
    if (a.is_devops) throw badRequest('devops_fixed', 'the DevOps engineer cannot be paused');
    if (a.role_key === 'ceo') throw badRequest('ceo_fixed', 'pause the CEO on the CEO page');
    if (paused === !!a.paused_at) return;
    await ctx.store.append(
      [
        {
          streamId: streamId.agent(agentId),
          event: paused
            ? { type: 'AgentPaused', payload: { agentId, by: user.id, reason: reason ?? '', viaCeo: false } }
            : { type: 'AgentResumed', payload: { agentId, by: user.id, viaCeo: false } },
          actor: userActor(user.id),
          scope: agentScope(a),
        },
      ],
      { tx },
    );
  });
  if (!paused) ctx.services.dispatcher.trigger();
}
