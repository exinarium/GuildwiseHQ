import { streamId } from '@aom/shared';
import { dummyHash, hashPassword, verifyPassword } from '../auth/password.ts';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { exec, one, rows } from '../db/sql.ts';
import { badRequest, unauthorized } from '../errors.ts';

/** Verifies credentials; uniform failure (same error, comparable time) for unknown user, wrong password, deactivated. */
export async function verifyLogin(ctx: Ctx, email: string, password: string): Promise<string> {
  const u = await one(
    ctx.pool,
    'SELECT id, password_hash, status FROM users WHERE lower(email) = lower($1)',
    [email],
  );
  const ok = await verifyPassword(u?.password_hash ?? (await dummyHash()), password);
  if (!u || !ok || u.status !== 'active') throw unauthorized('invalid email or password');
  return u.id as string;
}

export type { AuthSession };

/**
 * Changes the signed-in user's password (`PasswordChanged`). Every other session of the user is signed out; the
 * current one stays. A wrong current password is a 400 (not a 401: the user is still logged in).
 */
export async function changePassword(
  ctx: Ctx,
  session: AuthSession,
  current: string,
  next: string,
): Promise<void> {
  const u = await one(ctx.pool, 'SELECT password_hash FROM users WHERE id=$1', [session.user.id]);
  if (!u || !(await verifyPassword(u.password_hash, current)))
    throw badRequest('wrong_password', 'the current password is incorrect');
  if (current === next) throw badRequest('same_password', 'choose a password you have not used just now');
  await ctx.store.append([
    {
      streamId: streamId.user(session.user.id),
      event: {
        type: 'PasswordChanged',
        payload: { userId: session.user.id, passwordHash: await hashPassword(next) },
      },
      actor: { kind: 'user', id: session.user.id },
      scope: { orgId: null, projectId: null, audience: 'admin' },
    },
  ]);
  const others = await rows<{ id: string }>(
    ctx.pool,
    'SELECT id FROM auth_sessions WHERE user_id=$1 AND id <> $2',
    [session.user.id, session.sessionId],
  );
  await exec(ctx.pool, 'DELETE FROM auth_sessions WHERE user_id=$1 AND id <> $2', [
    session.user.id,
    session.sessionId,
  ]);
  for (const o of others) ctx.services.browser.closeSession(o.id);
}
