import { z } from 'zod';
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
  defineEvent('PasswordChanged', z.object({ userId: Id, passwordHash: z.string().min(1) })),
] as const;
