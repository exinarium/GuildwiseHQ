import { effectiveView, isBusinessView, type OrgMode } from '@aom/shared';
import { useMe } from '../api/queries/auth.ts';

/**
 * The view in effect for the signed-in member in the active organization: their own choice (user menu), else the
 * organization default (organization settings). A view is presentation only: it never blocks an action.
 */
export function useEffectiveView(): OrgMode {
  return effectiveView(useMe().data?.activeOrg);
}

/** True in the Business view: simpler words, business card types first, test environments and releases tucked away. */
export function useBusinessView(): boolean {
  return isBusinessView(useMe().data?.activeOrg);
}
