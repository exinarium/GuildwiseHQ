import { streamId } from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { exec, one, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { conflict, notFound } from '../errors.ts';
import { removeMemberIn } from './sharing.ts';
import { unlinkWorkstationIn } from './workstations.ts';

const ADMIN_SCOPE = { orgId: null, projectId: null, audience: 'admin' } as const;

export async function patchUser(
  ctx: Ctx,
  admin: AuthSession,
  userId: string,
  patch: { role?: 'admin' | 'member'; status?: 'active' | 'deactivated' },
) {
  await withAppendTx(ctx.pool, async (tx) => {
    const u = await one(tx, 'SELECT id, role, status FROM users WHERE id=$1 FOR UPDATE', [userId]);
    if (!u) throw notFound('user not found');
    const adminCount = async () =>
      Number(
        (await one(tx, `SELECT count(*)::int AS n FROM users WHERE role='admin' AND status='active'`))?.n ??
          0,
      );
    const events = [];
    const base = { actor: { kind: 'user', id: admin.user.id } as const, scope: ADMIN_SCOPE };
    if (patch.role !== undefined && patch.role !== u.role) {
      if (u.role === 'admin' && u.status === 'active' && (await adminCount()) <= 1) {
        throw conflict('last_admin', 'cannot demote the last active administrator');
      }
      events.push({
        ...base,
        streamId: streamId.user(userId),
        event: { type: 'UserRoleChanged' as const, payload: { userId, role: patch.role } },
      });
    }
    if (patch.status !== undefined && patch.status !== u.status) {
      if (patch.status === 'deactivated') {
        if (userId === admin.user.id) throw conflict('self_deactivate', 'you cannot deactivate yourself');
        if (u.role === 'admin' && (await adminCount()) <= 1) {
          throw conflict('last_admin', 'cannot deactivate the last active administrator');
        }
        // Cut off everything the account could still reach: its projects first (releases the claims of its
        // agents and hands them to the owners, as a member removal does), then its runners (claims, shifts and
        // queued commands go, the gateway closes the sockets). Each step is its own append inside this transaction.
        const memberships = await rows(
          tx,
          `SELECT pm.project_id, p.* FROM project_members pm JOIN projects p ON p.id = pm.project_id
            WHERE pm.user_id=$1 AND pm.role <> 'owner' AND pm.status IN ('active','invited')`,
          [userId],
        );
        for (const m of memberships) await removeMemberIn(ctx, tx, admin.user.id, m, userId);
        const stations = await rows<{ id: string }>(
          tx,
          `SELECT id FROM workstations WHERE user_id=$1 AND status='active'`,
          [userId],
        );
        for (const w of stations) await unlinkWorkstationIn(ctx, tx, admin.user.id, w.id, userId, 'admin');
        events.push({
          ...base,
          streamId: streamId.user(userId),
          event: { type: 'UserDeactivated' as const, payload: { userId } },
        });
        await exec(tx, 'DELETE FROM auth_sessions WHERE user_id=$1', [userId]);
      } else {
        events.push({
          ...base,
          streamId: streamId.user(userId),
          event: { type: 'UserReactivated' as const, payload: { userId } },
        });
      }
    }
    await ctx.store.append(events, { tx });
  });
}
