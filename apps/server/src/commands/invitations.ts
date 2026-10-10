import { randomUUID } from 'node:crypto';
import {
  type InvitationInfoResponse,
  type NewOrgInvitationRequest,
  NO_LIMITS,
  type OrgLimits,
  type OrgRole,
  type PlatformInvitationDto,
  planDefinition,
  streamId,
} from '@aom/shared';
import { hashPassword } from '../auth/password.ts';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { randomToken, sha256Hex } from '../crypto.ts';
import { iso, one, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { senderName, TEAM } from '../mail/layout.ts';
import { newOrgInvitationMail } from '../mail/templates.ts';
import { assertWithinLimit } from '../orgs/limits.ts';
import { orgScope, userScope } from './common.ts';
import { hireDevopsForOrgIn } from './devops.ts';
import { notifySignup } from './platform-notify.ts';

const INVITE_TTL_MS = 7 * 24 * 3600_000;
const ADMIN_SCOPE = { orgId: null, projectId: null, audience: 'admin' } as const;

export const invitationLink = (ctx: Ctx, token: string) => `${ctx.config.publicOrigin}/invite/${token}`;

interface Meta {
  ip?: string | undefined;
  userAgent?: string | undefined;
}
const metaOf = (m?: Meta) => (m && (m.ip || m.userAgent) ? { meta: { ...m } } : {});

// ------------------------------------------------------------------------------ platform: new organizations

/** One line for the accept page and the mail: what the invitee gets. */
export function describeTerms(t: {
  plan?: string;
  status?: string;
  trialEndsAt?: string | null;
  licenseExpiresAt?: string | null;
}): string {
  const plan = `${planDefinition(t.plan ?? 'founding').name} plan`;
  const day = (d: string) => d.slice(0, 10);
  if (t.status === 'trial' && t.trialEndsAt) return `${plan}, trial until ${day(t.trialEndsAt)}`;
  if (t.licenseExpiresAt) return `${plan}, licence until ${day(t.licenseExpiresAt)}`;
  return plan;
}

async function sendNewOrgMail(
  ctx: Ctx,
  to: string,
  token: string,
  orgName: string,
  terms: string,
  invitedBy: string,
  expiresAt: Date,
) {
  try {
    await ctx.mailer.send(
      newOrgInvitationMail({
        to,
        link: invitationLink(ctx, token),
        orgName,
        terms,
        invitedBy,
        expiresAt,
        origin: ctx.config.publicOrigin,
      }),
    );
  } catch (err) {
    ctx.log.error({ err, to }, 'failed to send invitation mail');
  }
}

/** A super admin invites someone to start an organization with the given terms (no account needed yet). */
export async function inviteNewOrg(
  ctx: Ctx,
  admin: AuthSession,
  input: NewOrgInvitationRequest,
  meta?: Meta,
): Promise<string> {
  const token = randomToken(32);
  const invitationId = randomUUID();
  const expiresAt = new Date(ctx.clock.now().getTime() + INVITE_TTL_MS);
  const plan = planDefinition(input.plan);
  const terms = {
    plan: input.plan,
    status: input.status,
    limits: input.limits ?? plan.limits,
    trialEndsAt: input.status === 'trial' ? (input.trialEndsAt ?? null) : null,
    licenseExpiresAt: input.licenseExpiresAt ?? null,
    features: Object.fromEntries(Object.entries(input.features ?? {}).filter(([, v]) => v !== null)),
  };
  if (terms.status === 'trial' && !terms.trialEndsAt)
    throw conflict('trial_needs_end', 'a trial needs an end date');
  await withAppendTx(ctx.pool, async (tx) => {
    const user = await one(tx, 'SELECT id, kind FROM users WHERE lower(email)=lower($1)', [input.email]);
    if (user?.kind === 'super_admin')
      throw conflict('super_admin_exists', 'that email belongs to a platform account');
    if (
      await one(
        tx,
        `SELECT 1 FROM invitations WHERE kind='new_org' AND lower(email)=lower($1) AND status='pending' AND expires_at > $2`,
        [input.email, ctx.clock.now()],
      )
    )
      throw conflict('invitation_pending', 'a pending invitation for this email exists; resend or revoke it');
    await ctx.store.append(
      [
        {
          streamId: streamId.invitation(invitationId),
          event: {
            type: 'OrgInvitationCreated',
            payload: {
              invitationId,
              kind: 'new_org',
              email: input.email,
              orgRole: 'owner',
              proposedOrgName: input.proposedOrgName,
              orgTerms: terms,
              projectIds: [],
              tokenHash: sha256Hex(token),
              expiresAt: expiresAt.toISOString(),
              invitedBy: admin.user.id,
              ...metaOf(meta),
            },
          },
          actor: { kind: 'user', id: admin.user.id },
          scope: ADMIN_SCOPE,
        },
      ],
      { tx },
    );
  });
  await sendNewOrgMail(ctx, input.email, token, input.proposedOrgName, describeTerms(terms), TEAM, expiresAt);
  return invitationId;
}

const toPlatformDto = (r: Row): PlatformInvitationDto => ({
  id: r.id,
  email: r.email,
  proposedOrgName: r.proposed_org_name ?? null,
  plan: (r.org_terms as { plan?: string } | null)?.plan ?? null,
  status: r.status,
  expiresAt: iso(r.expires_at) as string,
  createdAt: iso(r.created_at) as string,
  acceptedAt: iso(r.accepted_at),
  invitedByName: r.invited_by_name ?? null,
});

export async function listPlatformInvitations(ctx: Ctx): Promise<PlatformInvitationDto[]> {
  const r = await rows(
    ctx.pool,
    `SELECT i.*, u.display_name AS invited_by_name FROM invitations i LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.kind = 'new_org' ORDER BY i.created_at DESC`,
  );
  return r.map(toPlatformDto);
}

export async function getPlatformInvitation(ctx: Ctx, id: string): Promise<PlatformInvitationDto> {
  const r = await one(
    ctx.pool,
    `SELECT i.*, u.display_name AS invited_by_name FROM invitations i LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.id=$1 AND i.kind='new_org'`,
    [id],
  );
  if (!r) throw notFound('invitation not found');
  return toPlatformDto(r);
}

export async function resendNewOrgInvitation(
  ctx: Ctx,
  admin: AuthSession,
  invitationId: string,
  meta?: Meta,
) {
  const token = randomToken(32);
  const expiresAt = new Date(ctx.clock.now().getTime() + INVITE_TTL_MS);
  const inv = await withAppendTx(ctx.pool, async (tx) => {
    const i = await one(tx, `SELECT * FROM invitations WHERE id=$1 AND kind='new_org' FOR UPDATE`, [
      invitationId,
    ]);
    if (!i) throw notFound('invitation not found');
    if (i.status !== 'pending') throw conflict('invitation_not_pending', `invitation is ${i.status}`);
    await ctx.store.append(
      [
        {
          streamId: streamId.invitation(invitationId),
          event: {
            type: 'InvitationResent',
            payload: { invitationId, tokenHash: sha256Hex(token), expiresAt: expiresAt.toISOString() },
          },
          actor: { kind: 'user', id: admin.user.id },
          scope: ADMIN_SCOPE,
        },
      ],
      { tx },
    );
    void meta;
    return i;
  });
  await sendNewOrgMail(
    ctx,
    inv.email,
    token,
    inv.proposed_org_name,
    describeTerms((inv.org_terms ?? {}) as Parameters<typeof describeTerms>[0]),
    TEAM,
    expiresAt,
  );
}

export async function revokeNewOrgInvitation(ctx: Ctx, admin: AuthSession, invitationId: string) {
  await withAppendTx(ctx.pool, async (tx) => {
    const i = await one(tx, `SELECT status FROM invitations WHERE id=$1 AND kind='new_org' FOR UPDATE`, [
      invitationId,
    ]);
    if (!i) throw notFound('invitation not found');
    if (i.status !== 'pending') throw conflict('invitation_not_pending', `invitation is ${i.status}`);
    await ctx.store.append(
      [
        {
          streamId: streamId.invitation(invitationId),
          event: { type: 'InvitationRevoked', payload: { invitationId } },
          actor: { kind: 'user', id: admin.user.id },
          scope: ADMIN_SCOPE,
        },
      ],
      { tx },
    );
  });
}

// ---------------------------------------------------------------------------------------------- the token flow

/** Valid = pending and not expired (clock-aware). */
export async function lookupInvitation(ctx: Ctx, token: string): Promise<Row> {
  const inv = await one(
    ctx.pool,
    `SELECT i.*, o.name AS org_name, o.status AS org_status, u.display_name AS invited_by_name
       FROM invitations i LEFT JOIN organizations o ON o.id = i.org_id LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.token_hash=$1 AND i.status='pending' AND i.expires_at > $2`,
    [sha256Hex(token), ctx.clock.now()],
  );
  if (!inv) throw notFound('invitation is invalid or expired');
  return inv;
}

/** What the accept page shows (public: the token is the credential). */
export async function invitationInfo(ctx: Ctx, token: string): Promise<InvitationInfoResponse> {
  const inv = await lookupInvitation(ctx, token);
  const exists = await one(ctx.pool, 'SELECT 1 FROM users WHERE lower(email)=lower($1)', [inv.email]);
  return {
    kind: inv.kind,
    email: inv.email,
    expiresAt: iso(inv.expires_at) as string,
    invitedBy: inv.invited_by_name ?? null,
    orgName: inv.kind === 'org_member' ? (inv.org_name ?? null) : null,
    proposedOrgName: inv.kind === 'org_member' ? null : (inv.proposed_org_name ?? null),
    role: inv.kind === 'legacy' ? 'owner' : (inv.org_role as OrgRole | null),
    accountExists: Boolean(exists),
    terms:
      inv.kind === 'new_org'
        ? describeTerms((inv.org_terms ?? {}) as Parameters<typeof describeTerms>[0])
        : inv.kind === 'legacy'
          ? describeTerms({ plan: 'founding', status: 'active' })
          : null,
  };
}

interface Accepting {
  inv: Row;
  userId: string;
  displayName: string;
  orgName?: string | undefined;
  /** The account is created by this accept (a password and name were given). */
  newUser?: { email: string; passwordHash: string } | undefined;
}

const clean = (s: string | undefined | null) => (s ?? '').trim();

/** The events of accepting `inv`, in append order; `tx` is the lock-holding transaction. */
async function acceptEvents(
  ctx: Ctx,
  tx: Tx,
  a: Accepting,
): Promise<{ events: AppendInput[]; orgId: string }> {
  const { inv, userId } = a;
  const events: AppendInput[] = [];
  const adminAudience = inv.kind === 'new_org' || inv.kind === 'legacy';
  if (a.newUser && inv.kind !== 'legacy') {
    events.push({
      streamId: streamId.user(userId),
      event: {
        type: 'UserRegistered',
        payload: {
          userId,
          email: a.newUser.email,
          displayName: a.displayName,
          passwordHash: a.newUser.passwordHash,
          invitationId: inv.id,
        },
      },
      actor: { kind: 'user', id: userId },
      scope: userScope(userId),
    });
  }
  if (inv.kind === 'legacy') {
    // A legacy (application administrator) invitation creates the user and an organization of their own.
    events.push({
      streamId: streamId.user(userId),
      event: {
        type: 'InvitationAccepted',
        payload: {
          invitationId: inv.id,
          userId,
          email: (a.newUser as { email: string }).email,
          displayName: a.displayName,
          passwordHash: (a.newUser as { passwordHash: string }).passwordHash,
          role: inv.role ?? 'member',
        },
      },
      actor: { kind: 'user', id: userId },
      scope: ADMIN_SCOPE,
    });
  }
  let orgId: string;
  if (inv.kind === 'org_member') {
    orgId = inv.org_id as string;
    if (inv.org_status && inv.org_status !== 'active' && inv.org_status !== 'trial')
      throw conflict(
        'org_suspended',
        `${inv.org_name} is ${inv.org_status}: it cannot take new members now.`,
      );
    // The pending invitation already counts toward the limit: it only fails when the organization is over it.
    await assertWithinLimit(tx, orgId, 'members', 0);
    const projects = await rows<{ id: string }>(
      tx,
      `SELECT id FROM projects WHERE org_id=$1 AND kind='project' AND status='active' AND id = ANY($2::uuid[])`,
      [orgId, inv.project_ids ?? []],
    );
    events.push({
      streamId: streamId.org(orgId),
      event: {
        type: 'OrgMemberAdded',
        payload: {
          orgId,
          userId,
          role: inv.org_role,
          via: 'invitation',
          invitationId: inv.id,
          ...(inv.invited_by ? { invitedBy: inv.invited_by } : {}),
          ...(projects.length ? { projectIds: projects.map((p) => p.id) } : {}),
        },
      },
      actor: { kind: 'user', id: userId },
      scope: orgScope(orgId),
    });
    for (const p of projects)
      events.push({
        streamId: streamId.project(p.id),
        event: {
          type: 'ProjectMemberAdded',
          payload: { projectId: p.id, userId, addedBy: inv.invited_by ?? userId },
        },
        actor: { kind: 'user', id: userId },
        scope: { orgId, projectId: p.id, audience: 'project' },
      });
  } else {
    // new_org and legacy: the invitee becomes the Owner of an organization of their own.
    orgId = randomUUID();
    const terms = (inv.org_terms ?? {}) as {
      plan?: string;
      status?: 'trial' | 'active';
      limits?: OrgLimits;
      trialEndsAt?: string | null;
      licenseExpiresAt?: string | null;
      features?: Record<string, boolean>;
    };
    const name = clean(a.orgName) || clean(inv.proposed_org_name) || `${a.displayName}'s organization`;
    events.push({
      streamId: streamId.org(orgId),
      event: {
        type: 'OrganizationCreated',
        payload: {
          orgId,
          name: name.slice(0, 120),
          ownerUserId: userId,
          plan: terms.plan ?? 'founding',
          status: terms.status ?? 'active',
          limits: terms.limits ?? NO_LIMITS,
          ...(terms.trialEndsAt ? { trialEndsAt: terms.trialEndsAt } : {}),
          ...(terms.licenseExpiresAt ? { licenseExpiresAt: terms.licenseExpiresAt } : {}),
          features: terms.features ?? {},
          createdVia: 'invitation',
          invitationId: inv.id,
        },
      },
      actor: { kind: 'user', id: userId },
      scope: orgScope(orgId),
    });
    events.push({
      streamId: streamId.org(orgId),
      event: {
        type: 'OrgMemberAdded',
        payload: { orgId, userId, role: 'owner', via: 'invitation', invitationId: inv.id },
      },
      actor: { kind: 'user', id: userId },
      scope: orgScope(orgId),
    });
  }
  if (inv.kind !== 'legacy')
    events.push({
      streamId: streamId.invitation(inv.id),
      event: { type: 'OrgInvitationAccepted', payload: { invitationId: inv.id, userId } },
      actor: { kind: 'user', id: userId },
      scope: adminAudience ? ADMIN_SCOPE : orgScope(orgId),
    });
  return { events, orgId };
}

const lockPending = (tx: Tx, ctx: Ctx, token: string) =>
  one(
    tx,
    `SELECT i.*, o.name AS org_name, o.status AS org_status FROM invitations i
       LEFT JOIN organizations o ON o.id = i.org_id
      WHERE i.token_hash=$1 AND i.status='pending' AND i.expires_at > $2 FOR UPDATE OF i`,
    [sha256Hex(token), ctx.clock.now()],
  );

/** Accepting as a new account (any kind): name and password, plus the organization name for a new organization. */
export async function acceptInvitation(
  ctx: Ctx,
  token: string,
  input: { displayName: string; password: string; orgName?: string | undefined },
): Promise<string> {
  const passwordHash = await hashPassword(input.password);
  const userId = randomUUID();
  const accepted = await withAppendTx(ctx.pool, async (tx) => {
    // Single use: the status flip happens in this transaction, guarded by the row lock.
    const inv = await lockPending(tx, ctx, token);
    if (!inv) throw notFound('invitation is invalid or expired');
    if (await one(tx, 'SELECT 1 FROM users WHERE lower(email)=lower($1)', [inv.email])) {
      throw conflict('user_exists', 'an account with this email already exists: sign in to accept');
    }
    const { events } = await acceptEvents(ctx, tx, {
      inv,
      userId,
      displayName: input.displayName,
      orgName: input.orgName,
      newUser: { email: inv.email, passwordHash },
    });
    await ctx.store.append(events, { tx });
    return {
      kind: inv.kind as string,
      orgName: (input.orgName || inv.proposed_org_name || inv.org_name || null) as string | null,
    };
  });
  await notifySignup(ctx, {
    kind: accepted.kind,
    email: (await one(ctx.pool, 'SELECT email FROM users WHERE id=$1', [userId]))?.email ?? '',
    displayName: input.displayName,
    orgName: accepted.orgName,
  });
  return userId;
}

/** Accepting while signed in with the invited email (an existing account joins or starts the organization). */
export async function acceptInvitationExisting(
  ctx: Ctx,
  session: AuthSession,
  token: string,
  input: { orgName?: string | undefined },
): Promise<string> {
  const r = await withAppendTx(ctx.pool, async (tx) => {
    const inv = await lockPending(tx, ctx, token);
    if (!inv) throw notFound('invitation is invalid or expired');
    if (inv.kind === 'legacy')
      throw conflict('legacy_invitation', 'this invitation creates a new account: open it signed out');
    if (inv.email.toLowerCase() !== session.user.email.toLowerCase())
      throw forbidden(
        'this invitation is for another email address; sign out and continue with that account',
      );
    if (session.user.kind === 'super_admin')
      throw conflict('super_admin_cannot_join', 'platform accounts cannot join organizations');
    if (inv.kind === 'org_member') {
      const already = await one(
        tx,
        `SELECT 1 FROM org_members WHERE org_id=$1 AND user_id=$2 AND status='active'`,
        [inv.org_id, session.user.id],
      );
      if (already) throw conflict('already_member', 'you are already a member of this organization');
    }
    const { events, orgId } = await acceptEvents(ctx, tx, {
      inv,
      userId: session.user.id,
      displayName: session.user.displayName,
      orgName: input.orgName,
    });
    await ctx.store.append(events, { tx });
    // Their workstations get this organization's DevOps engineer.
    await hireDevopsForOrgIn(ctx, tx, session.user.id, orgId);
    return {
      orgId,
      kind: inv.kind as string,
      orgName: (input.orgName || inv.proposed_org_name || inv.org_name || null) as string | null,
    };
  });
  await notifySignup(ctx, {
    kind: r.kind,
    email: session.user.email,
    displayName: session.user.displayName,
    orgName: r.orgName,
  });
  return r.orgId;
}
