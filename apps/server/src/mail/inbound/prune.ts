import type { Ctx } from '../../context.ts';

/** How long the text of an inbound message is kept. Cards made from it keep their own fields; this is the mail copy. */
export const MAIL_RETENTION_DAYS = 180;

/**
 * Deletes messages older than the retention period and the threads and counters left empty or old. Cheap and
 * idempotent: the scheduler calls it every few minutes.
 */
export async function pruneMail(ctx: Ctx): Promise<number> {
  const cutoff = new Date(ctx.clock.now().getTime() - MAIL_RETENTION_DAYS * 86_400_000);
  const gone = await ctx.pool.query('DELETE FROM mail_messages WHERE received_at < $1', [cutoff]);
  await ctx.pool.query(
    `DELETE FROM mail_threads t WHERE t.last_message_at < $1
        AND NOT EXISTS (SELECT 1 FROM mail_messages m WHERE m.thread_id = t.id)`,
    [cutoff],
  );
  await ctx.pool.query(`DELETE FROM inbound_counters WHERE day < CURRENT_DATE - 90`);
  return gone.rowCount ?? 0;
}
