import {
  effectiveFeatures,
  type OrgLimits,
  type OrgStatus,
  type PatchPlatformOrgRequest,
  type PlatformAuditRow,
  type PlatformOrgDetail,
  type PlatformOrgSummary,
  type PlatformUserDto,
  planDefinition,
  streamId,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { disableTwoFactorIn } from '../auth/two-factor.ts';
import type { Ctx } from '../context.ts';
import { exec, iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { orgUsage } from '../orgs/limits.ts';
import { orgScope, userActor } from './common.ts';
import { removeOrgMemberIn } from './orgs.ts';
import { removeMemberIn } from './sharing.ts';
import { unlinkWorkstationIn } from './workstations.ts';

/**
 * The platform area (docs/design/organizations.md sections 9, 10 and 11.3): the super admin sees and edits organization
 * metadata (plan, status, limits, dates, flags) and accounts. Nothing here reads an organization's projects, cards,
 * desk, vaults, ledger, chats or agents.
 */

export interface Meta {
  ip?: string | undefined;
  userAgent?: string | undefined;
}
const metaOf = (m?: Meta) => (m && (m.ip || m.userAgent) ? { meta: { ...m } } : {});
const actorOf = (a: AuthSession) => userActor(a.user.id);

const limitsOf = (o: Row): OrgLimits => ({
  maxMembers: o.max_members ?? null,
  maxWorkstations: o.max_workstations ?? null,
  maxAgents: null,
  maxProjects: o.max_projects ?? null,
});

const SUMMARY_SQL = `
  SELECT o.*, ou.display_name AS owner_name, ou.email AS owner_email,
         (SELECT count(*)::int FROM org_members m WHERE m.org_id = o.id AND m.status = 'active') AS member_count,
         (SELECT e.created_at FROM events e WHERE e.org_id = o.id ORDER BY e.seq DESC LIMIT 1) AS last_active_at
    FROM organizations o JOIN users ou ON ou.id = o.owner_user_id`;

async function toSummary(db: Queryable, o: Row): Promise<PlatformOrgSummary> {
  return {
    id: o.id,
    name: o.name,
    owner: { id: o.owner_user_id, displayName: o.owner_name, email: o.owner_email },
    memberCount: o.member_count,
    status: o.status,
    statusReason: o.status_reason ?? null,
    plan: o.plan,
    planName: planDefinition(o.plan).name,
    limits: limitsOf(o),
    usage: await orgUsage(db, o.id),
    trialEndsAt: iso(o.trial_ends_at),
    licenseExpiresAt: iso(o.license_expires_at),
    requireTwoFactor: Boolean(o.require_two_factor),
    createdAt: iso(o.created_at) as string,
    lastActiveAt: iso(o.last_active_at),
  };
}

export async function listPlatformOrgs(
  ctx: Ctx,
  q: {
    status?: OrgStatus | undefined;
    q?: string | undefined;
    sort: 'name' | 'created' | 'active' | 'members';
  },
): Promise<PlatformOrgSummary[]> {
  const order = {
    name: 'lower(o.name), o.id',
    created: 'o.created_at DESC',
    active: 'last_active_at DESC NULLS LAST',
    members: 'member_count DESC, lower(o.name)',
  }[q.sort];
  const list = await rows(
    ctx.pool,
    `SELECT * FROM (${SUMMARY_SQL} WHERE ($1::text IS NULL OR o.status = $1)
        AND ($2::text IS NULL OR o.name ILIKE '%' || $2 || '%' OR ou.email ILIKE '%' || $2 || '%'
             OR ou.display_name ILIKE '%' || $2 || '%')) o ORDER BY ${order.replaceAll('o.', 'o.')}`,
    [q.status ?? null, q.q?.trim() || null],
  );
  return Promise.all(list.map((o) => toSummary(ctx.pool, o)));
}

const AUDIT_COLS = `a.seq, a.at, a.actor_kind, a.actor_user_id, au.display_name AS actor_name, a.action, a.org_id,
       o.name AS org_name, a.summary, a.details, a.ip`;

const toAudit = (r: Row): PlatformAuditRow => ({
  seq: Number(r.seq),
  at: iso(r.at) as string,
  actorKind: r.actor_kind,
  actorUserId: r.actor_user_id ?? null,
  actorName: r.actor_name ?? null,
  action: r.action,
  orgId: r.org_id ?? null,
  orgName: r.org_name ?? null,
  summary: r.summary,
  details: r.details ?? {},
  ip: r.ip ?? null,
});

export async function auditLog(
  ctx: Ctx,
  q: {
    orgId?: string | undefined;
    actorId?: string | undefined;
    action?: string | undefined;
    before?: number | undefined;
    limit: number;
  },
): Promise<{ rows: PlatformAuditRow[]; next: number | null }> {
  const r = await rows(
    ctx.pool,
    `SELECT ${AUDIT_COLS} FROM platform_audit_log a
       LEFT JOIN users au ON au.id = a.actor_user_id LEFT JOIN organizations o ON o.id = a.org_id
      WHERE ($1::uuid IS NULL OR a.org_id = $1) AND ($2::uuid IS NULL OR a.actor_user_id = $2)
        AND ($3::text IS NULL OR a.action = $3) AND ($4::bigint IS NULL OR a.seq < $4)
      ORDER BY a.seq DESC LIMIT $5`,
    [q.orgId ?? null, q.actorId ?? null, q.action ?? null, q.before ?? null, q.limit + 1],
  );
  const page = r.slice(0, q.limit).map(toAudit);
  return { rows: page, next: r.length > q.limit ? (page.at(-1)?.seq ?? null) : null };
}

/**
 * One organization's metadata. Reading it is itself audited (`PlatformOrgViewed`), at most once per organization and
 * administrator every 10 minutes so the log stays small.
 */
export async function getPlatformOrg(
  ctx: Ctx,
  admin: AuthSession,
  orgId: string,
  meta?: Meta,
): Promise<PlatformOrgDetail> {
  const o = await one(ctx.pool, `${SUMMARY_SQL} WHERE o.id=$1`, [orgId]);
  if (!o) throw notFound('organization not found');
  const recent = await one(
    ctx.pool,
    `SELECT 1 FROM platform_audit_log WHERE action='PlatformOrgViewed' AND org_id=$1 AND actor_user_id=$2 AND at > $3`,
    [orgId, admin.user.id, new Date(ctx.clock.now().getTime() - 10 * 60_000)],
  );
  if (!recent)
    await ctx.store.append([
      {
        streamId: streamId.org(orgId),
        event: { type: 'PlatformOrgViewed', payload: { orgId, ...metaOf(meta) } },
        actor: actorOf(admin),
        scope: { orgId: null, projectId: null, audience: 'admin' },
      },
    ]);
  const shifts = await one<{ n: number }>(
    ctx.pool,
    `SELECT count(*)::int AS n FROM shifts WHERE org_id=$1 AND started_at > $2`,
    [orgId, new Date(ctx.clock.now().getTime() - 30 * 86_400_000)],
  );
  const admins = await rows(
    ctx.pool,
    `SELECT u.id, u.display_name, u.email FROM org_members m JOIN users u ON u.id = m.user_id
      WHERE m.org_id=$1 AND m.status='active' AND m.role='admin' ORDER BY lower(u.display_name)`,
    [orgId],
  );
  const audit = await auditLog(ctx, { orgId, limit: 15 });
  const overrides = (o.features ?? {}) as Record<string, boolean>;
  return {
    ...(await toSummary(ctx.pool, o)),
    features: effectiveFeatures(o.plan, overrides),
    featureOverrides: overrides,
    graceDays: o.grace_days,
    billing: {
      provider: o.billing_provider ?? null,
      customerRef: o.billing_customer_ref ?? null,
      subscriptionRef: o.billing_subscription_ref ?? null,
    },
    shifts30d: shifts?.n ?? 0,
    admins: admins.map((a) => ({ id: a.id, displayName: a.display_name, email: a.email })),
    recentAudit: audit.rows,
  };
}

/** Edits plan, limits, dates, grace, flags and name in one append (each its own event, with the previous values). */
export async function patchPlatformOrg(
  ctx: Ctx,
  admin: AuthSession,
  orgId: string,
  patch: PatchPlatformOrgRequest,
  meta?: Meta,
): Promise<void> {
  if (!patch.note) throw badRequest('reason_required', 'say why: the change is written to the audit log');
  await withAppendTx(ctx.pool, async (tx) => {
    const o = await one(tx, 'SELECT * FROM organizations WHERE id=$1 FOR UPDATE', [orgId]);
    if (!o) throw notFound('organization not found');
    const events: AppendInput[] = [];
    const push = (event: AppendInput['event']) =>
      events.push({ streamId: streamId.org(orgId), event, actor: actorOf(admin), scope: orgScope(orgId) });
    const note = patch.note;
    const m = metaOf(meta);
    if (patch.name !== undefined && patch.name !== o.name)
      push({ type: 'OrganizationRenamed', payload: { orgId, name: patch.name, by: admin.user.id } });
    if (patch.plan !== undefined && (patch.plan !== o.plan || patch.limitsReset)) {
      const def = planDefinition(patch.plan);
      push({
        type: 'OrgPlanChanged',
        payload: {
          orgId,
          plan: patch.plan,
          limitsReset: patch.limitsReset === true,
          previous: { plan: o.plan },
          ...(patch.limitsReset ? { limits: def.limits } : {}),
          ...(note ? { note } : {}),
          ...m,
        },
      });
    }
    if (patch.limits !== undefined) {
      const before = limitsOf(o);
      const next = { ...patch.limits, maxAgents: null }; // B11: agents are never limited
      if (JSON.stringify(before) !== JSON.stringify(next))
        push({
          type: 'OrgLimitsSet',
          payload: { orgId, limits: next, previous: before, note, ...m },
        });
    }
    const dates =
      patch.trialEndsAt !== undefined ||
      patch.licenseExpiresAt !== undefined ||
      patch.graceDays !== undefined;
    if (dates)
      push({
        type: 'OrgDatesSet',
        payload: {
          orgId,
          trialEndsAt: patch.trialEndsAt !== undefined ? patch.trialEndsAt : iso(o.trial_ends_at),
          licenseExpiresAt:
            patch.licenseExpiresAt !== undefined ? patch.licenseExpiresAt : iso(o.license_expires_at),
          ...(patch.graceDays !== undefined ? { graceDays: patch.graceDays } : {}),
          previous: {
            trialEndsAt: iso(o.trial_ends_at),
            licenseExpiresAt: iso(o.license_expires_at),
            graceDays: o.grace_days,
          },
          note,
          ...m,
        },
      });
    if (patch.features !== undefined)
      push({
        type: 'OrgFeaturesSet',
        payload: { orgId, features: patch.features, previous: o.features ?? {}, note, ...m },
      });
    if (events.length) await ctx.store.append(events, { tx });
  });
}

const STATUS_ACTION: Record<'suspend' | 'reactivate' | 'cancel', OrgStatus> = {
  suspend: 'suspended',
  reactivate: 'active',
  cancel: 'cancelled',
};

/**
 * Suspend, reactivate or cancel (section 7.2). Suspended: running shifts finish, nothing new starts, only the Owner signs
 * in. Cancelled: claims are released. Reactivating a trial organization goes back to `trial` when its trial has not ended.
 */
export async function setOrgStatus(
  ctx: Ctx,
  admin: AuthSession,
  orgId: string,
  action: 'suspend' | 'reactivate' | 'cancel',
  input: { reason: string; note?: string | undefined },
  meta?: Meta,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const o = await one(tx, 'SELECT * FROM organizations WHERE id=$1 FOR UPDATE', [orgId]);
    if (!o) throw notFound('organization not found');
    let status = STATUS_ACTION[action];
    if (
      action === 'reactivate' &&
      o.trial_ends_at &&
      new Date(o.trial_ends_at) > ctx.clock.now() &&
      o.created_via !== 'cli'
    )
      status = o.plan === 'founding' ? 'active' : 'trial';
    if (o.status === status) throw conflict('no_change', `the organization is already ${status}`);
    if (action === 'reactivate' && o.status !== 'suspended' && o.status !== 'cancelled')
      throw conflict('not_suspended', 'only a suspended or cancelled organization is reactivated');
    await ctx.store.append(
      [
        {
          streamId: streamId.org(orgId),
          event: {
            type: 'OrgStatusChanged',
            payload: {
              orgId,
              status,
              reason: input.reason,
              ...(input.note ? { note: input.note } : {}),
              previous: { status: o.status, reason: o.status_reason ?? null },
              ...metaOf(meta),
            },
          },
          actor: actorOf(admin),
          scope: orgScope(orgId),
        },
      ],
      { tx },
    );
    if (status === 'cancelled') await releaseOrgClaims(ctx, tx, admin.user.id, orgId);
  });
  ctx.services.dispatcher.trigger();
}

/** A cancelled organization's claimed cards go back to the queue (they never restart while it is cancelled). */
async function releaseOrgClaims(ctx: Ctx, tx: Tx, actorId: string, orgId: string): Promise<void> {
  const cards = await rows(tx, `SELECT * FROM cards WHERE org_id=$1 AND claim_id IS NOT NULL`, [orgId]);
  const events: AppendInput[] = cards.map((c) => ({
    streamId: streamId.card(c.id),
    event: {
      type: 'ClaimReleased',
      payload: {
        cardId: c.id,
        claimId: c.claim_id,
        agentId: c.claimed_by_agent_id,
        reason: 'org_cancelled',
      },
    },
    actor: userActor(actorId),
    scope: { orgId, projectId: c.project_id, audience: 'project' },
  }));
  if (events.length) await ctx.store.append(events, { tx });
}

/** Support case (owner decision 6): hands the organization to one of its Admins; a reason is mandatory and audited. */
export async function platformTransferOwnership(
  ctx: Ctx,
  admin: AuthSession,
  orgId: string,
  toUserId: string,
  reason: string,
  meta?: Meta,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const o = await one(tx, 'SELECT owner_user_id FROM organizations WHERE id=$1 FOR UPDATE', [orgId]);
    if (!o) throw notFound('organization not found');
    const target = await one(
      tx,
      `SELECT role FROM org_members WHERE org_id=$1 AND user_id=$2 AND status='active'`,
      [orgId, toUserId],
    );
    if (target?.role !== 'admin')
      throw conflict('not_an_admin', 'ownership can only move to an existing Admin of the organization');
    await ctx.store.append(
      [
        {
          streamId: streamId.org(orgId),
          event: {
            type: 'OrgOwnershipTransferred',
            payload: { orgId, fromUserId: o.owner_user_id, toUserId, reason, ...metaOf(meta) },
          },
          actor: actorOf(admin),
          scope: orgScope(orgId),
        },
      ],
      { tx },
    );
  });
}

// ---------------------------------------------------------------------------------------------------- users

export async function listPlatformUsers(ctx: Ctx, q?: string): Promise<PlatformUserDto[]> {
  const list = await rows(
    ctx.pool,
    `SELECT u.*, (SELECT count(*)::int FROM org_members m WHERE m.user_id = u.id AND m.status='active') AS org_count
       FROM users u WHERE ($1::text IS NULL OR u.email ILIKE '%' || $1 || '%' OR u.display_name ILIKE '%' || $1 || '%')
      ORDER BY lower(u.display_name), u.id`,
    [q?.trim() || null],
  );
  const owned = await rows(
    ctx.pool,
    `SELECT id, name, status, owner_user_id FROM organizations WHERE owner_user_id = ANY($1::uuid[]) ORDER BY name`,
    [list.map((u) => u.id)],
  );
  const sent = await rows(
    ctx.pool,
    `SELECT user_id, max(created_at) AS at FROM password_resets WHERE requested_by IS NOT NULL AND user_id = ANY($1::uuid[]) GROUP BY user_id`,
    [list.map((u) => u.id)],
  );
  return list.map((u) => ({
    passwordResetSentAt: iso(sent.find((x) => x.user_id === u.id)?.at) ?? null,
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    status: u.status,
    kind: u.kind,
    orgCount: u.org_count,
    ownedOrgs: owned
      .filter((o) => o.owner_user_id === u.id)
      .map((o) => ({ id: o.id, name: o.name, status: o.status })),
    twoFactorEnabled: Boolean(u.two_factor_enabled),
    createdAt: iso(u.created_at) as string,
    lastLoginAt: iso(u.last_login_at),
  }));
}

/**
 * Deactivates or reactivates a login (section 8.4). Refused while the account is the Owner of an organization that
 * is running (409 `user_owns_org`): suspend it, or move the ownership, first. Deactivating takes the user out of every
 * organization they are in (their work goes back to the Owners), unpairs their workstations and ends their sessions.
 */
export async function patchPlatformUser(
  ctx: Ctx,
  admin: AuthSession,
  userId: string,
  status: 'active' | 'deactivated',
  meta?: Meta,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const u = await one(tx, 'SELECT id, status, kind FROM users WHERE id=$1 FOR UPDATE', [userId]);
    if (!u) throw notFound('user not found');
    if (u.status === status) return;
    if (status === 'deactivated') {
      if (userId === admin.user.id) throw conflict('self_deactivate', 'you cannot deactivate yourself');
      if (u.kind === 'super_admin')
        throw conflict('super_admin_protected', 'platform accounts are managed on the server');
      const owned = await rows(
        tx,
        `SELECT id, name, status FROM organizations WHERE owner_user_id=$1 AND status IN ('trial','active')`,
        [userId],
      );
      if (owned.length)
        throw conflict(
          'user_owns_org',
          'this account is the Owner of a running organization: suspend it or transfer its ownership first',
          { orgs: owned },
        );
      const memberships = await rows<{ org_id: string; role: string }>(
        tx,
        `SELECT org_id, role FROM org_members WHERE user_id=$1 AND status='active'`,
        [userId],
      );
      for (const m of memberships) {
        // The Owner of a suspended or cancelled organization stays its Owner: only the login stops.
        if (m.role === 'owner') continue;
        await removeOrgMemberIn(ctx, tx, admin.user.id, m.org_id, userId, 'deactivated');
      }
      // Guest access to projects of other organizations ends too (their agents and cards go back to the Owners).
      const guestOf = await rows(
        tx,
        `SELECT p.* FROM project_members pm JOIN projects p ON p.id = pm.project_id
          WHERE pm.user_id=$1 AND pm.status IN ('invited','active') AND pm.role <> 'owner'`,
        [userId],
      );
      for (const p of guestOf) await removeMemberIn(ctx, tx, admin.user.id, p, userId);
      const stations = await rows<{ id: string }>(
        tx,
        `SELECT id FROM workstations WHERE user_id=$1 AND status='active'`,
        [userId],
      );
      for (const w of stations) await unlinkWorkstationIn(ctx, tx, admin.user.id, w.id, userId, 'admin');
      await ctx.store.append(
        [
          {
            streamId: streamId.user(userId),
            event: { type: 'UserDeactivated', payload: { userId, ...metaOf(meta) } },
            actor: actorOf(admin),
            scope: { orgId: null, projectId: null, audience: 'admin' },
          },
        ],
        { tx },
      );
      await exec(tx, 'DELETE FROM auth_sessions WHERE user_id=$1', [userId]);
    } else {
      await ctx.store.append(
        [
          {
            streamId: streamId.user(userId),
            event: { type: 'UserReactivated', payload: { userId, ...metaOf(meta) } },
            actor: actorOf(admin),
            scope: { orgId: null, projectId: null, audience: 'admin' },
          },
        ],
        { tx },
      );
    }
  });
  if (status === 'deactivated') ctx.services.browser.closeUser(userId);
}

/** Resets a user's two-factor login (lost phone and recovery codes): they set it up again at next sign-in. */
export async function resetUserTwoFactor(
  ctx: Ctx,
  admin: AuthSession,
  userId: string,
  meta?: Meta,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const u = await one(tx, 'SELECT two_factor_enabled FROM users WHERE id=$1', [userId]);
    if (!u) throw notFound('user not found');
    if (!u.two_factor_enabled) throw conflict('two_factor_off', 'this account has no two-factor login');
    await disableTwoFactorIn(ctx, tx, userId, admin.user.id, 'reset', actorOf(admin), meta as never);
    await exec(tx, 'DELETE FROM auth_sessions WHERE user_id=$1', [userId]);
  });
  ctx.services.browser.closeUser(userId);
}
