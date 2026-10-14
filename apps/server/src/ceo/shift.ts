import { streamId } from '@aom/shared';
import { orgScope, runnerActor } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { exec, one, type Queryable, type Row } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';

type EndOutcome = 'reported' | 'no_report' | 'stopped' | 'crashed' | 'timeout' | 'rejected' | 'lost';

/**
 * Ends a CEO shift (`ShiftEnded`). A shift that ended without its terminal report puts its wakes back (a failed attempt
 * counts unless the runner never started it); after two failed attempts a review is written by the server and the other
 * wakes are dropped: the owner's desk works without the CEO, it never blocks.
 */
export async function endCeoShift(
  tx: Queryable,
  shift: Row,
  outcome: EndOutcome,
  extra: {
    durationMs?: number;
    usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
    exitCode?: number | null;
    guardViolations?: { rule: string; detail: string }[];
  } = {},
): Promise<AppendInput[]> {
  const events: AppendInput[] = [
    {
      streamId: streamId.shift(shift.id),
      event: {
        type: 'ShiftEnded',
        payload: {
          shiftId: shift.id,
          agentId: shift.agent_id,
          outcome,
          durationMs: extra.durationMs ?? 0,
          usage: extra.usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          exitCode: extra.exitCode,
          guardViolations: extra.guardViolations ?? [],
        },
      },
      actor: runnerActor(shift.workstation_id),
      scope: orgScope(shift.org_id),
    },
  ];
  const batch = await one(tx, `SELECT * FROM ceo_batches WHERE shift_id=$1 AND status='running'`, [shift.id]);
  if (batch) {
    const failed = !(outcome === 'rejected' || outcome === 'lost' || outcome === 'stopped');
    const attempts = Number(batch.attempts) + (failed ? 1 : 0);
    await exec(tx, `UPDATE ceo_batches SET status='failed', attempts=$2, updated_at=now() WHERE id=$1`, [
      batch.id,
      attempts,
    ]);
    await exec(
      tx,
      `UPDATE ceo_wakes SET status = CASE WHEN reason <> 'daily_review' AND $2::int >= 2 THEN 'failed' ELSE 'pending' END,
              batch_id=NULL, attempts=$2::int WHERE batch_id=$1 AND status='taken'`,
      [batch.id, attempts],
    );
  }
  return events;
}

/** The brief could not be built: the batch is released and its wakes wait for the next pass. */
export async function releaseBatch(ctx: Ctx, batchId: string, why: string): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const b = await one(tx, `SELECT * FROM ceo_batches WHERE id=$1 AND status='running'`, [batchId]);
    if (!b) return;
    const shift = await one(tx, `SELECT * FROM shifts WHERE id=$1 AND status <> 'ended'`, [b.shift_id]);
    if (shift) await ctx.store.append(await endCeoShift(tx, shift, 'rejected'), { tx });
    else await exec(tx, `UPDATE ceo_batches SET status='failed' WHERE id=$1`, [batchId]);
    ctx.log.warn({ batchId, why }, 'ceo batch released');
  });
}
