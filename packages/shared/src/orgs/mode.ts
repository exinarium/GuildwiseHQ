import { z } from 'zod';

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
