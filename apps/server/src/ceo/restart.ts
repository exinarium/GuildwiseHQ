import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { orgScope, SYSTEM_ACTOR } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { exec, one, rows } from '../db/sql.ts';

/**
 * `aom runner restart` (docs/design/ceo-front-door.md section 5.6): the CEO asked for a restart after its reply. When the
 * workstation reconnects, the CEO thread gets a system line, "<workstation> restarted (runner <version>)".
 */
export async function announceRestart(ctx: Ctx, workstationId: string): Promise<void> {
  const flags = await rows(ctx.pool, `SELECT org_id FROM ceo_flags WHERE flag=$1`, [
    `restart:${workstationId}`,
  ]);
  if (!flags.length) return;
  const ws = await one(ctx.pool, 'SELECT name, runner_version FROM workstations WHERE id=$1', [
    workstationId,
  ]);
  for (const f of flags) {
    await exec(ctx.pool, 'DELETE FROM ceo_flags WHERE org_id=$1 AND flag=$2', [
      f.org_id,
      `restart:${workstationId}`,
    ]);
    const thread = await one(
      ctx.pool,
      `SELECT c.chat_thread_id FROM ceo_settings c WHERE c.org_id=$1 AND c.chat_thread_id IS NOT NULL`,
      [f.org_id],
    );
    if (!thread?.chat_thread_id) continue;
    await ctx.store
      .append([
        {
          streamId: streamId.thread(thread.chat_thread_id),
          event: {
            type: 'ThreadMessagePosted',
            payload: {
              threadId: thread.chat_thread_id,
              messageId: randomUUID(),
              authorKind: 'system',
              kind: 'system',
              body: `${ws?.name ?? 'The workstation'} restarted (runner ${ws?.runner_version ?? 'unknown'}).`,
              data: { restart: true },
            },
          },
          actor: SYSTEM_ACTOR,
          scope: orgScope(f.org_id),
        },
      ])
      .catch((err) => ctx.log.error({ err }, 'restart announcement failed'));
  }
}
