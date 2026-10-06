import { z } from 'zod';
import { OrgStatusSchema } from '../orgs/index.ts';
import { OrgFeatureSchema, OrgLimitsSchema } from '../orgs/plans.ts';
import { IsoTime } from './common.ts';
import { OrgUsageSchema } from './orgs.ts';

/** Platform routes for the super admin (docs/design/organizations.md sections 10 and 11.3). Metadata only. */

export const PlatformOrgSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  owner: z.object({ id: z.uuid(), displayName: z.string(), email: z.string() }),
  memberCount: z.number().int(),
  status: OrgStatusSchema,
  statusReason: z.string().nullable(),
  plan: z.string(),
  planName: z.string(),
  limits: OrgLimitsSchema,
  usage: OrgUsageSchema,
  trialEndsAt: IsoTime.nullable(),
  licenseExpiresAt: IsoTime.nullable(),
  requireTwoFactor: z.boolean(),
  createdAt: IsoTime,
  lastActiveAt: IsoTime.nullable(),
});
export type PlatformOrgSummary = z.infer<typeof PlatformOrgSummarySchema>;
export const PlatformOrgsResponseSchema = z.object({ orgs: z.array(PlatformOrgSummarySchema) });
export const PlatformOrgsQuerySchema = z.object({
  status: OrgStatusSchema.optional(),
  q: z.string().max(200).optional(),
  sort: z.enum(['name', 'created', 'active', 'members']).default('name'),
});

export const PlatformAuditRowSchema = z.object({
  seq: z.number().int(),
  at: IsoTime,
  actorKind: z.string(),
  actorUserId: z.uuid().nullable(),
  actorName: z.string().nullable(),
  action: z.string(),
  orgId: z.uuid().nullable(),
  orgName: z.string().nullable(),
  summary: z.string(),
  details: z.record(z.string(), z.unknown()),
  ip: z.string().nullable(),
});
export type PlatformAuditRow = z.infer<typeof PlatformAuditRowSchema>;
export const PlatformAuditResponseSchema = z.object({
  rows: z.array(PlatformAuditRowSchema),
  next: z.number().int().nullable(),
});
export const PlatformAuditQuerySchema = z.object({
  orgId: z.uuid().optional(),
  actorId: z.uuid().optional(),
  action: z.string().max(80).optional(),
  before: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const PlatformOrgDetailSchema = PlatformOrgSummarySchema.extend({
  features: z.record(z.string(), z.boolean()),
  featureOverrides: z.record(z.string(), z.boolean()),
  graceDays: z.number().int(),
  billing: z.object({
    provider: z.string().nullable(),
    customerRef: z.string().nullable(),
    subscriptionRef: z.string().nullable(),
  }),
  shifts30d: z.number().int(),
  admins: z.array(z.object({ id: z.uuid(), displayName: z.string(), email: z.string() })),
  recentAudit: z.array(PlatformAuditRowSchema),
});
export type PlatformOrgDetail = z.infer<typeof PlatformOrgDetailSchema>;

export const PatchPlatformOrgRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    plan: z.string().min(1),
    limitsReset: z.boolean(),
    limits: OrgLimitsSchema,
    trialEndsAt: z.iso.datetime().nullable(),
    licenseExpiresAt: z.iso.datetime().nullable(),
    graceDays: z.number().int().min(0).max(90),
    features: z.partialRecord(OrgFeatureSchema, z.boolean().nullable()),
    /** Mandatory for changes that affect the organization; shown in the audit log. */
    note: z.string().trim().min(1).max(1000),
  })
  .partial()
  .refine((v) => Object.keys(v).some((k) => k !== 'note'), 'nothing to change');
export type PatchPlatformOrgRequest = z.infer<typeof PatchPlatformOrgRequestSchema>;

export const OrgStatusActionRequestSchema = z.object({
  reason: z.string().trim().min(1).max(200),
  note: z.string().trim().max(1000).optional(),
});
export type OrgStatusActionRequest = z.infer<typeof OrgStatusActionRequestSchema>;

export const PlatformTransferOwnershipRequestSchema = z.object({
  toUserId: z.uuid(),
  reason: z.string().trim().min(1).max(500),
});

export const NewOrgInvitationRequestSchema = z.object({
  email: z.email(),
  proposedOrgName: z.string().trim().min(1).max(120),
  plan: z.string().min(1).default('founding'),
  status: z.enum(['trial', 'active']).default('active'),
  limits: OrgLimitsSchema.optional(),
  trialEndsAt: z.iso.datetime().optional(),
  licenseExpiresAt: z.iso.datetime().optional(),
  features: z.partialRecord(OrgFeatureSchema, z.boolean().nullable()).optional(),
});
export type NewOrgInvitationRequest = z.infer<typeof NewOrgInvitationRequestSchema>;

export const PlatformInvitationDtoSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  proposedOrgName: z.string().nullable(),
  plan: z.string().nullable(),
  status: z.enum(['pending', 'accepted', 'revoked']),
  expiresAt: IsoTime,
  createdAt: IsoTime,
  acceptedAt: IsoTime.nullable(),
  invitedByName: z.string().nullable(),
});
export type PlatformInvitationDto = z.infer<typeof PlatformInvitationDtoSchema>;
export const PlatformInvitationsResponseSchema = z.object({
  invitations: z.array(PlatformInvitationDtoSchema),
});

export const PlatformUserDtoSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  status: z.enum(['active', 'deactivated']),
  kind: z.enum(['user', 'super_admin']),
  orgCount: z.number().int(),
  ownedOrgs: z.array(z.object({ id: z.uuid(), name: z.string(), status: OrgStatusSchema })),
  twoFactorEnabled: z.boolean(),
  createdAt: IsoTime,
  lastLoginAt: IsoTime.nullable(),
});
export type PlatformUserDto = z.infer<typeof PlatformUserDtoSchema>;
export const PlatformUsersResponseSchema = z.object({ users: z.array(PlatformUserDtoSchema) });
export const PatchPlatformUserRequestSchema = z.object({ status: z.enum(['active', 'deactivated']) });
