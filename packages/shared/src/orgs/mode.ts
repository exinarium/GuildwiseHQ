import { z } from 'zod';
import { isBusinessRoleKey } from '../roles/business.ts';

/** How an organization works: `dev` (software delivery, the default) or `business` (no repositories or code roles). */
export const ORG_MODES = ['dev', 'business'] as const;
export const OrgModeSchema = z.enum(ORG_MODES);
export type OrgMode = z.infer<typeof OrgModeSchema>;
export const ORG_MODE_LABEL: Record<OrgMode, string> = { dev: 'Developer', business: 'Business' };

/** THE gate for every Business mode difference, web and server. Absent or unknown: dev. Keep this name stable. */
export const isBusinessOrg = (org: { mode?: string | null } | null | undefined): boolean =>
  org?.mode === 'business';

/** Built-in roles that only exist for software delivery: not hired in a business organization. */
export const DEV_ONLY_ROLE_KEYS = ['builder', 'reviewer', 'pre_reviewer', 'tester', 'devops'] as const;
export const isDevOnlyRoleKey = (key: string): boolean =>
  (DEV_ONLY_ROLE_KEYS as readonly string[]).includes(key);

/** Whether a role is offered (hire lists, catalogue, seats, workflow owners) in an org of this mode. Absent mode: dev. */
export function roleOfferedInMode(roleKey: string, mode: OrgMode | string | null | undefined): boolean {
  return mode === 'business' ? !isDevOnlyRoleKey(roleKey) : !isBusinessRoleKey(roleKey);
}

/**
 * Whether a role shows in catalogue lists of an org of this mode. Only the business roles are hidden (from dev orgs): roles
 * an organization already holds, such as the built-in DevOps engineer of a business org, stay listed so names resolve.
 */
export const roleListedInMode = (roleKey: string, mode: OrgMode | string | null | undefined): boolean =>
  mode === 'business' || !isBusinessRoleKey(roleKey);
