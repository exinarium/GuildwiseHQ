import { streamId } from '@aom/shared';
import { orgScope, runnerActor } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { exec, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';

type EndOutcome = 'reported' | 'no_report' | 'stopped' | 'crashed' | 'timeout' | 'rejected' | 'lost';

/** What is written down when nothing better is known: a CEO shift never ends without a reason on its batch. */
const DEFAULT_ERROR: Record<string, string> = {
  rejected: 'the runner did not take the shift',
  lost: 'the runner stopped reporting the shift (lost connection)',
  crashed: 'the agent process crashed',
  timeout: 'the shift ran out of time',
  no_report: 'the agent finished without handing in its report',
  stopped: 'the shift was stopped',
};

/** A runner rejection as one line: `busy: 4 shifts already running`. */
export function rejectionText(reason: string, detail?: string): string {
  const d = (detail ?? '').replace(/\s+/g, ' ').trim();
  return (d ? `${reason}: ${d}` : reason.replaceAll('_', ' ')).slice(0, 500);
}

/**
 * Ends a CEO shift (`ShiftEnded`). A shift that ended without its terminal report puts its wakes back (a failed attempt
 * counts unless the runner never started it); after two failed attempts a review is written by the server and the other
 * wakes are dropped: the owner's desk works without the CEO, it never blocks. The reason is kept on the batch
 * (`ceo_batches.error`), whatever ended it.
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
    /** Why it ended without its report (the runner's rejection reason and detail, the reaper's timeout, ...). */
    error?: string;
    /** When it ended (the server's clock; default: now). */
    at?: Date;
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
    await exec(
      tx,
      `UPDATE ceo_batches SET status='failed', attempts=$2, outcome=$3, error=$4, updated_at=$5 WHERE id=$1`,
      [
        batch.id,
        attempts,
        outcome,
        (extra.error ?? DEFAULT_ERROR[outcome] ?? outcome).slice(0, 500),
        extra.at ?? new Date(),
      ],
    );
    await exec(
      tx,
      `UPDATE ceo_wakes SET status = CASE WHEN reason <> 'daily_review' AND $2::int >= 2 THEN 'failed' ELSE 'pending' END,
              batch_id=NULL, attempts=$2::int WHERE batch_id=$1 AND status='taken'`,
      [batch.id, attempts],
    );
  }
  return events;
}

/** The brief could not be built, or the runner is not connected: the batch is released and its wakes wait. */
export async function releaseBatch(ctx: Ctx, batchId: string, why: string): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const b = await one(tx, `SELECT * FROM ceo_batches WHERE id=$1 AND status='running'`, [batchId]);
    if (!b) return;
    const shift = await one(tx, `SELECT * FROM shifts WHERE id=$1 AND status <> 'ended'`, [b.shift_id]);
    if (shift)
      await ctx.store.append(await endCeoShift(tx, shift, 'rejected', { error: why, at: ctx.clock.now() }), {
        tx,
      });
    else await releaseOrphan(tx, b, why, ctx.clock.now());
    ctx.log.warn({ batchId, why }, 'ceo batch released');
  });
}

/** A batch whose shift is gone or ended: it fails with a reason and its wakes go back (like a rejected shift). */
async function releaseOrphan(tx: Queryable, b: Row, why: string, at: Date): Promise<void> {
  await exec(
    tx,
    `UPDATE ceo_batches SET status='failed', outcome='released', error=$2, updated_at=$3 WHERE id=$1`,
    [b.id, why.slice(0, 500), at],
  );
  await exec(
    tx,
    `UPDATE ceo_wakes SET status='pending', batch_id=NULL, attempts=$2::int WHERE batch_id=$1 AND status='taken'`,
    [b.id, Number(b.attempts)],
  );
}

/**
 * A batch still `running` whose shift row is missing or already ended can never finish (a crash between the batch and
 * the shift, a shift ended by another path): it would hold its wakes in `taken` for ever. Returns how many were freed.
 */
export async function releaseStuckBatches(ctx: Ctx, orgId: string): Promise<number> {
  const stuck = await rows(
    ctx.pool,
    `SELECT b.id FROM ceo_batches b LEFT JOIN shifts s ON s.id = b.shift_id
      WHERE b.org_id=$1 AND b.status='running' AND (s.id IS NULL OR s.status = 'ended')`,
    [orgId],
  );
  for (const { id } of stuck)
    await withAppendTx(ctx.pool, async (tx) => {
      const again = await one(tx, `SELECT * FROM ceo_batches WHERE id=$1 AND status='running' FOR UPDATE`, [
        id,
      ]);
      if (again) await releaseOrphan(tx, again, 'the shift of this batch is gone', ctx.clock.now());
    });
  // Wakes taken by a batch that is not running any more are free again too.
  await exec(
    ctx.pool,
    `UPDATE ceo_wakes w SET status='pending', batch_id=NULL
      WHERE w.org_id=$1 AND w.status='taken'
        AND NOT EXISTS (SELECT 1 FROM ceo_batches b WHERE b.id = w.batch_id AND b.status='running')`,
    [orgId],
  );
  return stuck.length;
}

export interface CeoFailures {
  /** Consecutive failed shifts, newest first, since the last one that ran. */
  streak: number;
  /** Of those, the newest ones the runner never started (rejected or lost): they back the dispatcher off. */
  startFailures: number;
  lastError: string | null;
  lastOutcome: string | null;
  lastAt: Date | null;
}

/** The CEO's recent failed shifts (a `done` or accepted batch ends the run; a stopped or not yet accepted one is neutral). */
export async function ceoFailures(db: Queryable, orgId: string): Promise<CeoFailures> {
  const recent = await rows(
    db,
    `SELECT b.status, b.outcome, b.error, b.updated_at, s.accepted_at FROM ceo_batches b LEFT JOIN shifts s ON s.id = b.shift_id
      WHERE b.org_id=$1 ORDER BY b.created_at DESC, b.id LIMIT 30`,
    [orgId],
  );
  const out: CeoFailures = { streak: 0, startFailures: 0, lastError: null, lastOutcome: null, lastAt: null };
  let startRun = true;
  for (const b of recent) {
    // A batch the runner has not accepted yet proves nothing; one it accepted, or finished, ends the run of failures.
    if (b.status === 'running' && !b.accepted_at) continue;
    if (b.status !== 'failed') break;
    if (b.outcome === 'stopped' || b.outcome === 'released') continue;
    out.streak++;
    if (b.outcome === 'rejected' || b.outcome === 'lost') {
      if (startRun) out.startFailures++;
    } else startRun = false;
    if (out.lastError === null) {
      out.lastError = b.error ?? DEFAULT_ERROR[b.outcome] ?? 'unknown';
      out.lastOutcome = b.outcome ?? null;
      out.lastAt = b.updated_at;
    }
  }
  return out;
}

/** After this many failures in a row the owner is told on the desk. */
export const FAILURE_NOTICE_AT = 3;
/** Wait before the next try after n shifts in a row the runner never started: 1, 2, 4, ... at most 30 minutes. */
export const startBackoffMs = (n: number): number => (n <= 0 ? 0 : Math.min(30, 2 ** (n - 1)) * 60_000);
