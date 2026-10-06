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
  defineEvent('UserTimezoneChanged', z.object({ userId: Id, timezone: z.string().min(1).max(64) })),
  defineEvent('PasswordChanged', z.object({ userId: Id, passwordHash: z.string().min(1) })),
] as const;
