import { isBusinessOrg, isDevOnlyRoleKey } from '@aom/shared';
import { useMe } from '../api/queries/auth.ts';

/** True when the active organization works in Business mode: the developer surfaces are hidden. */
export function useBusinessMode(): boolean {
  return isBusinessOrg(useMe().data?.activeOrg);
}

/** A seat a pack agent can take: the developer seats are not offered in a Business mode organization. */
export const seatAllowed = (seat: string, business: boolean): boolean =>
  !(business && isDevOnlyRoleKey(seat));
