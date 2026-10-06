import { z } from 'zod';

export * from './plans.ts';

/** Org roles (`org_members.role`). A guest is not a member: it is derived from project access (D8). */
export const ORG_ROLES = ['owner', 'admin', 'member'] as const;
export const OrgRoleSchema = z.enum(ORG_ROLES);
export type OrgRole = z.infer<typeof OrgRoleSchema>;

/** Roles an Owner or Admin can hand out (the Owner is changed only by a transfer). */
export const AssignableOrgRoleSchema = z.enum(['admin', 'member']);
export type AssignableOrgRole = z.infer<typeof AssignableOrgRoleSchema>;

/** Owner 4 > Admin 3 > Member 2 > Guest 1 (relative to one organization); 0 = no relationship. */
export type Rank = 0 | 1 | 2 | 3 | 4;
export const RANK = { none: 0, guest: 1, member: 2, admin: 3, owner: 4 } as const;

export function rankOf(orgRole: OrgRole | null | undefined, isGuest: boolean): Rank {
  if (orgRole === 'owner') return 4;
  if (orgRole === 'admin') return 3;
  if (orgRole === 'member') return 2;
  return isGuest ? 1 : 0;
}

export const ORG_STATUSES = ['trial', 'active', 'suspended', 'cancelled'] as const;
export const OrgStatusSchema = z.enum(ORG_STATUSES);
export type OrgStatus = z.infer<typeof OrgStatusSchema>;

/** The org's agents work, the scheduler fires and logins are open. */
export const isOrgOperational = (status: OrgStatus | string): boolean =>
  status === 'trial' || status === 'active';

export const ORG_CREATED_VIA = ['legacy_migration', 'invitation', 'cli'] as const;

export const ORG_STATUS_LABEL: Record<OrgStatus, string> = {
  trial: 'Trial',
  active: 'Active',
  suspended: 'Suspended',
  cancelled: 'Cancelled',
};
export const ORG_ROLE_LABEL: Record<OrgRole | 'guest', string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  guest: 'Guest',
};

/** Why an organization is in its status; free text is allowed for manual changes. */
export const STATUS_REASONS = ['manual', 'trial_ended', 'license_expired', 'billing'] as const;

export const BannerSchema = z.object({
  kind: z.enum(['suspended', 'cancelled', 'trial_ending', 'license_ending', 'over_limit', 'guest_view']),
  severity: z.enum(['danger', 'warning', 'info']),
  message: z.string(),
  /** Banners marked `managers` are only returned to the Owner and Admins. */
  audience: z.enum(['all', 'managers']).default('all'),
});
export type Banner = z.infer<typeof BannerSchema>;

export const LIMIT_KINDS = ['members', 'projects', 'agents', 'workstations'] as const;
export type LimitKind = (typeof LIMIT_KINDS)[number];

/** Role key of the built-in DevOps engineer: free, one per organization and workstation, never extendable (15a). */
export const DEVOPS_ROLE_KEY = 'devops';
