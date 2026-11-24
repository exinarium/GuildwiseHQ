import { randomBytes, randomUUID } from 'node:crypto';
import {
  type AssignableOrgRole,
  canAddPeople,
  canChangeOrgRole,
  canInviteOrgMember,
  canRemoveOrgMember,
  canRenameOrg,
  canSetOrgMode,
  canSetOrgSecurity,
  canTransferOwnership,
  DIAGNOSTICS_CONSENT_VERSION,
  INVITE_LIMIT,
  MEMBER_HAS_OTHER_ACCESS,
  OFFBOARDING_GRACE_DAYS,
  type OffboardingReport,
  type OrgGuestDto,
  type OrgInvitationDto,
  type OrgMemberDto,
  type OrgMode,
  type OrgRemovalPreview,
  type OrgRole,
  PENDING_INVITATIONS_CAP,
  streamId,
} from '@aom/shared';
import { type OrgAccess, orgRoleOf } from '../auth/org-context.ts';
import { hashPassword, verifyPassword } from '../auth/password.ts';
import { hasOtherAccess } from '../authz/other-access.ts';
import { ceoOwnerChangeEvents } from '../ceo/provision.ts';
import { withdrawTopicsOfOrgs } from '../ceo/topics-handoff.ts';
import type { Ctx } from '../context.ts';
import { randomToken, sha256Hex } from '../crypto.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx, withTx } from '../db/tx.ts';
import { userAvatarOf } from '../dto.ts';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import {
  type OffboardingRun,
  offboardingFacts,
  previewSteps,
  runOffboardingIn,
} from '../governance/offboarding.ts';
import { senderName } from '../mail/layout.ts';
import type { MailMessage } from '../mail/mailer.ts';
import { memberResetNoticeMail, orgInvitationMail, passwordResetMail } from '../mail/templates.ts';
import { diagnosticsConsentAvailable } from '../orgs/diagnostics.ts';
import { assertWithinLimit } from '../orgs/limits.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { orgScope, projectScope, userActor } from './common.ts';
import { assertAddressAccepted, invitationLink } from './invitations.ts';
import { issue as issueResetLink, resetLink } from './password-reset.ts';
import { removeMemberIn } from './sharing.ts';
import { mailOwnerTwoFactorReset, scheduleOwnerTwoFactorReset } from './two-factor-recovery.ts';

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

/**
 * The Owner switches the organization-level consent "Share diagnostic data with Guildwise" on or off (docs/design/
 * ceo-blog-topics.md section 11). Owner only. Customer organizations cannot set it until the consent text has been
 * reviewed (POPIA): the server flag `AOM_DIAGNOSTICS_CONSENT_CUSTOMERS` stays off until then. Turning it on needs the
 * version of the consent text the Owner saw, so the recorded consent names the words that were agreed to.
 */
export async function setDiagnosticsSharing(
  ctx: Ctx,
  a: OrgAccess,
  on: boolean,
  consentVersion: string | undefined,
): Promise<void> {
  if (!canSetOrgSecurity({ orgRole: a.role }))
    throw forbidden('only the Owner can change the diagnostic data consent');
  if (!(await diagnosticsConsentAvailable(ctx, a.orgId)))
    throw forbidden('sharing diagnostic data is not available for this organization yet');
  if (Boolean(a.org.diagnostics_sharing) === on) return;
  if (on && consentVersion !== DIAGNOSTICS_CONSENT_VERSION)
    throw conflict(
      'consent_version',
      'The consent text has changed. Read the current text and confirm again.',
    );
  await ctx.store.append([
    {
      streamId: streamId.org(a.orgId),
      event: {
        type: 'OrgDiagnosticsSharingSet',
        payload: {
          orgId: a.orgId,
          on,
          consentVersion: on ? DIAGNOSTICS_CONSENT_VERSION : (consentVersion ?? DIAGNOSTICS_CONSENT_VERSION),
          by: a.session.user.id,
        },
      },
      actor: userActor(a.session.user.id),
      scope: orgScope(a.orgId),
    },
  ]);
  // Withdrawal: topics that were handed on but not yet written are taken out of the blog queue now, not at the next sweep.
  if (!on) await withdrawTopicsOfOrgs(ctx, a.orgId);
}

/**
 * Owner and Admins set the organization's DEFAULT VIEW (Software or Business). A view is presentation only: it is never
 * refused, installs and removes nothing, and touches no project, repository, agent, deploy or card. It appends the one
 * preference event and nothing else.
 */
export async function setOrgMode(ctx: Ctx, a: OrgAccess, mode: OrgMode): Promise<void> {
  if (!canSetOrgMode({ orgRole: a.role }))
    throw forbidden('only the Owner and Admins can change the default view of the organization');
  await withAppendTx(ctx.pool, async (tx) => {
    const cur = await one<{ mode: OrgMode }>(tx, 'SELECT mode FROM organizations WHERE id=$1 FOR UPDATE', [
      a.orgId,
    ]);
    const previous: OrgMode = cur?.mode === 'business' ? 'business' : 'dev';
    if (previous === mode) return;
    await ctx.store.append(
      [
        {
          streamId: streamId.org(a.orgId),
          event: { type: 'OrgModeSet', payload: { orgId: a.orgId, mode, previous, by: a.session.user.id } },
          actor: userActor(a.session.user.id),
          scope: orgScope(a.orgId),
        },
      ],
      { tx },
    );
  });
}

/**
 * A member chooses the view they see in this organization (`null`: follow the organization default). Any member may do
 * it for themselves, at any time. Stored on the membership (`org_members.view`), so a user in several organizations
 * can use a different view in each. Appends the one preference event and nothing else.
 */
export async function setMemberView(ctx: Ctx, a: OrgAccess, view: OrgMode | null): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const cur = await one<{ view: OrgMode | null }>(
      tx,
      `SELECT view FROM org_members WHERE org_id=$1 AND user_id=$2 AND status='active' FOR UPDATE`,
      [a.orgId, a.session.user.id],
    );
    if (!cur) throw forbidden('you are not a member of this organization');
    const previous = cur.view ?? null;
    if (previous === view) return;
    await ctx.store.append(
      [
        {
          streamId: streamId.org(a.orgId),
          event: {
            type: 'OrgMemberViewSet',
            payload: { orgId: a.orgId, userId: a.session.user.id, view, previous },
          },
          actor: userActor(a.session.user.id),
          scope: orgScope(a.orgId),
        },
      ],
      { tx },
    );
  });
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
    offboarding: previewSteps(await offboardingFacts(ctx.pool, a.orgId, userId), {
      agents: plan.agents.length,
      cards: plan.owned.length,
    }),
    privatePurgeDays: OFFBOARDING_GRACE_DAYS,
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
 * Owner), their org-wide agents' claims released, the offboarding checklist run, the DevOps engineers of their
 * workstations in this organization retired (unless the offboarding unlink of their workstations already retired them,
 * so each engineer gets exactly one `AgentRetired`), then `OrgMemberRemoved`. Their other organizations are untouched.
 */
export async function removeOrgMemberIn(
  ctx: Ctx,
  tx: Tx,
  actorId: string,
  orgId: string,
  userId: string,
  reason: 'removed' | 'left' | 'deactivated',
): Promise<OffboardingRun> {
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
  // S-B1: the offboarding checklist (sessions, tokens, pairings, pack credentials, key copies, ownership, private items). Items of
  // the member go to the Owner (not to the Admin who removes them).
  const owner = await one<{ owner_user_id: string }>(
    tx,
    'SELECT owner_user_id FROM organizations WHERE id=$1',
    [orgId],
  );
  const run = await runOffboardingIn(ctx, tx, {
    actorId,
    orgId,
    userId,
    // creator-private sessions and organization packs go to the Owner, not to the Admin who happened to do the removal
    transferTo: owner?.owner_user_id ?? actorId,
    counts: { agents: plan.agents.length, cards: plan.owned.length },
  });
  // A last-organization offboarding unlinks the member's workstations, and the unlink has already retired their DevOps
  // engineers (reason `workstation_unpaired`). Only the ones still active are retired here, so each gets exactly one event.
  const stillActive = devops.length
    ? new Set(
        (
          await rows<{ id: string }>(
            tx,
            `SELECT id FROM agents WHERE id = ANY($1::uuid[]) AND status='active'`,
            [devops.map((d) => d.id)],
          )
        ).map((r) => r.id),
      )
    : new Set<string>();
  for (const d of devops)
    if (stillActive.has(d.id))
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
  return run;
}

/** After the removal committed: queued commands go out and the packs of the member's workstations are re-synced. */
async function afterOffboarding(ctx: Ctx, run: OffboardingRun): Promise<void> {
  const { syncWorkstations } = await import('./packs.ts');
  const ws = [...new Set([...run.deliver, ...run.sync])];
  // their sessions were deleted: an open browser connection must not outlive them
  if (run.signedOutUserId) ctx.services.browser.closeUser(run.signedOutUserId);
  if (run.sync.length)
    await syncWorkstations(ctx, run.sync).catch((err) => ctx.log.warn({ err }, 'pack sync failed'));
  for (const id of ws) await Promise.resolve(ctx.services.gateway.deliverPending(id)).catch(() => undefined);
}

export async function removeOrgMember(ctx: Ctx, a: OrgAccess, userId: string): Promise<OffboardingReport> {
  const run = await withAppendTx(ctx.pool, async (tx) => {
    const m = await activeMember(tx, a.orgId, userId);
    if (m.role === 'owner')
      throw conflict('owner_cannot_leave', 'the Owner cannot be removed: transfer the ownership first');
    if (!canRemoveOrgMember({ orgRole: a.role }, m.role as OrgRole))
      throw forbidden(
        m.role === 'admin' ? 'only the Owner can remove an Admin' : 'you cannot remove this member',
      );
    return removeOrgMemberIn(ctx, tx, a.session.user.id, a.orgId, userId, 'removed');
  });
  await afterOffboarding(ctx, run);
  return run.report;
}

export async function leaveOrg(ctx: Ctx, a: OrgAccess): Promise<void> {
  const run = await withAppendTx(ctx.pool, async (tx) => {
    if (a.role === 'owner')
      throw conflict('owner_cannot_leave', 'the Owner cannot leave: transfer the ownership first');
    return removeOrgMemberIn(ctx, tx, a.session.user.id, a.orgId, a.session.user.id, 'left');
  });
  await afterOffboarding(ctx, run);
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
        ...(await ceoOwnerChangeEvents(tx, a.orgId, toUserId)),
      ],
      { tx },
    );
  });
}

interface ResetMeta {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

const OTHER_ACCESS_MESSAGE =
  'this person also has access to another organization, so their account cannot be reset from here: email them a reset link';

async function refuseOtherAccess(db: Queryable, orgId: string, userId: string): Promise<void> {
  if (await hasOtherAccess(db, orgId, userId)) throw conflict(MEMBER_HAS_OTHER_ACCESS, OTHER_ACCESS_MESSAGE);
}

const actorName = (a: OrgAccess) =>
  senderName({ displayName: a.session.user.displayName, email: a.session.user.email });

async function sendMemberMail(ctx: Ctx, a: OrgAccess, msg: MailMessage): Promise<boolean> {
  try {
    await ctx.mailer.send({ ...msg, orgId: a.orgId });
    return true;
  } catch (err) {
    ctx.log.error({ err }, 'failed to send a member account mail');
    return false;
  }
}

/** Every admin reset mails the person (R6): what, by whom, when and from where. A failed mail never undoes the reset. */
async function mailResetNotice(
  ctx: Ctx,
  a: OrgAccess,
  target: Row,
  what: 'password' | 'two_factor',
  meta: ResetMeta,
): Promise<void> {
  await sendMemberMail(
    ctx,
    a,
    memberResetNoticeMail({
      to: target.email,
      name: target.display_name,
      orgName: a.org.name,
      what,
      by: actorName(a),
      when: ctx.clock.now(),
      ip: meta.ip ?? null,
      origin: ctx.config.publicOrigin,
    }),
  );
}

/**
 * An Owner resets a member's two-factor login (lost phone and recovery codes): they set it up again at next sign-in.
 * Refused first (409 `member_has_other_access`) when the member has access in another organization (R6); otherwise
 * scheduled for 24 hours and mailed (R17-2), so no instant notice with the request's IP is sent here.
 */
export async function resetMemberTwoFactor(ctx: Ctx, a: OrgAccess, userId: string): Promise<void> {
  if (a.role !== 'owner') throw forbidden('only the Owner can reset a member’s two-factor login');
  const scheduled = await withAppendTx(ctx.pool, async (tx) => {
    await activeMember(tx, a.orgId, userId);
    const has = await one(tx, 'SELECT two_factor_enabled FROM users WHERE id=$1', [userId]);
    if (!has?.two_factor_enabled) throw conflict('two_factor_off', 'this member has no two-factor login');
    // R6 (F1): refused when the member has access in another organization.
    await refuseOtherAccess(tx, a.orgId, userId);
    // R17-2: never instantly; the member is mailed and can cancel during the 24-hour wait.
    return scheduleOwnerTwoFactorReset(ctx, tx, userId, { orgId: a.orgId, by: a.session.user.id });
  });
  await mailOwnerTwoFactorReset(ctx, userId, a.session.user.displayName, a.org.name, scheduled);
}

/** Letters and digits without look-alikes (no 0/O, 1/l/I), so a password read out or typed by hand is not misread. */
const TEMP_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A strong random temporary password: 20 characters, about 114 bits. */
export function generateTemporaryPassword(): string {
  const out: string[] = [];
  while (out.length < 20) {
    for (const b of randomBytes(32)) {
      if (b < 256 - (256 % TEMP_ALPHABET.length) && out.length < 20)
        out.push(TEMP_ALPHABET[b % TEMP_ALPHABET.length] as string);
    }
  }
  return out.join('');
}

/**
 * An Owner or Admin sets a temporary password for a member (they lost their password and the reset mail does not reach them).
 * The server makes it, returns it ONCE for the Owner to pass on, and never logs it: only its hash is stored, in an
 * event that carries no clear text. Every session of the member ends, and at next sign-in they must choose their
 * own password before anything else (two-factor still applies). The account is global, so a member with access in
 * another organization is refused (409 `member_has_other_access`, R6): no temporary password is ever made for them,
 * the reset link (`sendMemberPasswordReset`) is the way. The member is mailed about every reset.
 */
export async function resetMemberPassword(
  ctx: Ctx,
  a: OrgAccess,
  userId: string,
  meta: ResetMeta = {},
): Promise<{ temporaryPassword: string }> {
  // Checked before the temporary password exists, so a refused reset never makes one.
  await resettableMember(ctx.pool, a, userId);
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const target = await withAppendTx(ctx.pool, async (tx) => {
    const target = await resettableMember(tx, a, userId, true, true);
    await ctx.store.append(
      [
        {
          streamId: streamId.user(userId),
          event: {
            type: 'MemberPasswordReset',
            payload: { userId, orgId: a.orgId, by: a.session.user.id, passwordHash },
          },
          actor: userActor(a.session.user.id),
          scope: orgScope(a.orgId),
        },
      ],
      { tx },
    );
    await tx.query('DELETE FROM login_challenges WHERE user_id=$1', [userId]);
    await tx.query('DELETE FROM auth_sessions WHERE user_id=$1', [userId]);
    return target;
  });
  ctx.services.browser.closeUser(userId);
  await mailResetNotice(ctx, a, target, 'password', meta);
  return { temporaryPassword };
}

/**
 * The member a password reset may target: active here, a Member for an Admin (an Owner resets Members and Admins), not
 * the caller, not a platform account, not deactivated. With `exclusive` (the temporary password) also refused when the
 * member has access in another organization (R6). `lock` takes the user row lock (inside the reset transaction).
 */
async function resettableMember(
  db: Queryable,
  a: OrgAccess,
  userId: string,
  exclusive = true,
  lock = false,
): Promise<Row> {
  if (a.role !== 'owner' && a.role !== 'admin')
    throw forbidden('only an Owner or an Admin can reset a member’s password');
  if (userId === a.session.user.id)
    throw conflict('use_change_password', 'change your own password under Account, Security');
  const target = await activeMember(db, a.orgId, userId);
  // Owners reset Members and Admins; Admins reset Members only (never an Owner or another Admin).
  if (a.role === 'admin' && target.role !== 'member')
    throw forbidden('an Admin can reset the password of a Member only; ask the Owner');
  const u = await one(db, `SELECT kind, status FROM users WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [userId]);
  if (u?.kind === 'super_admin') throw forbidden('platform accounts are managed on the server');
  if (u?.status !== 'active') throw conflict('user_deactivated', 'this account is deactivated');
  if (exclusive) await refuseOtherAccess(db, a.orgId, userId);
  return target;
}

/** Reset links an Owner or Admin may send one person per hour (R6), counted in the database across organizations. */
const MEMBER_RESET_LINKS_PER_HOUR = 3;

/**
 * "Email a reset link" (R6): an Owner or Admin (same rules as the temporary password) has the server mail the member a
 * single-use link that names this organization. Works for members with access elsewhere too, because only the person
 * themselves can use it. At most 3 an hour per person (429 `too_many_requests`, under a per-person lock); a mail that
 * fails is 502, does not count and leaves the person's earlier links valid (the transaction rolls back); otherwise,
 * like every new link (`issue`), it ends their earlier unused links. Appends `PasswordResetLinkSent{orgId}`.
 */
export async function sendMemberPasswordReset(
  ctx: Ctx,
  a: OrgAccess,
  userId: string,
  meta: ResetMeta = {},
): Promise<{ sentTo: string; expiresAt: string }> {
  const target = await resettableMember(ctx.pool, a, userId, false);
  // One send per person at a time: the count, the new link and the mail run in one transaction on one connection,
  // under a per-person lock that is tried, never waited for. A request that finds it held answers 429 at once, so
  // parallel requests can neither pass the limit together nor pile up holding pool connections.
  const { expiresAt } = await withTx(ctx.pool, async (tx) => {
    const got = await one<{ ok: boolean }>(
      tx,
      `SELECT pg_try_advisory_xact_lock(hashtext('member_reset:' || $1::text)) AS ok`,
      [userId],
    );
    if (!got?.ok)
      throw new HttpError(
        429,
        'too_many_requests',
        'a reset link for this person is being sent; try again in a moment',
      );
    const recent = await one<{ n: number }>(
      tx,
      `SELECT count(*)::int AS n FROM password_resets WHERE user_id=$1 AND requested_by IS NOT NULL AND created_at > $2`,
      [userId, new Date(ctx.clock.now().getTime() - 3600_000)],
    );
    if ((recent?.n ?? 0) >= MEMBER_RESET_LINKS_PER_HOUR)
      throw new HttpError(
        429,
        'too_many_requests',
        'a reset link was sent to this person 3 times in the last hour',
      );
    const link = await issueResetLink(ctx, userId, a.session.user.id, meta.ip ?? null, tx);
    const sent = await sendMemberMail(
      ctx,
      a,
      passwordResetMail({
        to: target.email,
        name: target.display_name,
        link: resetLink(ctx, link.token),
        expiresAt: link.expiresAt,
        origin: ctx.config.publicOrigin,
        byOrg: a.org.name,
      }),
    );
    // throwing rolls the transaction back: no new link, and the earlier unused links stay valid
    if (!sent) throw new HttpError(502, 'mail_failed', 'the email could not be sent; try again in a moment');
    return link;
  });
  await ctx.store.append([
    {
      streamId: streamId.user(userId),
      event: {
        type: 'PasswordResetLinkSent',
        payload: {
          userId,
          by: a.session.user.id,
          orgId: a.orgId,
          meta: {
            ...(meta.ip ? { ip: meta.ip } : {}),
            ...(meta.userAgent ? { userAgent: meta.userAgent.slice(0, 400) } : {}),
          },
        },
      },
      actor: userActor(a.session.user.id),
      scope: orgScope(a.orgId),
    },
  ]);
  return { sentTo: target.email, expiresAt: expiresAt.toISOString() };
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
  orgId: string,
) {
  try {
    await ctx.mailer.send({
      ...orgInvitationMail({
        to,
        link: invitationLink(ctx, token),
        orgName,
        role,
        invitedBy,
        expiresAt,
        origin: ctx.config.publicOrigin,
      }),
      orgId,
    });
  } catch (err) {
    // The invitation exists; resend once mail is healthy.
    ctx.log.error({ err, to }, 'failed to send organization invitation mail');
  }
}

const HOUR_MS = 3600_000;
/** Resends of one invitation per hour (R10). */
const RESENDS_PER_HOUR = 3;

/**
 * The invitation limits (R10, audit F5), counted in the database under a per-organization lock: invitations per
 * organization per hour and per actor per day (429 `invite_limit`), and pending invitations per organization (409
 * `pending_invitations_cap`). Defaults 20, 50 and 50 (`AOM_INVITE_PER_ORG_HOUR`, `_PER_ACTOR_DAY`, `_PENDING_MAX`).
 */
async function assertInviteLimits(ctx: Ctx, tx: Tx, a: OrgAccess): Promise<void> {
  const now = ctx.clock.now().getTime();
  const limits = ctx.config.invites;
  const c = await one<{ org_hour: number; actor_day: number; pending: number }>(
    tx,
    `SELECT
       (SELECT count(*)::int FROM invitations WHERE kind='org_member' AND org_id=$1 AND created_at > $3) AS org_hour,
       (SELECT count(*)::int FROM invitations WHERE kind='org_member' AND invited_by=$2 AND created_at > $4) AS actor_day,
       (SELECT count(*)::int FROM invitations
         WHERE kind='org_member' AND org_id=$1 AND status='pending' AND expires_at > $5) AS pending`,
    [a.orgId, a.session.user.id, new Date(now - HOUR_MS), new Date(now - 24 * HOUR_MS), new Date(now)],
  );
  if ((c?.org_hour ?? 0) >= limits.perOrgHour)
    throw new HttpError(
      429,
      INVITE_LIMIT,
      'too many invitations from this organization in the last hour; try later',
      {
        scope: 'org_hour',
        limit: limits.perOrgHour,
      },
    );
  if ((c?.actor_day ?? 0) >= limits.perActorDay)
    throw new HttpError(429, INVITE_LIMIT, 'you sent too many invitations in the last 24 hours; try later', {
      scope: 'actor_day',
      limit: limits.perActorDay,
    });
  if ((c?.pending ?? 0) >= limits.pendingMax)
    throw conflict(
      PENDING_INVITATIONS_CAP,
      'this organization has too many pending invitations; revoke some or wait until they are accepted',
      { limit: limits.pendingMax },
    );
}

/** A platform (super admin) account: it is invited like anyone else, but no mail goes out and accept refuses (R8, F3). */
async function isPlatformAccount(db: Queryable, email: string): Promise<boolean> {
  return (
    (await one(db, `SELECT kind FROM users WHERE lower(email)=lower($1)`, [email]))?.kind === 'super_admin'
  );
}

/**
 * Invites someone to join the organization: Owner (any role) or Admin (Member only). Guests do not count; invitees do.
 * The address is screened (R1) and the invitation limits apply (R10). A platform account's email gets the same answer
 * as any other (201, listed) but no mail (R8).
 */
export async function inviteOrgMember(
  ctx: Ctx,
  a: OrgAccess,
  input: { email: string; role: AssignableOrgRole; projectIds: string[] },
  meta: { ip?: string | undefined } = {},
): Promise<string> {
  if (!canInviteOrgMember({ orgRole: a.role }, input.role))
    throw forbidden(
      input.role === 'admin'
        ? 'only the Owner can invite an Admin'
        : 'only the Owner and Admins can invite members',
    );
  await assertAddressAccepted(ctx, input.email, meta.ip);
  const token = randomToken(32);
  const invitationId = randomUUID();
  const expiresAt = new Date(ctx.clock.now().getTime() + INVITE_TTL_MS);
  const silent = await withAppendTx(ctx.pool, async (tx) => {
    // One invitation of an organization at a time, so concurrent invites cannot all pass the limits.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('org_invitations:' || $1::text))`, [a.orgId]);
    const existing = await one(tx, 'SELECT id, status, kind FROM users WHERE lower(email)=lower($1)', [
      input.email,
    ]);
    if (existing && existing.kind !== 'super_admin' && (await orgRoleOf(tx, existing.id, a.orgId)))
      throw conflict('already_member', 'this person is already a member of the organization');
    if (
      await one(
        tx,
        `SELECT 1 FROM invitations WHERE kind='org_member' AND org_id=$1 AND lower(email)=lower($2) AND status='pending' AND expires_at > $3`,
        [a.orgId, input.email, ctx.clock.now()],
      )
    )
      throw conflict('invitation_pending', 'a pending invitation for this email exists; resend or revoke it');
    await assertInviteLimits(ctx, tx, a);
    await assertWithinLimit(ctx, tx, a.orgId, 'members');
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
    return existing?.kind === 'super_admin';
  });
  // Never awaited, for anyone: a platform account (no mail) and anyone else answer in the same time (R8).
  if (!silent)
    void sendOrgInvitationMail(
      ctx,
      input.email,
      token,
      a.org.name,
      input.role,
      // The inviter's display name; the mail names the organization separately.
      senderName({ displayName: a.session.user.displayName, email: a.session.user.email }),
      expiresAt,
      a.orgId,
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

/** Resends a pending invitation: at most 3 an hour per invitation (429 `invite_limit`), screened again (R1, R10). */
export async function resendOrgInvitation(
  ctx: Ctx,
  a: OrgAccess,
  invitationId: string,
  meta: { ip?: string | undefined } = {},
): Promise<void> {
  if (!canAddPeople({ orgRole: a.role })) throw forbidden('only the Owner and Admins can invite');
  const token = randomToken(32);
  const expiresAt = new Date(ctx.clock.now().getTime() + INVITE_TTL_MS);
  const inv = await withAppendTx(ctx.pool, async (tx) => {
    const i = await ownInvitation(tx, a, invitationId);
    await assertAddressAccepted(ctx, i.email, meta.ip);
    const resent = await one<{ n: number }>(
      tx,
      `SELECT count(*)::int AS n FROM events WHERE stream_id=$1 AND type='InvitationResent' AND created_at > $2`,
      [streamId.invitation(invitationId), new Date(ctx.clock.now().getTime() - HOUR_MS)],
    );
    if ((resent?.n ?? 0) >= RESENDS_PER_HOUR)
      throw new HttpError(
        429,
        INVITE_LIMIT,
        'this invitation was resent 3 times in the last hour; try later',
        {
          scope: 'resend_hour',
          limit: RESENDS_PER_HOUR,
        },
      );
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
    const silent = await isPlatformAccount(tx, i.email);
    return { ...i, silent } as Row;
  });
  // Never awaited, as at invite (R8): the answer takes the same time whether a mail goes out or not.
  if (!inv.silent)
    void sendOrgInvitationMail(
      ctx,
      inv.email,
      token,
      a.org.name,
      inv.org_role,
      // The inviter's display name; the mail names the organization separately.
      senderName({ displayName: a.session.user.displayName, email: a.session.user.email }),
      expiresAt,
      a.orgId,
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
