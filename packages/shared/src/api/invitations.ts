import { z } from 'zod';
import { UserRole } from '../events/define.ts';
import { PasswordSchema } from './auth.ts';
import { IsoTime } from './common.ts';

/** `GET /api/invitations/:token` */
export const InvitationInfoResponseSchema = z.object({
  email: z.string(),
  role: UserRole.optional(),
  expiresAt: IsoTime,
});
export type InvitationInfoResponse = z.infer<typeof InvitationInfoResponseSchema>;

/** `POST /api/invitations/:token/accept` -> MeResponse (and sets the session cookie). */
export const AcceptInvitationRequestSchema = z.object({
  displayName: z.string().min(1).max(120),
  password: PasswordSchema,
});
export type AcceptInvitationRequest = z.infer<typeof AcceptInvitationRequestSchema>;
export const InvitationTokenParamsSchema = z.object({ token: z.string().min(16) });
