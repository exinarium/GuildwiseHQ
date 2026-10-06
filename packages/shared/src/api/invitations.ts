import { z } from 'zod';
import { OrgRoleSchema } from '../orgs/index.ts';
import { PasswordSchema } from './auth.ts';
import { IsoTime } from './common.ts';

/** `GET /api/invitations/:token` (public). */
export const InvitationInfoResponseSchema = z.object({
  kind: z.enum(['legacy', 'new_org', 'org_member']).default('legacy'),
  email: z.string(),
  expiresAt: IsoTime,
  invitedBy: z.string().nullable().default(null),
  /** org_member: the organization joined. */
  orgName: z.string().nullable().default(null),
  /** new_org (and legacy): the proposed name of the new organization, editable on accept. */
  proposedOrgName: z.string().nullable().default(null),
  role: OrgRoleSchema.nullable().default(null),
  /** An account with this email exists: sign in to accept instead of choosing a password. */
  accountExists: z.boolean().default(false),
  /** new_org: a one-line summary of the terms ("Founding plan", "Trial ends 5 Nov"). */
  terms: z.string().nullable().default(null),
});
export type InvitationInfoResponse = z.infer<typeof InvitationInfoResponseSchema>;

/** `POST /api/invitations/:token/accept` -> MeResponse (and sets the session cookie). New accounts only. */
export const AcceptInvitationRequestSchema = z.object({
  displayName: z.string().min(1).max(120),
  password: PasswordSchema,
  /** new_org: the invitee may rename the organization. */
  orgName: z.string().trim().min(1).max(120).optional(),
});
export type AcceptInvitationRequest = z.infer<typeof AcceptInvitationRequestSchema>;
/** `POST /api/invitations/:token/accept-existing`: signed in with the invited email. */
export const AcceptExistingInvitationRequestSchema = z.object({
  orgName: z.string().trim().min(1).max(120).optional(),
});
export type AcceptExistingInvitationRequest = z.infer<typeof AcceptExistingInvitationRequestSchema>;
export const InvitationTokenParamsSchema = z.object({ token: z.string().min(16) });
