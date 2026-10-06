import { z } from 'zod';
import { AvatarSeedSchema, AvatarStyleSchema } from '../avatars/index.ts';
import { defineEvent, Id, IsoDate, UserRole } from './define.ts';

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
  defineEvent('UserRoleChanged', z.object({ userId: Id, role: UserRole })),
  defineEvent('UserDeactivated', z.object({ userId: Id })),
  defineEvent('UserReactivated', z.object({ userId: Id })),
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
