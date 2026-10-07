import type { OrgRole } from '@aom/shared';
import { useMe } from '../api/queries/auth.ts';

/** The signed-in user's role in the tab's organization (null while loading, or for a guest). */
export function useActiveOrgRole(): OrgRole | null {
  const me = useMe();
  return me.data?.activeOrg?.role ?? null;
}

/** Owner or Admin of the tab's organization: sees the Costs page and may change budgets. */
export function useCanManageOrg(): boolean {
  const role = useActiveOrgRole();
  return role === 'owner' || role === 'admin';
}
