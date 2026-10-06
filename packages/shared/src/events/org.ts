import { z } from 'zod';
import { OrgFeatureSchema, OrgLimitsSchema } from '../orgs/plans.ts';
import { defineEvent, Id, IsoDate } from './define.ts';

/** Request metadata a super admin's action carries into the platform audit log. */
export const EventMetaSchema = z
  .object({ ip: z.string().max(64).optional(), userAgent: z.string().max(400).optional() })
  .optional();
export type EventMeta = z.infer<typeof EventMetaSchema>;

export const OrgStatusSchemaEv = z.enum(['trial', 'active', 'suspended', 'cancelled']);
const Features = z.record(z.string(), z.boolean());

/**
 * Organization events (docs/design/organizations.md section 3), stream `org-<orgId>`, audience `org` unless noted.
 * Platform events by a super admin carry `meta` for the audit log.
 */
export const orgEvents = [
  defineEvent(
    'OrganizationCreated',
    z.object({
      orgId: Id,
      name: z.string().min(1).max(120),
      ownerUserId: Id,
      plan: z.string().min(1),
      status: OrgStatusSchemaEv,
      limits: OrgLimitsSchema,
      trialEndsAt: IsoDate.optional(),
      licenseExpiresAt: IsoDate.optional(),
      features: Features.default({}),
      createdVia: z.enum(['legacy_migration', 'invitation', 'cli']),
      invitationId: Id.optional(),
    }),
  ),
  defineEvent(
    'OrganizationRenamed',
    z.object({ orgId: Id, name: z.string().min(1).max(120), by: Id.optional() }),
  ),
  defineEvent(
    'OrgMemberAdded',
    z.object({
      orgId: Id,
      userId: Id,
      role: z.enum(['owner', 'admin', 'member']),
      via: z.enum(['invitation', 'migration', 'bootstrap']),
      invitationId: Id.optional(),
      invitedBy: Id.optional(),
      projectIds: z.array(Id).optional(),
    }),
  ),
  defineEvent(
    'OrgMemberRoleChanged',
    z.object({ orgId: Id, userId: Id, role: z.enum(['admin', 'member']), by: Id.optional() }),
  ),
  defineEvent(
    'OrgMemberRemoved',
    z.object({
      orgId: Id,
      userId: Id,
      reason: z.enum(['removed', 'left', 'deactivated']),
      by: Id.optional(),
    }),
  ),
  defineEvent(
    'OrgOwnershipTransferred',
    z.object({
      orgId: Id,
      fromUserId: Id,
      toUserId: Id,
      /** Set when a super admin transferred the ownership (support case); the reason is mandatory then. */
      reason: z.string().max(500).optional(),
      meta: EventMetaSchema,
    }),
  ),
  defineEvent(
    'OrgStatusChanged',
    z.object({
      orgId: Id,
      status: OrgStatusSchemaEv,
      reason: z.string().min(1).max(200),
      note: z.string().max(1000).optional(),
      previous: z.object({ status: OrgStatusSchemaEv, reason: z.string().nullable() }).optional(),
      meta: EventMetaSchema,
    }),
  ),
  defineEvent(
    'OrgPlanChanged',
    z.object({
      orgId: Id,
      plan: z.string().min(1),
      limitsReset: z.boolean().default(false),
      previous: z.object({ plan: z.string() }).optional(),
      /** The limits and features the plan defaults gave, when `limitsReset`. */
      limits: OrgLimitsSchema.optional(),
      features: Features.optional(),
      note: z.string().max(1000).optional(),
      meta: EventMetaSchema,
    }),
  ),
  defineEvent(
    'OrgLimitsSet',
    z.object({
      orgId: Id,
      limits: OrgLimitsSchema,
      previous: OrgLimitsSchema.optional(),
      note: z.string().max(1000).optional(),
      meta: EventMetaSchema,
    }),
  ),
  defineEvent(
    'OrgDatesSet',
    z.object({
      orgId: Id,
      trialEndsAt: IsoDate.nullable(),
      licenseExpiresAt: IsoDate.nullable(),
      graceDays: z.number().int().min(0).max(90).optional(),
      previous: z
        .object({
          trialEndsAt: IsoDate.nullable(),
          licenseExpiresAt: IsoDate.nullable(),
          graceDays: z.number().int(),
        })
        .optional(),
      note: z.string().max(1000).optional(),
      meta: EventMetaSchema,
    }),
  ),
  defineEvent(
    'OrgFeaturesSet',
    z.object({
      orgId: Id,
      /** `null` puts the feature back to the plan default. */
      features: z.record(OrgFeatureSchema, z.boolean().nullable()),
      previous: Features.optional(),
      note: z.string().max(1000).optional(),
      meta: EventMetaSchema,
    }),
  ),
  /** Owner decision 7: the Owner can require two-factor login of every member of the organization. */
  defineEvent('OrgTwoFactorPolicySet', z.object({ orgId: Id, required: z.boolean(), by: Id })),
  defineEvent('PlatformOrgViewed', z.object({ orgId: Id, meta: EventMetaSchema })),
] as const;
