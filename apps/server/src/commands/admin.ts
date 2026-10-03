import { streamId } from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { exec, one } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { conflict, notFound } from '../errors.ts';

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
