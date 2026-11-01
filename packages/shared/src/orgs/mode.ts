import { z } from 'zod';
import { isBusinessRoleKey } from '../roles/business.ts';

/**
 * VIEWS. An organization has a default view and each member may override it for themselves. A view is presentation only:
 * it decides what the web leads with and which words it uses, and it never refuses, installs, removes or changes anything.
 * Every capability (workflows, card types, roles, rule packs, playbooks, relay integrations, repositories) is available to
 * every organization whichever view is in use.
 *
 * Internal values stay `dev` (shown as "Software view") and `business` ("Business view"); the type keeps the name `OrgMode`.
 */
export const ORG_MODES = ['dev', 'business'] as const;
export const OrgModeSchema = z.enum(ORG_MODES);
export type OrgMode = z.infer<typeof OrgModeSchema>;
export const ORG_MODE_LABEL: Record<OrgMode, string> = { dev: 'Software view', business: 'Business view' };

/** The organization's DEFAULT view is Business. Absent or unknown: Software. Server text for no single reader uses this. */
export const isBusinessOrg = (org: { mode?: string | null } | null | undefined): boolean =>
  org?.mode === 'business';

/** The view in effect for a member: their own override, else the organization default. Absent or unknown: `dev`. */
export function effectiveView(
  org: { mode?: string | null; viewOverride?: string | null } | null | undefined,
): OrgMode {
  const v = org?.viewOverride ?? org?.mode;
  return v === 'business' ? 'business' : 'dev';
}

/** THE gate for every Business-view difference in the web: presentation only, never a refusal. Keep this name stable. */
export const isBusinessView = (
  org: { mode?: string | null; viewOverride?: string | null } | null | undefined,
): boolean => effectiveView(org) === 'business';

/** Built-in roles that belong to software delivery: listed under "More" in the Business view, never removed. */
export const DEV_ONLY_ROLE_KEYS = ['builder', 'reviewer', 'pre_reviewer', 'tester', 'devops'] as const;
export const isDevOnlyRoleKey = (key: string): boolean =>
  (DEV_ONLY_ROLE_KEYS as readonly string[]).includes(key);

/**
 * Where a role is listed in a view: `main` leads, `more` sits under a "More" fold. Both are offered, hireable and
 * resolvable in every organization; only the grouping depends on the view.
 */
export function roleGroupInView(roleKey: string, view: OrgMode | string | null | undefined): 'main' | 'more' {
  return view === 'business'
    ? isDevOnlyRoleKey(roleKey)
      ? 'more'
      : 'main'
    : isBusinessRoleKey(roleKey)
      ? 'more'
      : 'main';
}
