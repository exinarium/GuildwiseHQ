import { randomUUID } from 'node:crypto';
import {
  type AssignableOrgRole,
  canAddPeople,
  canChangeOrgRole,
  canInviteOrgMember,
  canRemoveOrgMember,
  canRenameOrg,
  canSetOrgSecurity,
  canTransferOwnership,
  type OrgGuestDto,
  type OrgInvitationDto,
  type OrgMemberDto,
  type OrgRemovalPreview,
  type OrgRole,
  streamId,
} from '@aom/shared';
import { type OrgAccess, orgRoleOf } from '../auth/org-context.ts';
import { verifyPassword } from '../auth/password.ts';
import { disableTwoFactorIn } from '../auth/two-factor.ts';
import type { Ctx } from '../context.ts';
import { randomToken, sha256Hex } from '../crypto.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { userAvatarOf } from '../dto.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { orgInvitationMail } from '../mail/templates.ts';
import { assertWithinLimit } from '../orgs/limits.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { orgScope, projectScope, userActor } from './common.ts';
import { invitationLink } from './invitations.ts';
import { removeMemberIn } from './sharing.ts';

const INVITE_TTL_MS = 7 * 24 * 3600_000;

// ------------------------------------------------------------------------------------------------- org

export async function renameOrg(ctx: Ctx, a: OrgAccess, name: string): Promise<void> {
  if (!canRenameOrg({ orgRole: a.role }))
    throw forbidden('only the Owner and Admins can rename the organization');
  const clean = name.trim();
  if (clean === a.org.name) return;
  await ctx.store.append([
    {
      streamId: streamId.org(a.orgId),
      event: { type: 'OrganizationRenamed', payload: { orgId: a.orgId, name: clean, by: a.session.user.id } },
      actor: userActor(a.session.user.id),
      scope: orgScope(a.orgId),
    },
  ]);
}

/** The Owner requires (or stops requiring) two-factor login of every member (owner decision 7). */
export async function setRequireTwoFactor(ctx: Ctx, a: OrgAccess, required: boolean): Promise<void> {
  if (!canSetOrgSecurity({ orgRole: a.role }))
    throw forbidden('only the Owner can change the security settings');
  if (Boolean(a.org.require_two_factor) === required) return;
  // The Owner is a member too: switching it on without their own two-factor login would lock them out at once.
  if (required && !a.session.twoFactor.enabled)
    throw conflict(
      'owner_two_factor_needed',
      'Set up two-factor login for your own account first, then require it of the organization.',
    );
  await ctx.store.append([
    {
      streamId: streamId.org(a.orgId),
      event: { type: 'OrgTwoFactorPolicySet', payload: { orgId: a.orgId, required, by: a.session.user.id } },
      actor: userActor(a.session.user.id),
      scope: orgScope(a.orgId),
    },
  ]);
}

// ---------------------------------------------------------------------------------------------- members

export async function listMembers(ctx: Ctx, orgId: string): Promise<OrgMemberDto[]> {
  const list = await rows(
    ctx.pool,
    `SELECT om.user_id, om.role, om.joined_at, u.display_name, u.email, u.two_factor_enabled,
            u.avatar_kind, u.avatar_seed, u.avatar_style, u.avatar_image_id
       FROM org_members om JOIN users u ON u.id = om.user_id
      WHERE om.org_id=$1 AND om.status='active'
      ORDER BY (om.role='owner') DESC, (om.role='admin') DESC, lower(u.display_name)`,
    [orgId],
  );
  const projects = await rows(
    ctx.pool,
    `SELECT pm.user_id, p.id, p.key, p.name FROM project_members pm JOIN projects p ON p.id = pm.project_id
      WHERE p.org_id=$1 AND p.kind='project' AND pm.status='active' AND pm.direct AND p.status='active' ORDER BY p.key`,
    [orgId],
  );
  return list.map((m) => ({
    userId: m.user_id,
    displayName: m.display_name,
    email: m.email,
    role: m.role,
    joinedAt: iso(m.joined_at) as string,
    allProjects: m.role === 'owner' || m.role === 'admin',
    projects: projects
      .filter((p) => p.user_id === m.user_id)
      .map((p) => ({ id: p.id, key: p.key, name: p.name })),
    twoFactorEnabled: Boolean(m.two_factor_enabled),
    avatar: userAvatarOf(m),
  }));
}

export async function listGuests(ctx: Ctx, orgId: string): Promise<OrgGuestDto[]> {
  const r = await rows(
    ctx.pool,
    `SELECT pm.user_id, u.display_name, u.email, p.id, p.key, p.name, pm.joined_at
       FROM project_members pm JOIN projects p ON p.id = pm.project_id JOIN users u ON u.id = pm.user_id
      WHERE p.org_id=$1 AND p.kind='project' AND pm.status='active' AND pm.direct
        AND NOT EXISTS (SELECT 1 FROM org_members om WHERE om.org_id = p.org_id AND om.user_id = pm.user_id AND om.status='active')
      ORDER BY lower(u.display_name), p.key`,
    [orgId],
  );
  const byUser = new Map<string, OrgGuestDto>();
  for (const x of r) {
    const g: OrgGuestDto = byUser.get(x.user_id) ?? {
      userId: x.user_id,
      displayName: x.display_name,
      email: x.email,
      projects: [] as OrgGuestDto['projects'],
      since: iso(x.joined_at),
    };
    g.projects.push({ id: x.id, key: x.key, name: x.name });
    const at = iso(x.joined_at);
    if (at && (!g.since || at < g.since)) g.since = at;
    byUser.set(x.user_id, g);
  }
  return [...byUser.values()];
}

async function activeMember(db: Queryable, orgId: string, userId: string): Promise<Row> {
  const m = await one(
    db,
    `SELECT om.*, u.display_name, u.email FROM org_members om JOIN users u ON u.id = om.user_id
      WHERE om.org_id=$1 AND om.user_id=$2 AND om.status='active'`,
    [orgId, userId],
  );
  if (!m) throw notFound('member not found');
  return m;
}

export async function changeMemberRole(
  ctx: Ctx,
  a: OrgAccess,
  userId: string,
  role: AssignableOrgRole,
): Promise<void> {
  if (!canChangeOrgRole({ orgRole: a.role })) throw forbidden('only the Owner can promote and demote Admins');
  await withAppendTx(ctx.pool, async (tx) => {
    const m = await activeMember(tx, a.orgId, userId);
    if (m.role === 'owner')
      throw conflict('owner_role_via_transfer', 'the Owner role moves by transferring ownership');
    if (m.role === role) return;
    await ctx.store.append(
      [
        {
          streamId: streamId.org(a.orgId),
          event: {
            type: 'OrgMemberRoleChanged',
            payload: { orgId: a.orgId, userId, role, by: a.session.user.id },
          },
          actor: userActor(a.session.user.id),
          scope: orgScope(a.orgId),
        },
      ],
      { tx },
    );
  });
}

/**
 * What removing a member from the organization hands back (shown before confirming): their projects, the agents they
 * manage and the cards those hold, the cards they own.
 */
export async function removalPreview(ctx: Ctx, a: OrgAccess, userId: string): Promise<OrgRemovalPreview> {
  const m = await activeMember(ctx.pool, a.orgId, userId);
  const plan = await memberPlan(ctx.pool, a.orgId, userId);
  return {
    userId,
    displayName: m.display_name,
    projects: plan.projects.map((p) => ({ key: p.key, name: p.name })),
    agents: plan.agents.map((x) => ({ id: x.id, name: x.name, roleKey: x.role_key })),
    releasedCards: plan.claimed.map((c) => ({ ref: c.ref, title: c.title })),
    transferredCards: plan.owned.map((c) => ({ ref: c.ref, title: c.title, status: c.status })),
  };
}

async function memberPlan(db: Queryable, orgId: string, userId: string) {
  const projects = await rows<Row & { id: string; key: string; name: string }>(
    db,
    `SELECT p.* FROM project_members pm JOIN projects p ON p.id = pm.project_id
      WHERE p.org_id=$1 AND pm.user_id=$2 AND pm.status <> 'removed' ORDER BY p.key`,
    [orgId, userId],
  );
  const agents = await rows(
    db,
    `SELECT a.id, a.name, a.role_key, a.workstation_id FROM agents a
      WHERE a.org_id=$1 AND a.manager_user_id=$2 AND a.status IN ('active','needs_rehome') AND NOT a.is_devops
      ORDER BY a.hired_at`,
    [orgId, userId],
  );
  const claimed = await rows(
    db,
    `SELECT c.* FROM cards c WHERE c.org_id=$1 AND c.claim_id IS NOT NULL AND c.claimed_by_agent_id = ANY($2::uuid[])`,
    [orgId, agents.map((x) => x.id)],
  );
  const owned = await rows(
    db,
    `SELECT id, ref, title, status FROM cards WHERE org_id=$1 AND owner_user_id=$2 ORDER BY ref`,
    [orgId, userId],
  );
  return { projects, agents, claimed, owned };
}

/**
 * Takes the member out of the organization, inside the caller's transaction (docs/design/organizations.md section 8.3):
 * `ProjectMemberRemoved` for each project they hold (claims released, their cards and project agents handed to the
 * Owner), their org-wide agents' claims released, the DevOps engineers of their workstations in this organization
 * retired, then `OrgMemberRemoved`. Their other organizations are untouched.
 */
export async function removeOrgMemberIn(
  ctx: Ctx,
  tx: Tx,
  actorId: string,
  orgId: string,
  userId: string,
  reason: 'removed' | 'left' | 'deactivated',
): Promise<void> {
  const plan = await memberPlan(tx, orgId, userId);
  for (const p of plan.projects) {
    await removeMemberIn(ctx, tx, actorId, p, userId, { includeGrant: true });
  }
  // Org-wide agents: their claims go back to the queue; the projector hands the agents to the Owner (`needs_rehome`).
  const events: AppendInput[] = [];
  const orgWide = plan.agents;
  const stillClaimed = await rows(
    tx,
    `SELECT c.* FROM cards c WHERE c.org_id=$1 AND c.claim_id IS NOT NULL AND c.claimed_by_agent_id = ANY($2::uuid[])`,
    [orgId, orgWide.map((x) => x.id)],
  );
  for (const c of stillClaimed) {
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
      actor: userActor(actorId),
      scope: projectScope(c.org_id, c.project_id),
    });
  }
  // The DevOps engineers on their workstations belong to this organization only while they are in it.
  const devops = await rows(
    tx,
    `SELECT a.id, a.workstation_id FROM agents a JOIN workstations w ON w.id = a.workstation_id
      WHERE a.org_id=$1 AND a.is_devops AND a.status='active' AND w.user_id=$2`,
    [orgId, userId],
  );
  for (const d of devops)
    events.push({
      streamId: streamId.agent(d.id),
      event: { type: 'AgentRetired', payload: { agentId: d.id, by: actorId, releasedCardIds: [] } },
      actor: userActor(actorId),
      scope: orgScope(orgId),
    });
  events.push({
    streamId: streamId.org(orgId),
    event: { type: 'OrgMemberRemoved', payload: { orgId, userId, reason, by: actorId } },
    actor: userActor(actorId),
    scope: orgScope(orgId),
  });
  await ctx.store.append(events, { tx });
  for (const a of plan.agents)
    if (a.workstation_id) await enqueueRunnerCommand(tx, a.workstation_id, 'agent.wipe', { agentId: a.id });
  for (const d of devops)
    if (d.workstation_id) await enqueueRunnerCommand(tx, d.workstation_id, 'agent.wipe', { agentId: d.id });
}

export async function removeOrgMember(ctx: Ctx, a: OrgAccess, userId: string): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const m = await activeMember(tx, a.orgId, userId);
    if (m.role === 'owner')
      throw conflict('owner_cannot_leave', 'the Owner cannot be removed: transfer the ownership first');
    if (!canRemoveOrgMember({ orgRole: a.role }, m.role as OrgRole))
      throw forbidden(
        m.role === 'admin' ? 'only the Owner can remove an Admin' : 'you cannot remove this member',
      );
    await removeOrgMemberIn(ctx, tx, a.session.user.id, a.orgId, userId, 'removed');
  });
}

export async function leaveOrg(ctx: Ctx, a: OrgAccess): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    if (a.role === 'owner')
      throw conflict('owner_cannot_leave', 'the Owner cannot leave: transfer the ownership first');
    await removeOrgMemberIn(ctx, tx, a.session.user.id, a.orgId, a.session.user.id, 'left');
  });
}

/** Replaces the projects a Member works in (Owners and Admins see all of them): adds are active at once. */
export async function setMemberProjects(
  ctx: Ctx,
  a: OrgAccess,
  userId: string,
  projectIds: string[],
): Promise<void> {
  if (!canAddPeople({ orgRole: a.role }))
    throw forbidden('only the Owner and Admins can give people access to projects');
  await withAppendTx(ctx.pool, async (tx) => {
    const m = await activeMember(tx, a.orgId, userId);
    if (m.role !== 'member')
      throw badRequest('not_a_member_role', 'Owners and Admins already see every project');
    const valid = await rows<{ id: string }>(
      tx,
      `SELECT id FROM projects WHERE org_id=$1 AND kind='project' AND status='active' AND id = ANY($2::uuid[])`,
      [a.orgId, projectIds],
    );
    if (valid.length !== new Set(projectIds).size)
      throw badRequest('unknown_project', 'a project does not belong to this organization');
    const current = await rows<{ project_id: string; status: string }>(
      tx,
      `SELECT pm.project_id, pm.status FROM project_members pm JOIN projects p ON p.id = pm.project_id
        WHERE p.org_id=$1 AND p.kind='project' AND pm.user_id=$2 AND pm.status <> 'removed'`,
      [a.orgId, userId],
    );
    const have = new Set(current.map((c) => c.project_id));
    for (const id of new Set(projectIds)) {
      if (have.has(id)) continue;
      await ctx.store.append(
        [
          {
            streamId: streamId.project(id),
            event: {
              type: 'ProjectMemberAdded',
              payload: { projectId: id, userId, addedBy: a.session.user.id },
            },
            actor: userActor(a.session.user.id),
            scope: projectScope(a.orgId, id),
          },
        ],
        { tx },
      );
    }
    for (const c of current) {
      if (projectIds.includes(c.project_id)) continue;
      const p = await one(tx, 'SELECT * FROM projects WHERE id=$1', [c.project_id]);
      if (p) await removeMemberIn(ctx, tx, a.session.user.id, p, userId);
    }
  });
}

// ---------------------------------------------------------------------------------------------- ownership

/** The Owner hands the organization to an active member or admin (password re-entry); they become an Admin. */
export async function transferOwnership(
  ctx: Ctx,
  a: OrgAccess,
  toUserId: string,
  password: string,
): Promise<void> {
  if (!canTransferOwnership({ orgRole: a.role }))
    throw forbidden('only the Owner can transfer the ownership');
  const u = await one(ctx.pool, 'SELECT password_hash FROM users WHERE id=$1', [a.session.user.id]);
  if (!u || !(await verifyPassword(u.password_hash, password)))
    throw badRequest('wrong_password', 'the password is incorrect');
  if (toUserId === a.session.user.id) throw badRequest('same_user', 'choose another member');
  await withAppendTx(ctx.pool, async (tx) => {
    const target = await activeMember(tx, a.orgId, toUserId);
    const owner = await one(
      tx,
      `SELECT user_id FROM org_members WHERE org_id=$1 AND role='owner' AND status='active'`,
      [a.orgId],
    );
    if (owner?.user_id !== a.session.user.id) throw forbidden('only the Owner can transfer the ownership');
    const toUser = await one(tx, 'SELECT status FROM users WHERE id=$1', [target.user_id]);
    if (toUser?.status !== 'active') throw conflict('user_inactive', 'that account is deactivated');
    await ctx.store.append(
      [
        {
          streamId: streamId.org(a.orgId),
          event: {
            type: 'OrgOwnershipTransferred',
            payload: { orgId: a.orgId, fromUserId: a.session.user.id, toUserId },
          },
          actor: userActor(a.session.user.id),
          scope: orgScope(a.orgId),
        },
      ],
      { tx },
    );
  });
}

/** An Owner resets a member's two-factor login (lost phone and recovery codes): they set it up again at next sign-in. */
export async function resetMemberTwoFactor(ctx: Ctx, a: OrgAccess, userId: string): Promise<void> {
  if (a.role !== 'owner') throw forbidden('only the Owner can reset a member’s two-factor login');
  await withAppendTx(ctx.pool, async (tx) => {
    await activeMember(tx, a.orgId, userId);
    const has = await one(tx, 'SELECT two_factor_enabled FROM users WHERE id=$1', [userId]);
    if (!has?.two_factor_enabled) throw conflict('two_factor_off', 'this member has no two-factor login');
    await disableTwoFactorIn(ctx, tx, userId, a.session.user.id, 'reset', userActor(a.session.user.id));
    await tx.query('DELETE FROM auth_sessions WHERE user_id=$1', [userId]);
  });
  ctx.services.browser.closeUser(userId);
}

// ----------------------------------------------------------------------------------------- invitations

const toInvitationDto = (r: Row): OrgInvitationDto => ({
  id: r.id,
  email: r.email,
  orgRole: r.org_role,
  projectIds: r.project_ids ?? [],
  status: r.status,
  invitedByName: r.invited_by_name ?? null,
  expiresAt: iso(r.expires_at) as string,
  createdAt: iso(r.created_at) as string,
  acceptedAt: iso(r.accepted_at),
});

export async function listOrgInvitations(ctx: Ctx, orgId: string): Promise<OrgInvitationDto[]> {
  const r = await rows(
    ctx.pool,
    `SELECT i.*, u.display_name AS invited_by_name FROM invitations i LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.org_id=$1 AND i.kind='org_member' ORDER BY i.created_at DESC`,
    [orgId],
  );
  return r.map(toInvitationDto);
}

async function sendOrgInvitationMail(
  ctx: Ctx,
  to: string,
  token: string,
  orgName: string,
  role: OrgRole,
  invitedBy: string,
  expiresAt: Date,
) {
  try {
    await ctx.mailer.send(
      orgInvitationMail({ to, link: invitationLink(ctx, token), orgName, role, invitedBy, expiresAt }),
    );
  } catch (err) {
    // The invitation exists; resend once mail is healthy.
    ctx.log.error({ err, to }, 'failed to send organization invitation mail');
  }
}

/** Invites someone to join the organization: Owner (any role) or Admin (Member only). Guests do not count; invitees do. */
export async function inviteOrgMember(
  ctx: Ctx,
  a: OrgAccess,
  input: { email: string; role: AssignableOrgRole; projectIds: string[] },
): Promise<string> {
  if (!canInviteOrgMember({ orgRole: a.role }, input.role))
    throw forbidden(
      input.role === 'admin'
        ? 'only the Owner can invite an Admin'
        : 'only the Owner and Admins can invite members',
    );
  const token = randomToken(32);
  const invitationId = randomUUID();
  const expiresAt = new Date(ctx.clock.now().getTime() + INVITE_TTL_MS);
  await withAppendTx(ctx.pool, async (tx) => {
    const existing = await one(tx, 'SELECT id, status, kind FROM users WHERE lower(email)=lower($1)', [
      input.email,
    ]);
    if (existing?.kind === 'super_admin')
      throw conflict('super_admin_cannot_join', 'platform accounts cannot join organizations');
    if (existing && (await orgRoleOf(tx, existing.id, a.orgId)))
      throw conflict('already_member', 'this person is already a member of the organization');
    if (
      await one(
        tx,
        `SELECT 1 FROM invitations WHERE kind='org_member' AND org_id=$1 AND lower(email)=lower($2) AND status='pending' AND expires_at > $3`,
        [a.orgId, input.email, ctx.clock.now()],
      )
    )
      throw conflict('invitation_pending', 'a pending invitation for this email exists; resend or revoke it');
    await assertWithinLimit(tx, a.orgId, 'members');
    if (input.projectIds.length) {
      const ok = await rows<{ id: string }>(
        tx,
        `SELECT id FROM projects WHERE org_id=$1 AND kind='project' AND status='active' AND id = ANY($2::uuid[])`,
        [a.orgId, input.projectIds],
      );
      if (ok.length !== new Set(input.projectIds).size)
        throw badRequest('unknown_project', 'a project does not belong to this organization');
    }
    await ctx.store.append(
      [
        {
          streamId: streamId.invitation(invitationId),
          event: {
            type: 'OrgInvitationCreated',
            payload: {
              invitationId,
              kind: 'org_member',
              email: input.email,
              orgId: a.orgId,
              orgRole: input.role,
              projectIds: input.role === 'member' ? input.projectIds : [],
              tokenHash: sha256Hex(token),
              expiresAt: expiresAt.toISOString(),
              invitedBy: a.session.user.id,
            },
          },
          actor: userActor(a.session.user.id),
          scope: orgScope(a.orgId),
        },
      ],
      { tx },
    );
  });
  await sendOrgInvitationMail(
    ctx,
    input.email,
    token,
    a.org.name,
    input.role,
    a.session.user.displayName,
    expiresAt,
  );
  return invitationId;
}

async function ownInvitation(tx: Queryable, a: OrgAccess, id: string): Promise<Row> {
  const inv = await one(
    tx,
    `SELECT * FROM invitations WHERE id=$1 AND org_id=$2 AND kind='org_member' FOR UPDATE`,
    [id, a.orgId],
  );
  if (!inv) throw notFound('invitation not found');
  if (inv.status !== 'pending') throw conflict('invitation_not_pending', `invitation is ${inv.status}`);
  if (inv.org_role === 'admin' && a.role !== 'owner')
    throw forbidden('only the Owner can manage an Admin invitation');
  return inv;
}

export async function resendOrgInvitation(ctx: Ctx, a: OrgAccess, invitationId: string): Promise<void> {
  if (!canAddPeople({ orgRole: a.role })) throw forbidden('only the Owner and Admins can invite');
  const token = randomToken(32);
  const expiresAt = new Date(ctx.clock.now().getTime() + INVITE_TTL_MS);
  const inv = await withAppendTx(ctx.pool, async (tx) => {
    const i = await ownInvitation(tx, a, invitationId);
    await ctx.store.append(
      [
        {
          streamId: streamId.invitation(invitationId),
          event: {
            type: 'InvitationResent',
            payload: { invitationId, tokenHash: sha256Hex(token), expiresAt: expiresAt.toISOString() },
          },
          actor: userActor(a.session.user.id),
          scope: orgScope(a.orgId),
        },
      ],
      { tx },
    );
    return i;
  });
  await sendOrgInvitationMail(
    ctx,
    inv.email,
    token,
    a.org.name,
    inv.org_role,
    a.session.user.displayName,
    expiresAt,
  );
}

export async function revokeOrgInvitation(ctx: Ctx, a: OrgAccess, invitationId: string): Promise<void> {
  if (!canAddPeople({ orgRole: a.role })) throw forbidden('only the Owner and Admins can invite');
  await withAppendTx(ctx.pool, async (tx) => {
    await ownInvitation(tx, a, invitationId);
    await ctx.store.append(
      [
        {
          streamId: streamId.invitation(invitationId),
          event: { type: 'InvitationRevoked', payload: { invitationId } },
          actor: userActor(a.session.user.id),
          scope: orgScope(a.orgId),
        },
      ],
      { tx },
    );
  });
}
