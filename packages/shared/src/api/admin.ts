import { z } from 'zod';
import { UserRole } from '../events/define.ts';
import { UserDtoSchema } from './auth.ts';
import { IsoTime } from './common.ts';
import { WorkstationDtoSchema } from './workstations.ts';

export const AdminUsersResponseSchema = z.object({ users: z.array(UserDtoSchema) });
export const PatchUserRequestSchema = z
  .object({ role: UserRole, status: z.enum(['active', 'deactivated']) })
  .partial()
  .refine((v) => v.role !== undefined || v.status !== undefined, 'role or status is required');
export type PatchUserRequest = z.infer<typeof PatchUserRequestSchema>;

export const InvitationDtoSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  role: UserRole,
  status: z.enum(['pending', 'accepted', 'revoked']),
  invitedBy: z.uuid().nullable(),
  expiresAt: IsoTime,
  createdAt: IsoTime,
  acceptedAt: IsoTime.nullable(),
});
export type InvitationDto = z.infer<typeof InvitationDtoSchema>;
export const AdminInvitationsResponseSchema = z.object({ invitations: z.array(InvitationDtoSchema) });
export const CreateInvitationRequestSchema = z.object({ email: z.email(), role: UserRole.default('member') });
export type CreateInvitationRequest = z.infer<typeof CreateInvitationRequestSchema>;

export const AdminWorkstationDtoSchema = WorkstationDtoSchema.extend({ ownerEmail: z.string() });
export const AdminWorkstationsResponseSchema = z.object({ workstations: z.array(AdminWorkstationDtoSchema) });
