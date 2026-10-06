import { z } from 'zod';
import { UserAvatarSchema } from '../avatars/index.ts';
import { IsoTime } from './common.ts';
import { ActiveOrgSchema, GuestOrgRefSchema, OrgRefSchema } from './orgs.ts';

export const LoginRequestSchema = z.object({ email: z.email(), password: z.string().min(1).max(256) });
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const UserDtoSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  /** `super_admin` accounts belong to no organization and see the platform area only. */
  kind: z.enum(['user', 'super_admin']).default('user'),
  status: z.enum(['active', 'deactivated']),
  createdAt: IsoTime,
  lastLoginAt: IsoTime.nullable(),
  /** IANA zone (`Europe/Amsterdam`): browser-detected on first login, editable. Null until set. */
  timezone: z.string().nullable().optional(),
  /** The user's picture (null: initials). */
  avatar: UserAvatarSchema.nullable().optional(),
  twoFactorEnabled: z.boolean().default(false),
});
export type UserDto = z.infer<typeof UserDtoSchema>;

/** Two-factor state of the account (owner decision 7). */
export const TwoFactorStateSchema = z.object({
  enabled: z.boolean(),
  /** The account must have it (super admin, or an organization the user belongs to requires it). */
  required: z.boolean(),
  /** Required but not set up yet: the session can only reach the setup endpoints until it is. */
  setupRequired: z.boolean(),
});
export type TwoFactorState = z.infer<typeof TwoFactorStateSchema>;

/** `GET /api/auth/me`; also the response of login and invitation accept. */
export const MeResponseSchema = z.object({
  user: UserDtoSchema,
  account: z.object({ kind: z.enum(['user', 'super_admin']) }).default({ kind: 'user' }),
  /** Deprecated alias for one release: the active org's role is owner or admin. */
  isAdmin: z.boolean(),
  /** Memberships (suspended ones are flagged by `status`). */
  orgs: z.array(OrgRefSchema).default([]),
  /** The organization of the request (`X-AOM-Org`, else the session's default). Null: platform account. */
  activeOrg: ActiveOrgSchema.nullable().default(null),
  /** Organizations where the user is a guest, with the projects they are on. */
  guestIn: z.array(GuestOrgRefSchema).default([]),
  guestProjectIds: z.array(z.uuid()).default([]),
  visibleProjectIds: z.array(z.uuid()),
  /** Org member invitations to this email plus pending project shares. */
  pendingInvitations: z.number().int().default(0),
  twoFactor: TwoFactorStateSchema.default({ enabled: false, required: false, setupRequired: false }),
  /** Server feature flags the UI follows. `mockUi`: show the mock-runtime card fields (dev and e2e only). */
  features: z.object({ mockUi: z.boolean() }).default({ mockUi: false }),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

/** `POST /api/auth/login`: a session, or (two-factor accounts) a challenge to answer with `/api/auth/login/2fa`. */
export const LoginChallengeResponseSchema = z.object({
  twoFactorRequired: z.literal(true),
  challenge: z.string().min(16),
  /** Recovery codes are accepted in place of the 6-digit code. */
  methods: z.array(z.enum(['totp', 'recovery'])),
});
export type LoginChallengeResponse = z.infer<typeof LoginChallengeResponseSchema>;
export const Login2faRequestSchema = z.object({
  challenge: z.string().min(16).max(200),
  /** A 6-digit code from the authenticator app, or a recovery code (`xxxxx-xxxxx`). */
  code: z.string().trim().min(6).max(32),
});
export type Login2faRequest = z.infer<typeof Login2faRequestSchema>;

/** `POST /api/auth/2fa/setup` (password re-entry): a fresh secret, not active until `enable` confirms a code. */
export const TwoFactorSetupRequestSchema = z.object({ password: z.string().min(1).max(256) });
export const TwoFactorSetupResponseSchema = z.object({
  secret: z.string(),
  otpauthUri: z.string(),
});
export type TwoFactorSetupResponse = z.infer<typeof TwoFactorSetupResponseSchema>;
export const TwoFactorEnableRequestSchema = z.object({ code: z.string().trim().length(6) });
/** The ten recovery codes are shown once. */
export const RecoveryCodesResponseSchema = z.object({ recoveryCodes: z.array(z.string()) });
export type RecoveryCodesResponse = z.infer<typeof RecoveryCodesResponseSchema>;
export const TwoFactorConfirmRequestSchema = z.object({
  password: z.string().min(1).max(256),
  code: z.string().trim().min(6).max(32),
});

export const PasswordSchema = z.string().min(12).max(256);

/** `POST /api/auth/password`: changes the signed-in user's password (other sessions are signed out). */
export const ChangePasswordRequestSchema = z.object({
  current: z.string().min(1).max(256),
  new: PasswordSchema,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;
