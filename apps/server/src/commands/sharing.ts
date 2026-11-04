import {
  type Actor,
  canManageCard,
  type DecisionPolicyRequest,
  isOrgManager,
  type MoveAllAgentsRequest,
  type MoveBlockReason,
  type MoveAllAgentsResponse,
  type OrgRole,
  type ProjectInvitationDto,
  type RehomeAgentRequest,
  type RemovalPreview,
  streamId,
  type UnsandboxedAck,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleCard, loadVisibleProject } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { assertWithinLimit } from '../orgs/limits.ts';
import { orgWorkstationSql } from '../queries/move-targets.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { sandboxGate } from './agents.ts';
import { cardMessage, orgScope, projectScope, userActor } from './common.ts';

// ------------------------------------------------------------------------------------- invitations

/**
 * An organization Owner or Admin gives someone access to a project (owner decision 4: only they add people):
 * an active member of the organization is added at once (`ProjectMemberAdded`, no accept step); another existing
 * account becomes a guest through an invitation they accept (`ProjectShared`, section 24 item 17). Everyone has an
 * organization, so there is no "invite them to the app" here: an unknown email is told to join the organization first.
 */
export async function shareProject(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  email: string,
): Promise<{ via: 'member' | 'guest' }> {
  return withAppendTx(ctx.pool, async (tx) => {
    const p = await loadVisibleProject(tx, user.id, projectId);
    if (p.my_role !== 'owner')
      throw forbidden('only the organization Owner and Admins can add people to a project');
    if (p.status !== 'active') throw conflict('project_archived', 'project is archived');
    const invitee = await one(tx, `SELECT id, status, kind FROM users WHERE lower(email) = lower($1)`, [
      email.trim(),
    ]);
    if (!invitee || invitee.status !== 'active')
      throw notFound(
        'no active account with that email. Invite them to the organization first, or ask them to sign up.',
        'user_not_found',
      );
    if (invitee.kind === 'super_admin')
      throw conflict('super_admin_cannot_join', 'platform accounts cannot join projects');
    if (invitee.id === user.id)
      throw badRequest('invalid_invitee', 'you already have access to this project');
    const existing = await one(
      tx,
      'SELECT status, org_grant FROM project_members WHERE project_id=$1 AND user_id=$2',
      [projectId, invitee.id],
    );
    if (existing?.status === 'active') throw conflict('already_member', 'this user is already a member');
    if (existing?.status === 'invited')
      throw conflict('already_invited', 'this user already has a pending invitation');
    const member = await orgRoleOf(tx, invitee.id, p.org_id);
    if (member) {
      await ctx.store.append(
        [
          {
            streamId: streamId.project(projectId),
            event: {
              type: 'ProjectMemberAdded',
              payload: { projectId, userId: invitee.id, addedBy: user.id },
            },
            actor: userActor(user.id),
            scope: projectScope(p.org_id, projectId),
          },
        ],
        { tx },
      );
      return { via: 'member' as const };
    }
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: { type: 'ProjectShared', payload: { projectId, userId: invitee.id, invitedBy: user.id } },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
      ],
      { tx },
    );
    return { via: 'guest' as const };
  });
}

export async function listProjectInvitations(ctx: Ctx, userId: string): Promise<ProjectInvitationDto[]> {
  const r = await rows(
    ctx.pool,
    `SELECT pm.project_id, pm.invited_at, p.key, p.name, o.name AS org_name,
            COALESCE(inv.display_name, owner.display_name) AS invited_by_name
       FROM project_members pm JOIN projects p ON p.id = pm.project_id
       JOIN organizations o ON o.id = p.org_id
       JOIN users owner ON owner.id = o.owner_user_id LEFT JOIN users inv ON inv.id = pm.invited_by
      WHERE pm.user_id = $1 AND pm.status = 'invited' AND p.status = 'active'
      ORDER BY pm.invited_at DESC`,
    [userId],
  );
  return r.map((x) => ({
    projectId: x.project_id,
    projectKey: x.key,
    projectName: x.name,
    invitedByName: x.invited_by_name,
    orgName: x.org_name,
    invitedAt: iso(x.invited_at),
  }));
}

async function pendingInvitation(tx: Queryable, userId: string, projectId: string): Promise<Row> {
  const inv = await one(
    tx,
    `SELECT pm.*, p.org_id FROM project_members pm JOIN projects p ON p.id = pm.project_id
      WHERE pm.project_id=$1 AND pm.user_id=$2 AND pm.status='invited'`,
    [projectId, userId],
  );
  if (!inv) throw notFound('no pending invitation for this project');
  return inv;
}

export async function answerShare(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  accept: boolean,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const inv = await pendingInvitation(tx, user.id, projectId);
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: {
            type: accept ? 'ProjectShareAccepted' : 'ProjectShareDeclined',
            payload: { projectId, userId: user.id },
          },
          actor: userActor(user.id),
          scope: projectScope(inv.org_id, projectId),
        },
      ],
      { tx },
    );
  });
}

// ------------------------------------------------------------------------------- member removal

/**
 * What removing `memberId` from the project touches (docs/design/restructure.md section 4.4). Agents are
 * organization-wide, so the member's agents are re-homed only when this was their last access in the organization
 * (no other active project, and no organization-wide grant); otherwise they keep working elsewhere and only stop
 * qualifying for this project. Their claims on this project are released in both cases.
 */
async function removalPlan(tx: Queryable, projectId: string, memberId: string, includeGrant = false) {
  const project = await one<{ org_id: string }>(tx, 'SELECT org_id FROM projects WHERE id=$1', [projectId]);
  // The member keeps this project through the organization grant (an org Member): nothing moves.
  const keeps =
    !includeGrant &&
    (await one(
      tx,
      `SELECT 1 FROM project_members WHERE project_id=$1 AND user_id=$2 AND status='active' AND org_grant`,
      [projectId, memberId],
    ));
  const held =
    project && !keeps
      ? await rows(
          tx,
          `SELECT a.id, a.name, a.role_key, a.workstation_id, w.name AS workstation_name
             FROM agents a LEFT JOIN workstations w ON w.id = a.workstation_id
            WHERE a.org_id=$1 AND (a.manager_user_id=$2 OR w.user_id=$2) AND a.status IN ('active','needs_rehome')
              AND NOT a.is_devops
            ORDER BY a.hired_at`,
          [project.org_id, memberId],
        )
      : [];
  const lastAccess =
    !!project &&
    !(await one(
      tx,
      `SELECT 1 FROM project_members pm JOIN projects pp ON pp.id = pm.project_id
        WHERE pp.org_id=$1 AND pm.user_id=$2 AND pm.status='active' AND (pm.project_id <> $3 OR pm.org_grant)`,
      [project.org_id, memberId, projectId],
    ));
  const agents = lastAccess ? held : [];
  const claimed = await rows(
    tx,
    `SELECT c.* FROM cards c WHERE c.project_id=$1 AND c.claim_id IS NOT NULL AND c.claimed_by_agent_id = ANY($2::uuid[])`,
    [projectId, held.map((a) => a.id)],
  );
  const owned = await rows(
    tx,
    `SELECT id, ref, title, status FROM cards WHERE project_id=$1 AND owner_user_id=$2 ORDER BY number`,
    [projectId, memberId],
  );
  return { agents, claimed, owned };
}

/** What removing the member will hand to the owner (shown before confirming). */
export async function previewRemoval(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  memberId: string,
): Promise<RemovalPreview> {
  const p = await loadVisibleProject(ctx.pool, user.id, projectId);
  if (p.my_role !== 'owner') throw forbidden('only the project owner can do this');
  const m = await one(
    ctx.pool,
    `SELECT pm.status, u.display_name FROM project_members pm JOIN users u ON u.id = pm.user_id
      WHERE pm.project_id=$1 AND pm.user_id=$2 AND pm.role <> 'owner'`,
    [projectId, memberId],
  );
  if (!m) throw notFound('member not found');
  const plan = await removalPlan(ctx.pool, projectId, memberId);
  return {
    userId: memberId,
    displayName: m.display_name,
    status: m.status,
    agents: plan.agents.map((a) => ({
      id: a.id,
      name: a.name,
      roleKey: a.role_key,
      workstationName: a.workstation_name ?? null,
      claimedCardRef: plan.claimed.find((c) => c.claimed_by_agent_id === a.id)?.ref ?? null,
    })),
    releasedCards: plan.claimed.map((c) => ({ ref: c.ref, title: c.title })),
    transferredCards: plan.owned.map((c) => ({ ref: c.ref, title: c.title, status: c.status })),
  };
}

/**
 * Owner removes a manager (docs/ARCHITECTURE.md section 17.2): one append releases the claims of the member's agents
 * (`member_removed`, last handoff attached), then `ProjectMemberRemoved` moves the agents (`needs_rehome`) and the
 * member's cards to the owner. The old workstations wipe the agents' sandboxes when they next connect.
 */
export async function removeMember(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  memberId: string,
): Promise<{ inheritedAgentIds: string[]; transferredCardIds: string[]; releasedCardIds: string[] }> {
  return withAppendTx(ctx.pool, async (tx) => {
    const p = await loadVisibleProject(tx, user.id, projectId);
    if (p.my_role !== 'owner') throw forbidden('only the project owner can do this');
    return removeMemberIn(ctx, tx, user.id, p, memberId);
  });
}

/** The removal itself, inside the caller's transaction (also used when an administrator deactivates a user). */
export async function removeMemberIn(
  ctx: Ctx,
  tx: Tx,
  actorId: string,
  p: Row,
  memberId: string,
  opts: { includeGrant?: boolean } = {},
): Promise<{ inheritedAgentIds: string[]; transferredCardIds: string[]; releasedCardIds: string[] }> {
  const projectId = p.id as string;
  const user = { id: actorId };
  {
    // The organization's Owner and Admins hold `owner` rows through their grant: only leaving the organization removes those.
    const m = await one(
      tx,
      `SELECT status FROM project_members WHERE project_id=$1 AND user_id=$2 AND ($3::boolean OR role <> 'owner')`,
      [projectId, memberId, opts.includeGrant === true],
    );
    if (!m || m.status === 'removed') throw notFound('member not found');
    const plan = await removalPlan(tx, projectId, memberId, opts.includeGrant === true);
    const events: AppendInput[] = [];
    for (const c of plan.claimed) {
      const lastHandoff = await one<{ id: string }>(
        tx,
        'SELECT id FROM card_handoffs WHERE card_id=$1 ORDER BY created_at DESC, event_seq DESC LIMIT 1',
        [c.id],
      );
      events.push({
        streamId: streamId.card(c.id),
        event: {
          type: 'ClaimReleased',
          payload: {
            cardId: c.id,
            claimId: c.claim_id,
            agentId: c.claimed_by_agent_id,
            reason: 'member_removed',
            lastHandoffId: lastHandoff?.id,
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
          'Claim released: the manager who hired this agent left the project. The card is back in the queue with the last handoff attached.',
        ),
      );
    }
    // Work in progress on the departed manager's machines cannot continue there: those cards forget their home
    // workstation (the stage restarts from the base branch on the owner's side, like a manual card re-home).
    const homed = await rows(
      tx,
      `SELECT c.* FROM cards c WHERE c.project_id=$1 AND c.status NOT IN ('done','cancelled')
          AND c.home_workstation_id IN (SELECT id FROM workstations WHERE user_id=$2)`,
      [projectId, memberId],
    );
    for (const c of homed) {
      events.push({
        streamId: streamId.card(c.id),
        event: { type: 'CardRehomed', payload: { cardId: c.id, by: user.id } },
        actor: userActor(user.id),
        scope: projectScope(c.org_id, c.project_id),
      });
    }
    const inheritedAgentIds = plan.agents.map((a) => a.id as string);
    const transferredCardIds = plan.owned.map((c) => c.id as string);
    events.push({
      streamId: streamId.project(projectId),
      event: {
        type: 'ProjectMemberRemoved',
        payload: { projectId, userId: memberId, removedBy: user.id, inheritedAgentIds, transferredCardIds },
      },
      actor: userActor(user.id),
      scope: projectScope(p.org_id, projectId),
    });
    await ctx.store.append(events, { tx });
    // The old sandbox stays behind: wipe it if that runner ever connects (durable command).
    for (const a of plan.agents) {
      if (a.workstation_id) await enqueueRunnerCommand(tx, a.workstation_id, 'agent.wipe', { agentId: a.id });
    }
    return {
      inheritedAgentIds,
      transferredCardIds,
      releasedCardIds: plan.claimed.map((c) => c.id as string),
    };
  }
}

// ------------------------------------------------------------------------------------ agent re-home

/**
 * Loads the agent for a move and checks the caller: 404 when the agent is unknown or the caller has nothing to do with
 * it, 403 unless the caller is an Owner or Admin of its organization, or the hiring manager of a non-built-in agent.
 * Only an Owner or Admin moves a DevOps engineer.
 */
export async function loadMovableAgent(
  tx: Queryable,
  user: Pick<AuthSession['user'], 'id'>,
  agentId: string,
): Promise<Row> {
  const a = await one(tx, 'SELECT * FROM agents WHERE id=$1', [agentId]);
  const role = a ? await orgRoleOf(tx, user.id, a.org_id) : null;
  if (!a || (!role && a.manager_user_id !== user.id)) throw notFound('agent not found');
  const orgManager = isOrgManager({ orgRole: role });
  const hiringManager = !!role && a.manager_user_id === user.id;
  if (a.is_builtin && a.is_devops && !orgManager)
    throw forbidden('only the organization Owner and Admins can move a DevOps engineer');
  if (!orgManager && !(hiringManager && !a.is_builtin))
    throw forbidden(
      "only the organization Owner, its Admins and the agent's hiring manager can move an agent to another workstation",
    );
  return a;
}

/** An Owner, Admin or the hiring manager moves an agent (active or needs_rehome) to another workstation of its organization. */
export async function rehomeAgent(
  ctx: Ctx,
  user: AuthSession['user'],
  agentId: string,
  req: RehomeAgentRequest,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const a = await loadMovableAgent(tx, user, agentId);
    await rehomeAgentIn(ctx, tx, { userId: user.id, actor: userActor(user.id) }, a, req);
  });
}

/** What the checks of a move found: the target workstation and the unsandboxed acknowledgement to record. */
export interface AgentMovePlan {
  w: Row;
  unsandboxedAck: UnsandboxedAck | undefined;
}

/**
 * Every rule of a move, reads only: throws the HttpError the move would throw and returns what the append needs.
 * `rehomeAgentIn` runs it inside its append transaction; the CEO's move runs it first to refuse early.
 * `skipLimitCheck` is for a bulk move that empties the source, where the organization's workstation count does not rise.
 */
export async function checkAgentMove(
  ctx: Ctx,
  tx: Queryable,
  by: { userId: string },
  a: Row,
  req: RehomeAgentRequest,
  opts: { skipLimitCheck?: boolean; releaseHeldClaims?: boolean } = {},
): Promise<AgentMovePlan> {
  if (a.status === 'retired')
    throw conflict('agent_retired', `${a.name} was fired; a fired agent cannot be moved`);
  if (a.is_builtin && a.role_key === 'ceo') throw conflict('builtin_agent', 'the CEO moves on the CEO page');
  // A needs_rehome agent has no workstation: removing its manager released its claims, and a shift left open by a
  // runner that never reported back is orphaned (nothing would ever end it), so it must not block the re-home.
  const shift =
    a.status === 'needs_rehome'
      ? null
      : await one(tx, `SELECT 1 FROM shifts WHERE agent_id=$1 AND status <> 'ended' LIMIT 1`, [a.id]);
  if (shift)
    throw conflict(
      'agent_busy',
      `${a.name} is in a running shift: wait until it ends or stop it, then move ${a.name}.`,
    );
  if (!opts.releaseHeldClaims) {
    // The caller releases nothing: a claim the agent holds would stay stranded on the old workstation.
    const claim = await one(
      tx,
      `SELECT ref FROM cards WHERE claimed_by_agent_id=$1 AND claim_id IS NOT NULL LIMIT 1`,
      [a.id],
    );
    if (claim)
      throw conflict(
        'agent_busy',
        `${a.name} is working on ${claim.ref}: release the card or wait until the shift ends.`,
      );
  }
  const w = await one(
    tx,
    `SELECT w.id, w.name, w.status, w.user_id, w.runtimes, ${orgWorkstationSql('w', '$2::uuid')} AS in_org
       FROM workstations w WHERE w.id=$1`,
    [req.workstationId, a.org_id],
  );
  if (w && !w.in_org && w.status !== 'active') {
    const member = await one(
      tx,
      `SELECT 1 FROM org_members WHERE org_id=$1 AND user_id=$2 AND status='active'`,
      [a.org_id, w.user_id],
    );
    if (member) throw conflict('workstation_unpaired', `${w.name} was unpaired: pick a paired workstation`);
  }
  if (!w || !w.in_org) throw notFound('workstation not found in this organization', 'workstation_not_found');
  if (w.id === a.workstation_id) throw conflict('same_workstation', `${a.name} already works on ${w.name}`);
  if (a.is_devops) {
    const cur = a.workstation_id
      ? await one(tx, 'SELECT name, status FROM workstations WHERE id=$1', [a.workstation_id])
      : undefined;
    if (cur && cur.status === 'active')
      throw conflict(
        'devops_stays',
        `${a.name} is the DevOps engineer of ${cur.name}, which is still paired, so it stays there. Only the DevOps engineer of an unpaired workstation can move.`,
      );
    const other = await one(
      tx,
      `SELECT name FROM agents WHERE org_id=$1 AND workstation_id=$2 AND is_devops AND status='active' AND id<>$3 LIMIT 1`,
      [a.org_id, w.id, a.id],
    );
    if (other)
      throw conflict(
        'one_devops_per_workstation',
        `${w.name} already has a DevOps engineer, ${other.name}: the rule is one DevOps engineer per workstation (agents_one_devops), so ${a.name} cannot move there.`,
      );
  }
  const unsandboxedAck = await sandboxGate(
    ctx,
    tx,
    by.userId,
    w.id,
    req.runtime,
    req.acknowledgeUnsandboxed,
    { roleKey: a.role_key, isDevops: a.is_devops, permissions: a.permissions, model: req.model },
  );
  assertTargetRuntime(w, { name: a.name, runtime: req.runtime });
  // A workstation the organization does not use yet counts as one more (docs/design/organizations.md section 7.4);
  // the one this agent leaves counts as one less when it was the last agent there.
  const used = await one(
    tx,
    `SELECT 1 FROM agents WHERE org_id=$1 AND workstation_id=$2 AND status='active' AND NOT is_builtin LIMIT 1`,
    [a.org_id, w.id],
  );
  let delta = a.is_builtin ? 0 : used ? 0 : 1;
  if (!a.is_builtin && a.status === 'active' && a.workstation_id) {
    const others = await one(
      tx,
      `SELECT 1 FROM agents WHERE org_id=$1 AND workstation_id=$2 AND status='active' AND NOT is_builtin AND id<>$3 LIMIT 1`,
      [a.org_id, a.workstation_id, a.id],
    );
    if (!others) delta -= 1;
  }
  if (delta > 0 && !opts.skipLimitCheck) await assertWithinLimit(ctx, tx, a.org_id, 'workstations');
  return { w, unsandboxedAck };
}

/**
 * Every check of a move, inside the caller's transaction (so the busy check cannot race a claim). Returns what to
 * append and appends nothing: every refusal throws and the agent stays where it was.
 */
export async function prepareAgentMove(
  ctx: Ctx,
  tx: Queryable,
  by: { userId: string; actor: Actor },
  a: Row,
  req: RehomeAgentRequest,
  opts: { skipLimitCheck?: boolean; releaseHeldClaims?: boolean } = {},
): Promise<{
  append: AppendInput;
  fromWorkstationId: string | null;
  toWorkstationId: string;
  targetName: string;
}> {
  const { w, unsandboxedAck } = await checkAgentMove(ctx, tx, by, a, req, opts);
  const append: AppendInput = {
    streamId: streamId.agent(a.id),
    event: {
      type: 'AgentRehomed',
      payload: {
        agentId: a.id,
        workstationId: w.id,
        fromWorkstationId: a.workstation_id ?? null,
        runtime: req.runtime,
        model: req.model,
        ...(unsandboxedAck ? { unsandboxedAck } : {}),
      },
    },
    actor: by.actor,
    scope: orgScope(a.org_id),
  };
  return {
    append,
    fromWorkstationId: a.workstation_id ?? null,
    toWorkstationId: w.id,
    targetName: w.name,
  };
}

/**
 * The move itself, inside the caller's append transaction. The caller has already checked who may move the agent.
 * Every refusal throws before anything is appended.
 */
export async function rehomeAgentIn(
  ctx: Ctx,
  tx: Tx,
  by: { userId: string; actor: Actor },
  a: Row,
  req: RehomeAgentRequest,
  opts: { skipLimitCheck?: boolean } = {},
): Promise<{ fromWorkstationId: string | null; toWorkstationId: string; releasedCardIds: string[] }> {
  const p = await prepareAgentMove(ctx, tx, by, a, req, {
    releaseHeldClaims: true,
    ...(opts.skipLimitCheck ? { skipLimitCheck: true } : {}),
  });
  // Work the agent still holds without an open shift (a lost shift whose lease has not expired) goes back to the queue.
  const claims = await rows(tx, `SELECT * FROM cards WHERE claimed_by_agent_id=$1 AND claim_id IS NOT NULL`, [
    a.id,
  ]);
  const tasks = await rows(
    tx,
    `SELECT id, org_id, project_id FROM ba_tasks WHERE agent_id=$1 AND status='running'`,
    [a.id],
  );
  const releases: AppendInput[] = [];
  for (const c of claims) {
    releases.push({
      streamId: streamId.card(c.id),
      event: {
        type: 'ClaimReleased',
        payload: { cardId: c.id, claimId: c.claim_id, agentId: a.id, reason: 'agent_moved' },
      },
      actor: by.actor,
      scope: projectScope(c.org_id, c.project_id),
    });
    releases.push(
      cardMessage(c, { kind: 'system' }, 'system', `Claim released: ${a.name} moved to another workstation.`),
    );
  }
  for (const t of tasks) {
    releases.push({
      streamId: streamId.baTask(t.id),
      event: { type: 'BaTaskRequeued', payload: { taskId: t.id, reason: 'agent_moved', attempt: false } },
      actor: by.actor,
      scope: t.project_id ? projectScope(t.org_id, t.project_id) : orgScope(t.org_id),
    });
  }
  await ctx.store.append([...releases, p.append], { tx });
  return {
    fromWorkstationId: p.fromWorkstationId,
    toWorkstationId: p.toWorkstationId,
    releasedCardIds: claims.map((c) => c.id as string),
  };
}

// ------------------------------------------------------------------------------- move all agents

type MovedRef = { agentId: string; name: string };

/** The workstation the agents of `orgId` are moved from; undefined when it does not exist or is unrelated to the organization. */
export async function loadSourceWorkstation(
  db: Queryable,
  orgId: string,
  workstationId: string,
): Promise<Row | undefined> {
  const w = await one(
    db,
    `SELECT w.id, w.name, w.status,
            (w.simulation_org_id = $2::uuid
             OR EXISTS (SELECT 1 FROM agents ag WHERE ag.workstation_id = w.id AND ag.org_id = $2 AND ag.status <> 'retired')
             OR EXISTS (SELECT 1 FROM org_members om WHERE om.org_id = $2 AND om.user_id = w.user_id AND om.status = 'active')) AS known
       FROM workstations w WHERE w.id = $1`,
    [workstationId, orgId],
  );
  return w && w.known === true ? w : undefined;
}

/**
 * The target must offer the runtime the agent will run: a target that has not reported its runtimes yet (an empty
 * list) is not judged here; the sandbox gate still applies. The single move and the bulk move share this check.
 */
export function assertTargetRuntime(target: Row, a: { runtime: string }): void {
  const targetRuntimes = (target.runtimes ?? []) as Array<{ id: string; available?: boolean }>;
  if (targetRuntimes.length > 0 && !targetRuntimes.some((r) => r.id === a.runtime && r.available !== false))
    throw conflict(
      'runtime_missing',
      `${target.name} has no ${a.runtime} runtime: move this agent on its own and pick a runtime`,
    );
}

/** The reason a bulk move shows for the code of the single move's refusal. */
export function moveBlockReason(code: string): MoveBlockReason {
  switch (code) {
    case 'agent_busy':
      return 'running_shift';
    case 'devops_stays':
    case 'one_devops_per_workstation':
      return 'one_devops';
    case 'builtin_agent':
      return 'ceo';
    case 'limit_reached':
      return 'workstation_limit';
    case 'sandbox_unavailable':
    case 'unsandboxed_ack_required':
    case 'runtime_not_for_role':
    case 'runtime_not_for_agents':
      return 'sandbox_gate';
    case 'runtime_missing':
      return 'runtime_missing';
    default:
      return 'other';
  }
}

/** Refs of the cards an agent holds a claim on (what a move releases). */
async function heldClaimRefs(db: Queryable, agentId: string): Promise<string[]> {
  const list = await rows(
    db,
    `SELECT ref FROM cards WHERE claimed_by_agent_id=$1 AND claim_id IS NOT NULL ORDER BY ref`,
    [agentId],
  );
  return list.map((c) => c.ref as string);
}

/**
 * Moves every agent of workstation `sourceId` (any status of the workstation, even one that no longer exists as a
 * computer) to `req.targetWorkstationId`. It repeats none of the single move's rules: every agent goes through
 * `checkAgentMove` (the preview and the first pass) and `rehomeAgentIn` (one transaction per agent, which releases the
 * claims it holds and appends one AgentRehomed). An agent the single move refuses is reported blocked with a reason and
 * stays where it is; nothing is rolled back across agents. An Owner or Admin moves all agents; anyone else only the
 * non-built-in agents they hired. With `dryRun` nothing is written.
 */
export async function moveAllAgents(
  ctx: Ctx,
  who: { userId: string; orgId: string; role: OrgRole | null },
  sourceId: string,
  req: MoveAllAgentsRequest,
  opts: { dryRun?: boolean } = {},
): Promise<MoveAllAgentsResponse> {
  if (sourceId === req.targetWorkstationId)
    throw badRequest('same_workstation', 'pick another workstation than the one the agents are on');
  const dryRun = opts.dryRun === true;
  const all = isOrgManager({ orgRole: who.role });
  const notFoundWs = () => notFound('workstation not found in this organization', 'workstation_not_found');

  const src = await one(ctx.pool, `SELECT id, name, status, connected FROM workstations WHERE id=$1`, [
    sourceId,
  ]);
  if (!src || !(await loadSourceWorkstation(ctx.pool, who.orgId, sourceId))) throw notFoundWs();

  const target = await one(
    ctx.pool,
    `SELECT w.id, w.name, w.status, w.user_id, ${orgWorkstationSql('w', '$2::uuid')} AS in_org
       FROM workstations w WHERE w.id = $1`,
    [req.targetWorkstationId, who.orgId],
  );
  if (target && !target.in_org && target.status !== 'active') {
    const member = await one(
      ctx.pool,
      `SELECT 1 FROM org_members WHERE org_id=$1 AND user_id=$2 AND status='active'`,
      [who.orgId, target.user_id],
    );
    if (member)
      throw conflict('workstation_unpaired', `${target.name} was unpaired: pick a paired workstation`);
  }
  if (!target || !target.in_org) throw notFoundWs();

  const agents = await rows(
    ctx.pool,
    all
      ? `SELECT * FROM agents WHERE org_id=$1 AND workstation_id=$2 AND status <> 'retired' ORDER BY lower(name), id`
      : `SELECT * FROM agents WHERE org_id=$1 AND workstation_id=$2 AND status <> 'retired'
           AND manager_user_id=$3 AND NOT is_builtin ORDER BY lower(name), id`,
    all ? [who.orgId, sourceId] : [who.orgId, sourceId, who.userId],
  );
  if (!all && agents.length === 0)
    throw forbidden(
      'only the organization Owner and Admins, or the hiring manager of these agents, can move them',
    );

  const moved: MoveAllAgentsResponse['moved'] = [];
  const blocked: MoveAllAgentsResponse['blocked'] = [];
  let needsUnsandboxedAck = false;
  const ref = (a: Row) => ({ agentId: a.id as string, name: a.name as string });
  const block = (a: Row, e: unknown) => {
    if (e instanceof HttpError) {
      if (e.code === 'unsandboxed_ack_required') needsUnsandboxedAck = true;
      blocked.push({ ...ref(a), reason: moveBlockReason(e.code), code: e.code, message: e.message });
    } else
      blocked.push({ ...ref(a), reason: 'other', code: 'internal', message: 'the move failed unexpectedly' });
  };

  const by = { userId: who.userId, actor: userActor(who.userId) };
  const reqFor = (a: Row): RehomeAgentRequest => ({
    workstationId: target.id,
    runtime: a.runtime,
    model: a.model,
    ...(req.acknowledgeUnsandboxed ? { acknowledgeUnsandboxed: true } : {}),
  });

  // Pass 1 (reads only): every rule except the workstation limit. When every agent that counts toward the limit passes,
  // the source empties and the organization's workstation count does not rise, so the limit is not asked.
  const passed: Row[] = [];
  for (const a of agents) {
    try {
      await checkAgentMove(ctx, ctx.pool, by, a, reqFor(a), { releaseHeldClaims: true, skipLimitCheck: true });
      passed.push(a);
    } catch (e) {
      block(a, e);
    }
  }
  const counting = await one(
    ctx.pool,
    `SELECT count(*)::int AS n FROM agents WHERE org_id=$1 AND workstation_id=$2 AND status='active' AND NOT is_builtin`,
    [who.orgId, sourceId],
  );
  const passedCounting = passed.filter((a) => a.status === 'active' && !a.is_builtin).length;
  const sourceLeaves = (counting?.n ?? 0) === passedCounting;

  // Pass 2: with agents staying behind, the target may count as one more workstation.
  const toMove: Row[] = [];
  for (const a of passed) {
    if (sourceLeaves) {
      toMove.push(a);
      continue;
    }
    try {
      await checkAgentMove(ctx, ctx.pool, by, a, reqFor(a), { releaseHeldClaims: true });
      toMove.push(a);
    } catch (e) {
      block(a, e);
    }
  }

  if (dryRun) {
    for (const a of toMove) moved.push({ ...ref(a), releasedClaims: await heldClaimRefs(ctx.pool, a.id) });
  } else {
    for (const planned of toMove) {
      try {
        const done = await withAppendTx(ctx.pool, async (tx) => {
          const a = await loadMovableAgent(tx, { id: who.userId }, planned.id);
          if (a.status === 'retired' || a.workstation_id !== sourceId)
            throw conflict('moved_meanwhile', `${a.name} is no longer on this workstation`);
          const releasedClaims = await heldClaimRefs(tx, a.id);
          await rehomeAgentIn(ctx, tx, by, a, reqFor(a), { skipLimitCheck: sourceLeaves });
          return { ...ref(a), releasedClaims };
        });
        moved.push(done);
      } catch (e) {
        if (!(e instanceof HttpError) && moved.length === 0 && blocked.length === 0) throw e;
        block(planned, e);
      }
    }
  }

  return {
    dryRun,
    scope: all ? 'all' : 'own',
    source: {
      id: src.id,
      name: src.name,
      status: src.status === 'active' ? 'active' : 'unlinked',
      connected: src.connected === true,
    },
    target: { id: target.id, name: target.name },
    moved,
    blocked,
    needsUnsandboxedAck,
  };
}

// ------------------------------------------------------------------------------------ card actions

async function manageableCard(tx: Tx, user: AuthSession['user'], idOrRef: string): Promise<Row> {
  const { card, role } = await loadVisibleCard(tx, user.id, idOrRef);
  if (!canManageCard({ userId: user.id, projectRole: role, cardOwnerUserId: card.owner_user_id }))
    throw forbidden('only the card owner or the project owner can do this');
  return card;
}

/** `owner_only` (default) or `any_manager`: who may answer this card's desk items. */
export async function setDecisionPolicy(
  ctx: Ctx,
  user: AuthSession['user'],
  idOrRef: string,
  req: DecisionPolicyRequest,
): Promise<string> {
  return withAppendTx(ctx.pool, async (tx) => {
    const card = await manageableCard(tx, user, idOrRef);
    if (card.decision_policy === req.policy) return card.id as string;
    await ctx.store.append(
      [
        {
          streamId: streamId.card(card.id),
          event: { type: 'DecisionPolicyChanged', payload: { cardId: card.id, policy: req.policy } },
          actor: userActor(user.id),
          scope: projectScope(card.org_id, card.project_id),
        },
      ],
      { tx },
    );
    return card.id as string;
  });
}

/** Forgets the card's home workstation and worktree: its stage restarts from the base branch on any workstation. */
export async function rehomeCard(ctx: Ctx, user: AuthSession['user'], idOrRef: string): Promise<string> {
  return withAppendTx(ctx.pool, async (tx) => {
    const card = await manageableCard(tx, user, idOrRef);
    if (['done', 'cancelled'].includes(card.status)) throw conflict('card_closed', `card is ${card.status}`);
    if (card.claim_id) throw conflict('card_claimed', 'release the card first; an agent is working on it');
    await ctx.store.append(
      [
        {
          streamId: streamId.card(card.id),
          event: { type: 'CardRehomed', payload: { cardId: card.id, by: user.id } },
          actor: userActor(user.id),
          scope: projectScope(card.org_id, card.project_id),
        },
        cardMessage(
          card,
          { kind: 'system' },
          'system',
          `${user.displayName} re-homed the card: the ${card.stage} stage restarts from the base branch on any workstation.`,
        ),
      ],
      { tx },
    );
    return card.id as string;
  });
}
