import { dummyHash, verifyPassword } from '../auth/password.ts';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import { unauthorized } from '../errors.ts';

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
