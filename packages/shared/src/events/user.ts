import { z } from 'zod';
import { AvatarSeedSchema, AvatarStyleSchema } from '../avatars/index.ts';
import { defineEvent, Id, IsoDate, UserRole } from './define.ts';
import { EventMetaSchema } from './org.ts';

export const userEvents = [
  defineEvent(
    'UserBootstrapped',
    z.object({
      userId: Id,
      email: z.email(),
      displayName: z.string().min(1),
      passwordHash: z.string().min(1),
      role: z.literal('admin'),
    }),
  ),
  defineEvent(
    'UserInvited',
    z.object({
      invitationId: Id,
      email: z.email(),
      role: UserRole,
      tokenHash: z.string().min(1),
      expiresAt: IsoDate,
      invitedBy: Id,
    }),
  ),
  defineEvent(
    'InvitationResent',
    z.object({ invitationId: Id, tokenHash: z.string().min(1), expiresAt: IsoDate }),
  ),
  defineEvent('InvitationRevoked', z.object({ invitationId: Id })),
  defineEvent(
    'InvitationAccepted',
    z.object({
      invitationId: Id,
      userId: Id,
      email: z.email(),
      displayName: z.string().min(1),
      passwordHash: z.string().min(1),
      role: UserRole,
    }),
  ),
  /** A new account (invitation accepted); its organization comes from `OrganizationCreated` / `OrgMemberAdded`. */
  defineEvent(
    'UserRegistered',
    z.object({
      userId: Id,
      email: z.email(),
      displayName: z.string().min(1),
      passwordHash: z.string().min(1),
      invitationId: Id.optional(),
      /** Self-service sign-up: the email counts as verified only after `UserEmailVerified`. */
      unverified: z.boolean().optional(),
    }),
  ),
  defineEvent('UserEmailVerified', z.object({ userId: Id })),
  /**
   * A self-service sign-up whose email was never verified within the grace period: the account and the empty organization
   * created for it are removed so the address can sign up again. The only event that deletes a user; the email, names
   * and dates are kept here because the projection rows are gone (the platform audit reads them from the event).
   */
  defineEvent(
    'SignupAbandoned',
    z.object({
      userId: Id,
      orgId: Id,
      email: z.string().min(1),
      displayName: z.string().min(1),
      orgName: z.string().min(1),
      registeredAt: IsoDate,
    }),
  ),
  /** The platform account: no organization, platform routes only. Created by the CLI only. */
  defineEvent(
    'SuperAdminCreated',
    z.object({
      userId: Id,
      email: z.email(),
      displayName: z.string().min(1),
      passwordHash: z.string().min(1),
    }),
  ),
  defineEvent('SuperAdminSignedIn', z.object({ userId: Id, meta: EventMetaSchema })),
  /** `new_org` (by a super admin, audience admin) and `org_member` (by an Owner or Admin, audience org). */
  defineEvent(
    'OrgInvitationCreated',
    z.object({
      invitationId: Id,
      kind: z.enum(['new_org', 'org_member']),
      email: z.email(),
      orgId: Id.optional(),
      orgRole: z.enum(['owner', 'admin', 'member']),
      proposedOrgName: z.string().min(1).max(120).optional(),
      orgTerms: z.record(z.string(), z.unknown()).optional(),
      projectIds: z.array(Id).default([]),
      tokenHash: z.string().min(1),
      expiresAt: IsoDate,
      invitedBy: Id,
      meta: EventMetaSchema,
    }),
  ),
  defineEvent('OrgInvitationAccepted', z.object({ invitationId: Id, userId: Id })),
  /** Two-factor login (owner decision 7). The secret and the recovery codes never enter the event log. */
  defineEvent('TwoFactorEnabled', z.object({ userId: Id })),
  defineEvent(
    'TwoFactorDisabled',
    z.object({
      userId: Id,
      /** Who switched it off: the user, an organization Owner (reset) or a super admin (reset). */
      by: Id,
      reason: z.enum(['user', 'reset']),
      meta: EventMetaSchema,
    }),
  ),
  defineEvent('TwoFactorRecoveryCodesRegenerated', z.object({ userId: Id })),
  defineEvent('TwoFactorRecoveryCodeUsed', z.object({ userId: Id })),
  defineEvent('UserRoleChanged', z.object({ userId: Id, role: UserRole })),
  defineEvent('UserDeactivated', z.object({ userId: Id, meta: EventMetaSchema })),
  defineEvent('UserReactivated', z.object({ userId: Id, meta: EventMetaSchema })),
  /** The user's own picture: a generated face, an uploaded image (stored server-side under `imageId`) or none. */
  defineEvent(
    'UserAvatarSet',
    z.object({
      userId: Id,
      kind: z.enum(['cartoon', 'image', 'none']),
      seed: AvatarSeedSchema.optional(),
      style: AvatarStyleSchema.optional(),
      imageId: Id.optional(),
    }),
  ),
  /** The user hid (or reopened) their "Get started" checklist. Kept per user, so it stays hidden on other devices. */
  defineEvent('UserSetupChecklistChanged', z.object({ userId: Id, dismissed: z.boolean() })),
  defineEvent('UserTimezoneChanged', z.object({ userId: Id, timezone: z.string().min(1).max(64) })),
  /** The first-login tour: where the user is in it (`step`, 0-based) and whether they finished or skipped it. Replaying sets `in_progress` at step 0. */
  defineEvent(
    'UserTourStateChanged',
    z.object({
      userId: Id,
      status: z.enum(['in_progress', 'completed', 'dismissed']),
      step: z.number().int().min(0).max(100),
    }),
  ),
  /** The user closed the "What's new" popup: these entries (ids = file names of the bundled release notes) are seen. */
  defineEvent(
    'UserWhatsNewSeen',
    z.object({ userId: Id, entryIds: z.array(z.string().min(1).max(200)).min(1).max(200) }),
  ),
  /** The user turned expert mode for version control on or off (default off): it brings back branch names, completion pickers and "Mark merged". */
  defineEvent('UserGitExpertModeSet', z.object({ userId: Id, enabled: z.boolean() })),
  defineEvent('PasswordChanged', z.object({ userId: Id, passwordHash: z.string().min(1) })),
  /**
   * An organization Owner set a temporary password for a member (the temporary password itself is never in the log).
   * The member must choose a new password at next sign-in (`must_change_password`, cleared by `PasswordChanged`).
   */
  defineEvent(
    'MemberPasswordReset',
    z.object({ userId: Id, orgId: Id, by: Id, passwordHash: z.string().min(1) }),
  ),
  /** A super admin sent the user a password reset link (the platform audit log shows it). The link itself is not in the log. */
  defineEvent('PasswordResetLinkSent', z.object({ userId: Id, by: Id, meta: EventMetaSchema })),
] as const;
