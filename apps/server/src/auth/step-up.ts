import {
  STEP_UP_MAX_FAILURES,
  STEP_UP_REQUIRED,
  type StepUpMethod,
  type StepUpRequest,
  type StepUpResponse,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import { badRequest, HttpError } from '../errors.ts';
import { recordLoginFailure } from './login-guard.ts';
import { verifyPassword } from './password.ts';
import { type AuthSession, deleteSession, markSecondFactor } from './sessions.ts';
import { verifySecondFactor } from './two-factor.ts';

/**
 * "Confirm it's you" (R5). A guarded action needs a session whose user proved a second factor (or, without two-factor
 * login, the password: D1) within `AOM_STEP_UP_WINDOW_SEC`. The proof is `auth_sessions.second_factor_at`, set by a
 * `password*` sign-in and by `POST /api/auth/step-up`; never by an invitation, email-verification or demo session.
 */

/** What the dialog asks for: a code for accounts with two-factor login, else the password. */
export const stepUpMethod = (s: AuthSession): StepUpMethod => (s.twoFactor.enabled ? 'totp' : 'password');

/** When the session's proof stops being fresh (null: it has none). */
export function freshUntil(ctx: Ctx, s: AuthSession): Date | null {
  if (!s.secondFactorAt) return null;
  return new Date(s.secondFactorAt.getTime() + ctx.config.stepUpWindowSec * 1000);
}

export function isStepUpFresh(ctx: Ctx, s: AuthSession): boolean {
  const until = freshUntil(ctx, s);
  return !!until && until.getTime() > ctx.clock.now().getTime();
}

/** Throws 403 `step_up_required {method}` unless the session is fresh. Call after the route's own guard. */
export function requireStepUp(ctx: Ctx, s: AuthSession): void {
  if (isStepUpFresh(ctx, s)) return;
  throw new HttpError(403, STEP_UP_REQUIRED, "confirm it's you to continue", { method: stepUpMethod(s) });
}

/** Wrong step-up answers in this session since its last fresh proof (or since it started). */
async function failuresSinceProof(ctx: Ctx, s: AuthSession): Promise<number> {
  const r = await one<{ n: number }>(
    ctx.pool,
    `SELECT count(*)::int AS n FROM login_failures f, auth_sessions a
      WHERE a.id = $1 AND f.user_id = $2 AND f.reason = 'step_up'
        AND f.at >= GREATEST(a.created_at, COALESCE(a.second_factor_at, a.created_at))`,
    [s.sessionId, s.user.id],
  );
  return r?.n ?? 0;
}

/**
 * Answers a step-up: a code (TOTP or recovery) for accounts with two-factor login, the password otherwise. A wrong
 * answer is a `step_up` failure row and a 400 (`invalid_code` / `wrong_password`, `attemptsLeft`); the fifth wrong
 * answer since the last proof ends the session (401 `session_ended`).
 */
export async function answerStepUp(
  ctx: Ctx,
  s: AuthSession,
  body: StepUpRequest,
  meta: { ip?: string | undefined; userAgent?: string | undefined } = {},
): Promise<StepUpResponse> {
  const method = stepUpMethod(s);
  if (method === 'totp' && !('code' in body))
    throw badRequest('step_up_method', 'enter the code from your authenticator app', { method });
  if (method === 'password' && !('password' in body))
    throw badRequest('step_up_method', 'enter your password', { method });

  let ok: boolean;
  if ('code' in body) ok = (await verifySecondFactor(ctx, s.user.id, body.code)) !== null;
  else {
    const u = await one<{ password_hash: string }>(ctx.pool, 'SELECT password_hash FROM users WHERE id=$1', [
      s.user.id,
    ]);
    ok = !!u && (await verifyPassword(u.password_hash, body.password));
  }

  if (!ok) {
    await recordLoginFailure(ctx, {
      reason: 'step_up',
      email: s.user.email,
      userId: s.user.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    const failures = await failuresSinceProof(ctx, s);
    if (failures >= STEP_UP_MAX_FAILURES) {
      await deleteSession(ctx, s.sessionId);
      throw new HttpError(401, 'session_ended', 'too many wrong answers: sign in again');
    }
    const attemptsLeft = STEP_UP_MAX_FAILURES - failures;
    if (method === 'totp') throw badRequest('invalid_code', 'that code is not right', { attemptsLeft });
    throw badRequest('wrong_password', 'the password is incorrect', { attemptsLeft });
  }

  const now = ctx.clock.now();
  await markSecondFactor(ctx, s, now);
  s.secondFactorAt = now;
  return { ok: true, freshUntil: new Date(now.getTime() + ctx.config.stepUpWindowSec * 1000).toISOString() };
}
