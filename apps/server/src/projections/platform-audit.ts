import type { EventOf, EventType } from '@aom/shared';
import { exec, one } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';

/**
 * Platform audit log (docs/design/organizations.md section 9): a projection of every event a super admin caused, the
 * system's licensing actions, organization creation and ownership transfers. Append-only by construction (it is
 * rebuilt from the event log, which is append-only) and kept forever (owner decision 9/10).
 */

const ev = <T extends EventType>(e: StoredEvent) => e.event as EventOf<T>;

async function isSuperAdmin(tx: Tx, e: StoredEvent): Promise<boolean> {
  if (e.actor.kind !== 'user' || !e.actor.id) return false;
  const u = await one<{ kind: string }>(tx, 'SELECT kind FROM users WHERE id=$1', [e.actor.id]);
  return u?.kind === 'super_admin';
}

const orgName = async (tx: Tx, orgId: string | null | undefined, fallback?: string): Promise<string> => {
  if (!orgId) return fallback ?? 'an organization';
  const o = await one<{ name: string }>(tx, 'SELECT name FROM organizations WHERE id=$1', [orgId]);
  return o?.name ?? fallback ?? 'an organization';
};
const userName = async (tx: Tx, userId: string | null | undefined): Promise<string> => {
  if (!userId) return 'someone';
  const u = await one<{ display_name: string; email: string }>(
    tx,
    'SELECT display_name, email FROM users WHERE id=$1',
    [userId],
  );
  return u ? `${u.display_name} <${u.email}>` : 'a user';
};

interface Entry {
  action: string;
  orgId?: string | null | undefined;
  targetUserId?: string | null | undefined;
  invitationId?: string | null | undefined;
  summary: string;
  details?: Record<string, unknown>;
  meta?: { ip?: string | undefined; userAgent?: string | undefined } | undefined;
}

async function write(tx: Tx, e: StoredEvent, x: Entry): Promise<void> {
  const system = e.actor.kind !== 'user';
  await exec(
    tx,
    `INSERT INTO platform_audit_log (seq, at, actor_kind, actor_user_id, action, org_id, target_user_id, invitation_id,
       summary, details, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (seq) DO NOTHING`,
    [
      e.seq.toString(),
      e.createdAt,
      system ? 'system' : 'user',
      system ? null : e.actor.id,
      x.action,
      x.orgId ?? null,
      x.targetUserId ?? null,
      x.invitationId ?? null,
      x.summary,
      JSON.stringify(x.details ?? {}),
      x.meta?.ip ?? null,
      x.meta?.userAgent ?? null,
    ],
  );
}

/** Wraps a projector: it only writes when the actor is a super admin (or the system, for licensing actions). */
const byPlatform =
  (fn: (tx: Tx, e: StoredEvent) => Promise<Entry | null>, opts: { system?: boolean } = {}): Projector =>
  async (tx, e) => {
    if (!(await isSuperAdmin(tx, e)) && !(opts.system && e.actor.kind === 'system')) return;
    const x = await fn(tx, e);
    if (x) await write(tx, e, x);
  };
const always =
  (fn: (tx: Tx, e: StoredEvent) => Promise<Entry | null>): Projector =>
  async (tx, e) => {
    const x = await fn(tx, e);
    if (x) await write(tx, e, x);
  };

const STATUS_VERB: Record<string, string> = {
  suspended: 'Suspended',
  cancelled: 'Cancelled',
  active: 'Reactivated',
  trial: 'Set to trial:',
};

const limitDiff = (
  before: Record<string, number | null> | undefined,
  after: Record<string, number | null>,
): string => {
  const names: Record<string, string> = {
    maxMembers: 'members',
    maxWorkstations: 'workstations',
    maxAgents: 'agents',
    maxProjects: 'projects',
  };
  const out: string[] = [];
  for (const k of Object.keys(names)) {
    const a = before?.[k] ?? null;
    const b = after[k] ?? null;
    if (a !== b) out.push(`${names[k]} ${a ?? 'unlimited'} -> ${b ?? 'unlimited'}`);
  }
  return out.join(', ') || 'no change';
};

export const platformAuditProjectors: Record<string, Projector> = {
  OrganizationCreated: always(async (tx, e) => {
    const p = ev<'OrganizationCreated'>(e).payload;
    return {
      action: e.event.type,
      orgId: p.orgId,
      targetUserId: p.ownerUserId,
      invitationId: p.invitationId,
      summary: `Organization ${p.name} created (${p.createdVia.replace('_', ' ')}), owner ${await userName(tx, p.ownerUserId)}`,
      details: { plan: p.plan, status: p.status, createdVia: p.createdVia },
    };
  }),
  OrgSimulationSet: byPlatform(async (tx, e) => {
    const p = ev<'OrgSimulationSet'>(e).payload;
    return {
      action: e.event.type,
      orgId: p.orgId,
      summary: `${p.enabled ? 'Turned simulation on for' : 'Turned simulation off for'} ${await orgName(tx, p.orgId)}${p.pace ? ` (pace ${p.pace})` : ''}${p.note ? `: ${p.note}` : ''}`,
      details: { enabled: p.enabled, pace: p.pace ?? null, note: p.note ?? null },
      meta: p.meta,
    };
  }),
  // Kept forever (the wiped organization's own events are gone): org_id stays empty so nothing links back to it.
  SimulationOrgWiped: always(async (_tx, e) => {
    const p = ev<'SimulationOrgWiped'>(e).payload;
    return {
      action: e.event.type,
      orgId: null,
      summary: `Wiped the simulation organization ${p.orgName} with all its data (${p.memberEmails.length} member${p.memberEmails.length === 1 ? '' : 's'}, ${p.deletedUserEmails.length} account${p.deletedUserEmails.length === 1 ? '' : 's'} deleted)`,
      details: {
        orgId: p.orgId,
        orgName: p.orgName,
        memberEmails: p.memberEmails,
        deletedUserEmails: p.deletedUserEmails,
        counts: p.counts,
        backupNote: p.backupNote ?? null,
      },
      meta: p.meta,
    };
  }),
  OrgOwnershipTransferred: always(async (tx, e) => {
    const p = ev<'OrgOwnershipTransferred'>(e).payload;
    const viaPlatform = await isSuperAdmin(tx, e);
    return {
      action: e.event.type,
      orgId: p.orgId,
      targetUserId: p.toUserId,
      summary: `Ownership of ${await orgName(tx, p.orgId)} moved from ${await userName(tx, p.fromUserId)} to ${await userName(tx, p.toUserId)}${p.reason ? `: ${p.reason}` : ''}`,
      details: {
        fromUserId: p.fromUserId,
        toUserId: p.toUserId,
        reason: p.reason ?? null,
        byPlatform: viaPlatform,
      },
      meta: p.meta,
    };
  }),
  OrgStatusChanged: byPlatform(
    async (tx, e) => {
      const p = ev<'OrgStatusChanged'>(e).payload;
      const name = await orgName(tx, p.orgId);
      const system = e.actor.kind === 'system';
      const summary =
        system && p.reason === 'trial_ended'
          ? `Trial ended for ${name}, suspended`
          : system && p.reason === 'license_expired'
            ? `Licence expired for ${name}, suspended`
            : `${STATUS_VERB[p.status] ?? p.status} ${name}: ${p.reason}${p.note ? ` (${p.note})` : ''}`;
      return {
        action: e.event.type,
        orgId: p.orgId,
        summary,
        details: {
          before: p.previous ?? null,
          after: { status: p.status, reason: p.reason },
          note: p.note ?? null,
        },
        meta: p.meta,
      };
    },
    { system: true },
  ),
  OrgPlanChanged: byPlatform(async (tx, e) => {
    const p = ev<'OrgPlanChanged'>(e).payload;
    return {
      action: e.event.type,
      orgId: p.orgId,
      summary: `Changed ${await orgName(tx, p.orgId)} plan: ${p.previous?.plan ?? '?'} -> ${p.plan}${p.limitsReset ? ' (limits and flags reset)' : ''}`,
      details: {
        before: p.previous ?? null,
        after: { plan: p.plan, limitsReset: p.limitsReset },
        note: p.note ?? null,
      },
      meta: p.meta,
    };
  }),
  OrgLimitsSet: byPlatform(async (tx, e) => {
    const p = ev<'OrgLimitsSet'>(e).payload;
    return {
      action: e.event.type,
      orgId: p.orgId,
      summary: `Changed ${await orgName(tx, p.orgId)} limits: ${limitDiff(p.previous, p.limits)}`,
      details: { before: p.previous ?? null, after: p.limits, note: p.note ?? null },
      meta: p.meta,
    };
  }),
  OrgDatesSet: byPlatform(async (tx, e) => {
    const p = ev<'OrgDatesSet'>(e).payload;
    return {
      action: e.event.type,
      orgId: p.orgId,
      summary: `Changed ${await orgName(tx, p.orgId)} dates: trial ends ${p.trialEndsAt?.slice(0, 10) ?? 'never'}, licence expires ${p.licenseExpiresAt?.slice(0, 10) ?? 'never'}`,
      details: {
        before: p.previous ?? null,
        after: {
          trialEndsAt: p.trialEndsAt,
          licenseExpiresAt: p.licenseExpiresAt,
          graceDays: p.graceDays ?? null,
        },
        note: p.note ?? null,
      },
      meta: p.meta,
    };
  }),
  OrgFeaturesSet: byPlatform(async (tx, e) => {
    const p = ev<'OrgFeaturesSet'>(e).payload;
    const list = Object.entries(p.features)
      .map(([k, v]) => `${k} ${v === null ? 'default' : v ? 'on' : 'off'}`)
      .join(', ');
    return {
      action: e.event.type,
      orgId: p.orgId,
      summary: `Changed ${await orgName(tx, p.orgId)} features: ${list}`,
      details: { before: p.previous ?? null, after: p.features, note: p.note ?? null },
      meta: p.meta,
    };
  }),
  OrganizationRenamed: byPlatform(async (tx, e) => {
    const p = ev<'OrganizationRenamed'>(e).payload;
    return {
      action: e.event.type,
      orgId: p.orgId,
      summary: `Renamed an organization to ${p.name}`,
      details: { name: p.name },
    };
  }),
  OrgInvitationCreated: byPlatform(async (_tx, e) => {
    const p = ev<'OrgInvitationCreated'>(e).payload;
    if (p.kind !== 'new_org') return null;
    return {
      action: e.event.type,
      invitationId: p.invitationId,
      summary: `Invited ${p.email} to start the organization ${p.proposedOrgName ?? ''}`.trim(),
      details: { terms: p.orgTerms ?? null },
      meta: p.meta,
    };
  }),
  InvitationResent: byPlatform(async (tx, e) => {
    const p = ev<'InvitationResent'>(e).payload;
    const inv = await one<{ kind: string; email: string }>(
      tx,
      'SELECT kind, email FROM invitations WHERE id=$1',
      [p.invitationId],
    );
    if (inv?.kind !== 'new_org') return null;
    return {
      action: e.event.type,
      invitationId: p.invitationId,
      summary: `Resent the invitation to ${inv.email}`,
    };
  }),
  InvitationRevoked: byPlatform(async (tx, e) => {
    const p = ev<'InvitationRevoked'>(e).payload;
    const inv = await one<{ kind: string; email: string }>(
      tx,
      'SELECT kind, email FROM invitations WHERE id=$1',
      [p.invitationId],
    );
    if (inv?.kind !== 'new_org') return null;
    return {
      action: e.event.type,
      invitationId: p.invitationId,
      summary: `Revoked the invitation to ${inv.email}`,
    };
  }),
  UserDeactivated: byPlatform(async (tx, e) => {
    const p = ev<'UserDeactivated'>(e).payload;
    return {
      action: e.event.type,
      targetUserId: p.userId,
      summary: `Deactivated ${await userName(tx, p.userId)}`,
      meta: p.meta,
    };
  }),
  SignupAbandoned: always(async (_tx, e) => {
    const p = ev<'SignupAbandoned'>(e).payload;
    return {
      action: e.event.type,
      orgId: p.orgId,
      targetUserId: p.userId,
      summary: p.verified
        ? `Removed the sign-up ${p.displayName} <${p.email}> (verified, no card saved within 14 days) and its empty organization ${p.orgName}`
        : `Removed the unverified sign-up ${p.displayName} <${p.email}> and its empty organization ${p.orgName}`,
      details: { registeredAt: p.registeredAt, verified: p.verified === true },
    };
  }),
  UserReactivated: byPlatform(async (tx, e) => {
    const p = ev<'UserReactivated'>(e).payload;
    return {
      action: e.event.type,
      targetUserId: p.userId,
      summary: `Reactivated ${await userName(tx, p.userId)}`,
      meta: p.meta,
    };
  }),
  TwoFactorDisabled: byPlatform(async (tx, e) => {
    const p = ev<'TwoFactorDisabled'>(e).payload;
    if (p.reason !== 'reset') return null;
    return {
      action: e.event.type,
      targetUserId: p.userId,
      summary: `Reset two-factor login of ${await userName(tx, p.userId)}`,
      meta: p.meta,
    };
  }),
  PasswordResetLinkSent: byPlatform(async (tx, e) => {
    const p = ev<'PasswordResetLinkSent'>(e).payload;
    return {
      action: e.event.type,
      targetUserId: p.userId,
      summary: `Sent a password reset link to ${await userName(tx, p.userId)}`,
      meta: p.meta,
    };
  }),
  // ---- blog (docs/design/blog-prd.md): every write is audited, API writes with the key as the actor
  BlogPostSubmitted: always(async (_tx, e) => {
    const p = ev<'BlogPostSubmitted'>(e).payload;
    return {
      action: e.event.type,
      summary: `Blog post submitted${p.origin.apiKeyId ? ' by an API key' : p.origin.system ? ' by the blog writer' : ''}: ${p.content.title}`,
      details: { postId: p.postId, slug: p.content.slug, origin: p.origin, warnings: p.warnings },
    };
  }),
  BlogPostRevised: always(async (_tx, e) => {
    const p = ev<'BlogPostRevised'>(e).payload;
    return {
      action: e.event.type,
      summary: `Blog post revised: ${p.content.title}`,
      details: { postId: p.postId, slug: p.content.slug, by: p.by },
    };
  }),
  BlogPostPublished: always(async (tx, e) => {
    const p = ev<'BlogPostPublished'>(e).payload;
    const post = await one<{ title: string }>(tx, 'SELECT title FROM blog_posts WHERE id=$1', [p.postId]);
    return {
      action: e.event.type,
      summary: `Blog post ${p.auto ? 'auto-published' : 'published'}: ${post?.title ?? p.postId}`,
      details: { postId: p.postId, auto: p.auto },
    };
  }),
  BlogPostRejected: always(async (tx, e) => {
    const p = ev<'BlogPostRejected'>(e).payload;
    const post = await one<{ title: string }>(tx, 'SELECT title FROM blog_posts WHERE id=$1', [p.postId]);
    return {
      action: e.event.type,
      summary: `Blog post rejected: ${post?.title ?? p.postId}`,
      details: { postId: p.postId, reason: p.reason },
    };
  }),
  BlogPostUnpublished: always(async (tx, e) => {
    const p = ev<'BlogPostUnpublished'>(e).payload;
    const post = await one<{ title: string }>(tx, 'SELECT title FROM blog_posts WHERE id=$1', [p.postId]);
    return {
      action: e.event.type,
      summary: `Blog post unpublished: ${post?.title ?? p.postId}`,
      details: { postId: p.postId },
    };
  }),
  BlogSettingsChanged: always(async (_tx, e) => {
    const p = ev<'BlogSettingsChanged'>(e).payload;
    const c = p.change;
    const parts: string[] = [];
    if (c.enabled !== undefined)
      parts.push(c.enabled ? 'blog switched ON' : 'blog switched OFF (kill switch)');
    if (c.autoPublishFrom !== undefined)
      parts.push(`auto-publish from ${c.autoPublishFrom?.slice(0, 10) ?? 'never'}`);
    if (c.holdHours !== undefined) parts.push(`hold ${c.holdHours} h`);
    if (c.digestEnabled !== undefined) parts.push(`digest ${c.digestEnabled ? 'on' : 'off'}`);
    return { action: e.event.type, summary: `Blog settings: ${parts.join(', ')}`, details: { change: c } };
  }),
  BlogWriterSettingsChanged: always(async (_tx, e) => {
    const p = ev<'BlogWriterSettingsChanged'>(e).payload;
    return {
      action: e.event.type,
      summary: `Blog writer settings: ${Object.keys(p.change).join(', ')}`,
      details: { change: p.change },
    };
  }),
  ApiKeyCreated: always(async (_tx, e) => {
    const p = ev<'ApiKeyCreated'>(e).payload;
    return {
      action: e.event.type,
      summary: `API key created: ${p.name} (${p.prefix}...) with ${p.scopes.join(', ')}`,
      details: { keyId: p.keyId, scopes: p.scopes, expiresAt: p.expiresAt ?? null },
    };
  }),
  ApiKeyRevoked: always(async (_tx, e) => {
    const p = ev<'ApiKeyRevoked'>(e).payload;
    return { action: e.event.type, summary: 'API key revoked', details: { keyId: p.keyId } };
  }),
  SocialChannelConnected: always(async (_tx, e) => {
    const p = ev<'SocialChannelConnected'>(e).payload;
    return { action: e.event.type, summary: `Connected ${p.network}: ${p.accountName}` };
  }),
  SocialChannelDisconnected: always(async (_tx, e) => {
    const p = ev<'SocialChannelDisconnected'>(e).payload;
    return { action: e.event.type, summary: `Disconnected ${p.network}` };
  }),
  SuperAdminCreated: always(async (_tx, e) => {
    const p = ev<'SuperAdminCreated'>(e).payload;
    return { action: e.event.type, targetUserId: p.userId, summary: `Super admin ${p.email} created` };
  }),
  SuperAdminSignedIn: always(async (_tx, e) => {
    const p = ev<'SuperAdminSignedIn'>(e).payload;
    return { action: e.event.type, targetUserId: p.userId, summary: 'Signed in', meta: p.meta };
  }),
  PlatformBillingChanged: always(async (_tx, e) => {
    const p = ev<'PlatformBillingChanged'>(e).payload;
    return {
      action: e.event.type,
      summary:
        p.what === 'plan'
          ? `Edited the ${p.key ?? ''} plan: ${p.note}`
          : `Edited the billing settings: ${p.note}`,
      details: { before: p.before, after: p.after, note: p.note },
      meta: p.meta,
    };
  }),
  PlatformOrgViewed: always(async (tx, e) => {
    const p = ev<'PlatformOrgViewed'>(e).payload;
    return {
      action: e.event.type,
      orgId: p.orgId,
      summary: `Viewed ${await orgName(tx, p.orgId)}`,
      meta: p.meta,
    };
  }),
};
