import { z } from 'zod';
import { UserAvatarSchema } from '../avatars/index.ts';
import { AssignableOrgRoleSchema, BannerSchema, OrgRoleSchema, OrgStatusSchema } from '../orgs/index.ts';
import { OrgLimitsSchema } from '../orgs/plans.ts';
import { IsoTime } from './common.ts';

/** Organization routes (docs/design/organizations.md section 10). All take the request org (`X-AOM-Org`). */

export const OrgRefSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  role: OrgRoleSchema,
  status: OrgStatusSchema,
});
export type OrgRef = z.infer<typeof OrgRefSchema>;

export const OrgUsageSchema = z.object({
  members: z.number().int(),
  projects: z.number().int(),
  agents: z.number().int(),
  workstations: z.number().int(),
});
export type OrgUsage = z.infer<typeof OrgUsageSchema>;

/** The organization the current tab works in, as `me` and `GET /api/org` describe it. */
export const ActiveOrgSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  role: OrgRoleSchema,
  status: OrgStatusSchema,
  plan: z.string(),
  planName: z.string(),
  features: z.record(z.string(), z.boolean()),
  /** Owner and Admins only. */
  limits: OrgLimitsSchema.optional(),
  usage: OrgUsageSchema.optional(),
  trialEndsAt: IsoTime.nullable().optional(),
  licenseExpiresAt: IsoTime.nullable().optional(),
  graceDays: z.number().int().optional(),
  /** The Owner requires two-factor login of every member. */
  requireTwoFactor: z.boolean().default(false),
  /** A simulation organization: shown with an always-visible banner; mock workstation, never billed. */
  simulation: z.boolean().default(false),
  banners: z.array(BannerSchema),
  /**
   * Owner only: the organization is paused for a billing reason the Owner fixes with a card, so the app shows one full-page
   * screen instead of the product. `setup`: a new sign-up that has not saved its card yet (starts the 7-day trial);
   * `resubscribe`: paused after a failed payment (`payment_failed`) or a cancellation (`cancelled`).
   */
  gate: z
    .object({
      kind: z.enum(['setup', 'resubscribe']),
      reason: z.enum(['setup', 'payment_failed', 'cancelled']),
    })
    .nullable()
    .default(null),
});
export type ActiveOrg = z.infer<typeof ActiveOrgSchema>;

export const GuestOrgRefSchema = z.object({
  orgId: z.uuid(),
  orgName: z.string(),
  projects: z.array(z.object({ id: z.uuid(), key: z.string(), name: z.string() })),
});
export type GuestOrgRef = z.infer<typeof GuestOrgRefSchema>;

export const OrgsResponseSchema = z.object({
  orgs: z.array(OrgRefSchema),
  guestIn: z.array(GuestOrgRefSchema),
});
export type OrgsResponse = z.infer<typeof OrgsResponseSchema>;

export const SwitchOrgRequestSchema = z.object({ orgId: z.uuid() });

export const OrgDetailResponseSchema = ActiveOrgSchema.extend({
  owner: z.object({ id: z.uuid(), displayName: z.string(), email: z.string() }),
  createdAt: IsoTime,
});
export type OrgDetailResponse = z.infer<typeof OrgDetailResponseSchema>;

export const PatchOrgRequestSchema = z
  .object({ name: z.string().trim().min(1).max(120), requireTwoFactor: z.boolean() })
  .partial()
  .refine(
    (v) => v.name !== undefined || v.requireTwoFactor !== undefined,
    'name or requireTwoFactor is required',
  );
export type PatchOrgRequest = z.infer<typeof PatchOrgRequestSchema>;

export const OrgMemberDtoSchema = z.object({
  userId: z.uuid(),
  displayName: z.string(),
  email: z.string(),
  role: OrgRoleSchema,
  joinedAt: IsoTime,
  /** Owners and Admins see every project. */
  allProjects: z.boolean(),
  projects: z.array(z.object({ id: z.uuid(), key: z.string(), name: z.string() })),
  twoFactorEnabled: z.boolean(),
  avatar: UserAvatarSchema.nullable().optional(),
});
export type OrgMemberDto = z.infer<typeof OrgMemberDtoSchema>;
export const OrgMembersResponseSchema = z.object({ members: z.array(OrgMemberDtoSchema) });

export const OrgMemberParamsSchema = z.object({ userId: z.uuid() });
export const PatchOrgMemberRequestSchema = z.object({ role: AssignableOrgRoleSchema });
export const SetMemberProjectsRequestSchema = z.object({ projectIds: z.array(z.uuid()).max(500) });

export const OrgRemovalPreviewSchema = z.object({
  userId: z.uuid(),
  displayName: z.string(),
  projects: z.array(z.object({ key: z.string(), name: z.string() })),
  agents: z.array(z.object({ id: z.uuid(), name: z.string(), roleKey: z.string() })),
  releasedCards: z.array(z.object({ ref: z.string(), title: z.string() })),
  transferredCards: z.array(z.object({ ref: z.string(), title: z.string(), status: z.string() })),
});
export type OrgRemovalPreview = z.infer<typeof OrgRemovalPreviewSchema>;

export const TransferOwnershipRequestSchema = z.object({
  userId: z.uuid(),
  password: z.string().min(1).max(256),
});

export const OrgInvitationDtoSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  orgRole: OrgRoleSchema,
  projectIds: z.array(z.uuid()),
  status: z.enum(['pending', 'accepted', 'revoked']),
  invitedByName: z.string().nullable(),
  expiresAt: IsoTime,
  createdAt: IsoTime,
  acceptedAt: IsoTime.nullable(),
});
export type OrgInvitationDto = z.infer<typeof OrgInvitationDtoSchema>;
export const OrgInvitationsResponseSchema = z.object({ invitations: z.array(OrgInvitationDtoSchema) });
export const CreateOrgInvitationRequestSchema = z.object({
  email: z.email(),
  role: AssignableOrgRoleSchema.default('member'),
  projectIds: z.array(z.uuid()).max(500).default([]),
});
export type CreateOrgInvitationRequest = z.infer<typeof CreateOrgInvitationRequestSchema>;

export const OrgGuestDtoSchema = z.object({
  userId: z.uuid(),
  displayName: z.string(),
  email: z.string(),
  projects: z.array(z.object({ id: z.uuid(), key: z.string(), name: z.string() })),
  since: IsoTime.nullable(),
});
export type OrgGuestDto = z.infer<typeof OrgGuestDtoSchema>;
export const OrgGuestsResponseSchema = z.object({ guests: z.array(OrgGuestDtoSchema) });
