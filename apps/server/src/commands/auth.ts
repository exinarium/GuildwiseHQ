import { streamId } from '@aom/shared';
import { dummyHash, hashPassword, verifyPassword } from '../auth/password.ts';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { exec, one, rows } from '../db/sql.ts';
import { badRequest, HttpError, unauthorized } from '../errors.ts';

/**
 * Verifies credentials; uniform failure (same error, comparable time) for unknown user, wrong password, deactivated.
 * Only after the password is right can the organization state show (section 8.2): a user whose every organization is
 * suspended or cancelled, who owns none of them and has no usable guest project, is refused with 403 `org_suspended`.
 */
export async function verifyLogin(ctx: Ctx, email: string, password: string): Promise<string> {
  const u = await one(
    ctx.pool,
    'SELECT id, password_hash, status, kind, email_verified_at FROM users WHERE lower(email) = lower($1)',
    [email],
  );
  const ok = await verifyPassword(u?.password_hash ?? (await dummyHash()), password);
  if (!u || !ok || u.status !== 'active') throw unauthorized('invalid email or password');
  if (!u.email_verified_at)
    throw new HttpError(
      403,
      'email_not_verified',
      'Confirm your email first: open the link in the mail we sent you.',
    );
  if (u.kind !== 'super_admin') await assertMayLogin(ctx, u.id);
  return u.id as string;
}

async function assertMayLogin(ctx: Ctx, userId: string): Promise<void> {
  const mine = await rows<{
    id: string;
    name: string;
    status: string;
    owner_user_id: string;
    owner_name: string;
  }>(
    ctx.pool,
    `SELECT o.id, o.name, o.status, o.owner_user_id, ou.display_name AS owner_name FROM org_members om
       JOIN organizations o ON o.id = om.org_id JOIN users ou ON ou.id = o.owner_user_id
      WHERE om.user_id=$1 AND om.status='active' ORDER BY om.joined_at`,
    [userId],
  );
  if (mine.length === 0) return;
  if (mine.some((o) => o.status === 'trial' || o.status === 'active')) return;
  if (mine.some((o) => o.owner_user_id === userId)) return; // an Owner may sign in (read, settings, members)
  const guest = await one(
    ctx.pool,
    `SELECT 1 FROM project_members pm JOIN projects p ON p.id = pm.project_id JOIN organizations o ON o.id = p.org_id
      WHERE pm.user_id=$1 AND pm.status='active' AND o.status IN ('trial','active') LIMIT 1`,
    [userId],
  );
  if (guest) return;
  const first = mine[0] as (typeof mine)[number];
  throw new HttpError(
    403,
    'org_suspended',
    `Your organization ${first.name} is ${first.status}. Contact ${first.owner_name}.`,
  );
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
