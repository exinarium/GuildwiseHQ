import {
  RUNNER_UPDATE_CHECK_CAPABILITY,
  type RunnerUpdateCheckResult,
  RunnerUpdateCheckResultSchema,
  type UpdateCheckResponse,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { exec, one } from '../db/sql.ts';
import { conflict, HttpError, notFound } from '../errors.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';

/** One "Check for updates" a minute per workstation. */
export const UPDATE_CHECK_MIN_INTERVAL_MS = 60_000;
/** A request that was not answered within this long shows as timed out (the command is no longer delivered either). */
export const UPDATE_CHECK_TIMEOUT_MS = 5 * 60_000;

/**
 * "Check for updates" (docs/RUNNER.md "Updates"): asks the connected runner to run its updater's check now. The command is
 * only sent to a live connection (an offline runner is an error, nothing is queued for later) and expires with the
 * request. The runner's answer is stored on the workstation (operational data, `runner_update_check`).
 */
export async function requestUpdateCheck(
  ctx: Ctx,
  user: AuthSession['user'],
  workstationId: string,
): Promise<UpdateCheckResponse> {
  const w = await one<{ connected: boolean }>(
    ctx.pool,
    `SELECT connected FROM workstations WHERE id=$1 AND user_id=$2 AND status='active'`,
    [workstationId, user.id],
  );
  if (!w) throw notFound('workstation not found');
  if (!w.connected)
    throw conflict(
      'workstation_offline',
      'This workstation is offline. Its runner can only be asked while connected.',
    );
  const caps = await one<{ capabilities: string[] }>(
    ctx.pool,
    'SELECT capabilities FROM workstation_capabilities WHERE workstation_id=$1',
    [workstationId],
  );
  if (!(caps?.capabilities ?? []).includes(RUNNER_UPDATE_CHECK_CAPABILITY))
    throw conflict(
      'update_check_unsupported',
      'This runner is too old to check on request. It checks for updates by itself once a day.',
    );
  const now = ctx.clock.now();
  // Claim the slot atomically: a second request inside the minute finds the first one's timestamp.
  const claimed = await one(
    ctx.pool,
    `UPDATE workstations SET runner_update_check = jsonb_build_object('requestedAt', $2::text)
      WHERE id=$1 AND (runner_update_check IS NULL
        OR (runner_update_check->>'requestedAt')::timestamptz <= $3::timestamptz)
      RETURNING id`,
    [workstationId, now.toISOString(), new Date(now.getTime() - UPDATE_CHECK_MIN_INTERVAL_MS).toISOString()],
  );
  if (!claimed)
    throw new HttpError(429, 'rate_limited', 'A check was asked for a moment ago. Try again in a minute.', {
      retryAfterSeconds: 60,
    });
  await enqueueRunnerCommand(
    ctx.pool,
    workstationId,
    'runner.update.check',
    {},
    new Date(now.getTime() + UPDATE_CHECK_TIMEOUT_MS),
  );
  void Promise.resolve(ctx.services.gateway.deliverPending(workstationId)).catch(() => undefined);
  return { ok: true, requestedAt: now.toISOString() };
}

/** The runner's answer (`command.result` of `runner.update.check`); an unreadable or failed one is stored as `failed`. */
export async function applyUpdateCheckResult(
  ctx: Ctx,
  workstationId: string,
  ok: boolean,
  result: unknown,
  error: string | undefined,
): Promise<void> {
  const parsed = RunnerUpdateCheckResultSchema.safeParse(result);
  const answer: RunnerUpdateCheckResult =
    ok && parsed.success
      ? parsed.data
      : {
          outcome: 'failed',
          version: null,
          detail: (error ?? 'the runner gave no usable answer').slice(0, 300),
        };
  await exec(
    ctx.pool,
    `UPDATE workstations SET runner_update_check = COALESCE(runner_update_check, '{}'::jsonb)
        || jsonb_build_object('result', $2::jsonb) WHERE id=$1`,
    [workstationId, JSON.stringify({ ...answer, at: ctx.clock.now().toISOString() })],
  );
}
