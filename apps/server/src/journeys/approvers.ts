import type { JourneyApprover } from '@aom/shared';
import { orgOwnerId, orgRoleOf } from '../auth/org-context.ts';
import { resolveApprover } from '../commands/approval.ts';
import { rows, type Queryable, type Row } from '../db/sql.ts';

export interface ResolvedApprover {
  userIds: string[];
  /** Several holders (a role): the first decision wins. */
  role?: string;
  fellBack: boolean;
}

/**
 * Who may act. A named user who left the project falls back to the organization Owner (and it is shown). A role goes to every
 * active holder. The Owner and Admins do NOT decide for a named user.
 */
export async function resolveJourneyApprover(
  db: Queryable,
  inst: Row,
  a: JourneyApprover,
): Promise<ResolvedApprover> {
  if (a.kind === 'org_role') {
    if (a.role === 'owner') return { userIds: [await orgOwnerId(db, inst.org_id)], role: 'owner', fellBack: false };
    const admins = await rows(
      db,
      `SELECT om.user_id FROM org_members om JOIN users u ON u.id = om.user_id
        WHERE om.org_id=$1 AND om.role='admin' AND om.status='active' AND u.status='active' ORDER BY om.joined_at, om.user_id`,
      [inst.org_id],
    );
    const ids = admins.map((r) => r.user_id as string);
    return ids.length
      ? { userIds: ids, role: 'admin', fellBack: false }
      : { userIds: [await orgOwnerId(db, inst.org_id)], role: 'admin', fellBack: true };
  }
  const r = await resolveApprover(db, inst as Row, a.kind === 'member' ? { kind: 'member', userId: a.userId } : ({ kind: a.kind } as never));
  return { userIds: [r.userId], fellBack: r.fellBack };
}

/** May this user decide the gate? Only the named user, holder of the named role, or the owner after a fallback. */
export async function mayDecideGate(db: Queryable, userId: string, inst: Row, wait: Row): Promise<boolean> {
  const approver = (wait.config as { approver?: JourneyApprover }).approver;
  if (!approver) return false;
  const r = await resolveJourneyApprover(db, inst, approver);
  if (r.userIds.includes(userId)) return true;
  return r.role === 'admin' && (await orgRoleOf(db, userId, inst.org_id)) === 'admin';
}
