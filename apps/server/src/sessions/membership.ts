import type { Ctx } from '../context.ts';
import { one, type Row } from '../db/sql.ts';

/**
 * A session turn acts for the person who queued it. When that person has left the organization (or was removed) after the
 * turn started, its verbs stop working: the session is theirs, not the organization's.
 */
export async function requesterIsMember(ctx: Ctx, turn: Row, thread: Row): Promise<boolean> {
  const userId = (turn.requested_by ?? thread.created_by) as string | null;
  if (!userId) return false;
  return !!(await one(
    ctx.pool,
    `SELECT 1 FROM org_members WHERE org_id=$1 AND user_id=$2 AND status='active'`,
    [turn.org_id, userId],
  ));
}

export const NOT_A_MEMBER = 'the person who started this session is no longer a member of the organization';
