import { useCeoStatus } from '../../api/queries/ceo.ts';
import { useActiveOrgRole } from '../../lib/orgRole.ts';

/** The CEO's name for texts like "DevOps now works through <name>" (the status is an Admin endpoint: only fetched when asked). */
export function useCeoName(enabled = true): string {
  const role = useActiveOrgRole();
  const status = useCeoStatus(enabled && (role === 'owner' || role === 'admin'));
  return status.data?.agent?.name ?? 'your CEO';
}
