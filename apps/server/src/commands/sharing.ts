import {
  canManageAgentInOrg,
  canManageCard,
  type DecisionPolicyRequest,
  isOrgManager,
  type ProjectInvitationDto,
  type RehomeAgentRequest,
  type RemovalPreview,
  streamId,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleCard, loadVisibleProject } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { assertWithinLimit } from '../orgs/limits.ts';
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

async function removalPlan(tx: Queryable, projectId: string, memberId: string) {
  const agents = await rows(
    tx,
    `SELECT a.id, a.name, a.role_key, a.workstation_id, w.name AS workstation_name
       FROM agents a LEFT JOIN workstations w ON w.id = a.workstation_id
      WHERE a.project_id=$1 AND a.hired_by_user_id=$2 AND a.status IN ('active','needs_rehome') AND NOT a.is_devops
      ORDER BY a.hired_at`,
    [projectId, memberId],
  );
  const claimed = await rows(
    tx,
    `SELECT c.* FROM cards c WHERE c.project_id=$1 AND c.claim_id IS NOT NULL AND c.claimed_by_agent_id = ANY($2::uuid[])`,
    [projectId, agents.map((a) => a.id)],
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
    const plan = await removalPlan(tx, projectId, memberId);
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

/** Owner (or the agent's current manager) re-homes a `needs_rehome` agent onto one of their own workstations. */
export async function rehomeAgent(
  ctx: Ctx,
  user: AuthSession['user'],
  agentId: string,
  req: RehomeAgentRequest,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const a = await one(tx, 'SELECT * FROM agents WHERE id=$1', [agentId]);
    const role = a ? await orgRoleOf(tx, user.id, a.org_id) : null;
    if (!a || !(isOrgManager({ orgRole: role }) || a.manager_user_id === user.id))
      throw notFound('agent not found');
    if (!canManageAgentInOrg({ userId: user.id, orgRole: role, managerUserId: a.manager_user_id }))
      throw forbidden('only the organization Owner and Admins or the hiring manager can do this');
    if (a.status !== 'needs_rehome')
      throw conflict('not_homeless', 'only agents that need a new home can be re-homed');
    const ws = await one(
      tx,
      `SELECT id, runtimes FROM workstations WHERE id=$1 AND user_id=$2 AND status='active'`,
      [req.workstationId, user.id],
    );
    if (!ws) throw notFound('workstation not found');
    const unsandboxedAck = await sandboxGate(
      ctx,
      tx,
      user.id,
      req.workstationId,
      req.runtime,
      req.acknowledgeUnsandboxed,
    );
    // A workstation the organization does not use yet counts as one more (docs/design/organizations.md section 7.4).
    const used = await one(
      tx,
      `SELECT 1 FROM agents WHERE org_id=$1 AND workstation_id=$2 AND status='active' AND NOT is_devops LIMIT 1`,
      [a.org_id, req.workstationId],
    );
    if (!used) await assertWithinLimit(tx, a.org_id, 'workstations');
    await ctx.store.append(
      [
        {
          streamId: streamId.agent(agentId),
          event: {
            type: 'AgentRehomed',
            payload: {
              agentId,
              workstationId: req.workstationId,
              runtime: req.runtime,
              model: req.model,
              ...(unsandboxedAck ? { unsandboxedAck } : {}),
            },
          },
          actor: userActor(user.id),
          scope: a.project_id ? projectScope(a.org_id, a.project_id) : orgScope(a.org_id),
        },
      ],
      { tx },
    );
  });
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
