import type { OrgRole } from '@aom/shared';

/**
 * Whether the signed-in user is offered "Move to workstation" for an agent (the server decides in the end).
 * The organization's Owner and Admins move any agent but the CEO; the hiring manager moves their own agents;
 * a DevOps engineer moves only off an unpaired workstation, and only by an Owner or Admin.
 */
export function canMoveAgent(x: {
  myId?: string;
  orgRole?: OrgRole | null;
  managerUserId: string | null;
  roleKey: string;
  isDevops: boolean;
  status: string;
  unpaired: boolean;
}): boolean {
  if (!x.myId || x.status === 'retired' || x.roleKey === 'ceo') return false;
  const orgManager = x.orgRole === 'owner' || x.orgRole === 'admin';
  if (x.isDevops) return orgManager && x.unpaired;
  return orgManager || (!!x.orgRole && x.myId === x.managerUserId);
}
