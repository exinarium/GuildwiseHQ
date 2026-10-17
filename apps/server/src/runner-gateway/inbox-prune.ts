import type { Ctx } from '../context.ts';

/**
 * How long the idempotency record of an acked runner message is kept. A runner re-sends an unacked message for hours at
 * most, never for days; the table otherwise grew with every report.
 */
export const RUNNER_INBOX_RETENTION_DAYS = 7;

/** Deletes the runner inbox rows older than the retention period. Cheap and idempotent. Returns how many went. */
export async function pruneRunnerInbox(ctx: Ctx): Promise<number> {
  const cutoff = new Date(ctx.clock.now().getTime() - RUNNER_INBOX_RETENTION_DAYS * 86_400_000);
  const r = await ctx.pool.query('DELETE FROM runner_inbox WHERE received_at < $1', [cutoff]);
  return r.rowCount ?? 0;
}
