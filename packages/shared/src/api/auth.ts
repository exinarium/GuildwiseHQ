import { z } from 'zod';
import { UserRole } from '../events/define.ts';
import { IsoTime } from './common.ts';

export const LoginRequestSchema = z.object({ email: z.email(), password: z.string().min(1).max(256) });
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const UserDtoSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  role: UserRole,
  status: z.enum(['active', 'deactivated']),
  createdAt: IsoTime,
  lastLoginAt: IsoTime.nullable(),
  /** IANA zone (`Europe/Amsterdam`): browser-detected on first login, editable. Null until set. */
  timezone: z.string().nullable().optional(),
});
export type UserDto = z.infer<typeof UserDtoSchema>;

/** `GET /api/auth/me`; also the response of login and invitation accept. */
export const MeResponseSchema = z.object({
  user: UserDtoSchema,
  isAdmin: z.boolean(),
  visibleProjectIds: z.array(z.uuid()),
  /** Server feature flags the UI follows. `mockUi`: show the mock-runtime card fields (dev and e2e only). */
  features: z.object({ mockUi: z.boolean() }).default({ mockUi: false }),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const PasswordSchema = z.string().min(12).max(256);

/** `POST /api/auth/password`: changes the signed-in user's password (other sessions are signed out). */
export const ChangePasswordRequestSchema = z.object({
  current: z.string().min(1).max(256),
  new: PasswordSchema,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;
