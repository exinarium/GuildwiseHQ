import type { StorageWriteError } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { rows } from '../db/sql.ts';
import { withTx } from '../db/tx.ts';

/** Failed attempts (not counting "not tried") before a file is shown as one that could not be removed. */
export const MAX_CLEANUP_ATTEMPTS = 8;
/** A claimed row is not picked up again by another sweep for this long. */
export const CLEANUP_LEASE_MS = 5 * 60_000;
const BATCH = 25;
const CONCURRENCY = 8;
const RETRY_BASE_MS = 5 * 60_000;
const RETRY_MAX_MS = 6 * 3_600_000;
/** A file that could never be tried (runner offline or too old) for this long is given up. */
export const CLEANUP_NOT_TRIED_BOUND_MS = 30 * 86_400_000;
const MIN_SWEEP_GAP_MS = 60_000;

/** A write that started before `expires_at` can still end up to two write timeouts later: wait for it. */
export function cleanupGraceMs(ctx: Ctx): number {
  return 2 * ctx.config.storage.writeTimeoutMs + 60_000;
}

/**
 * Queues the files of expired submissions that have no answers document. Only `expired`, never completed, no answers
 * reference at all, and past the grace window; one transaction, safe to run on several instances.
 */
export async function queueFormUploadCleanup(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now();
  const cutoff = new Date(now.getTime() - cleanupGraceMs(ctx));
  await withTx(ctx.pool, async (tx) => {
    const subs = await rows<{
      id: string;
      org_id: string;
      parts: Array<{
        field?: string;
        reference?: { connectionId: string; path: string; providerId?: string };
      }>;
    }>(
      tx,
      `SELECT id, org_id, parts FROM form_submissions
        WHERE status='expired' AND cleanup_queued_at IS NULL
          AND completed_at IS NULL AND answers_refs = '{}'::jsonb
          AND expires_at < $1
        ORDER BY expires_at LIMIT 200 FOR UPDATE SKIP LOCKED`,
      [cutoff],
    );
    for (const s of subs) {
      for (const [seq, p] of s.parts.entries()) {
        if (!p.reference) continue;
        await tx.query(
          `INSERT INTO form_submission_cleanup
             (submission_id, seq, org_id, connection_id, label, path, provider_id, state, queued_at, next_attempt_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$8) ON CONFLICT DO NOTHING`,
          [
            s.id,
            seq,
            s.org_id,
            p.reference.connectionId,
            p.field ?? '',
            p.reference.path,
            p.reference.providerId ?? null,
            now,
          ],
        );
      }
      await tx.query('UPDATE form_submissions SET cleanup_queued_at=$2 WHERE id=$1', [s.id, now]);
    }
  });
}

interface Claimed {
  submission_id: string;
  seq: number;
  org_id: string;
  connection_id: string;
  path: string;
  provider_id: string | null;
  attempts: number;
  queued_at: Date;
}

const backoffMs = (attempts: number) =>
  Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);

/** Sends the due deletes through the relay and records each result. Returns how many rows it handled. */
export async function sweepFormUploadCleanup(ctx: Ctx): Promise<number> {
  const now = ctx.clock.now();
  const claimed = await rows<Claimed>(
    ctx.pool,
    `UPDATE form_submission_cleanup c SET next_attempt_at = $2
      WHERE (c.submission_id, c.seq) IN (
        SELECT c2.submission_id, c2.seq FROM form_submission_cleanup c2
          JOIN form_submissions s ON s.id = c2.submission_id
         WHERE c2.state = 'pending' AND c2.next_attempt_at <= $1
           AND s.status = 'expired' AND s.completed_at IS NULL AND s.answers_refs = '{}'::jsonb
         ORDER BY c2.next_attempt_at LIMIT ${BATCH} FOR UPDATE OF c2 SKIP LOCKED)
      RETURNING c.submission_id, c.seq, c.org_id, c.connection_id, c.path, c.provider_id, c.attempts, c.queued_at`,
    [now, new Date(now.getTime() + CLEANUP_LEASE_MS)],
  );
  let next = 0;
  const worker = async () => {
    for (;;) {
      const row = claimed[next++];
      if (!row) return;
      await settleOne(ctx, row).catch((err) =>
        ctx.log.error({ err: err?.name, submissionId: row.submission_id }, 'form upload cleanup row failed'),
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, claimed.length) }, worker));
  return claimed.length;
}

async function settleOne(ctx: Ctx, row: Claimed): Promise<void> {
  const r = await ctx.services.storage.delete({
    orgId: row.org_id,
    connectionId: row.connection_id,
    path: row.path,
    ...(row.provider_id ? { providerId: row.provider_id } : {}),
    submissionId: row.submission_id,
  });
  const now = ctx.clock.now();
  const key = [row.submission_id, row.seq];
  const fail = (e: StorageWriteError | { code: string; message: string }) =>
    ctx.pool.query(
      `UPDATE form_submission_cleanup SET state='failed', settled_at=$3, last_error_code=$4, last_error=$5
        WHERE submission_id=$1 AND seq=$2`,
      [...key, now, e.code, e.message],
    );
  if (r.ok) {
    await ctx.pool.query(
      `UPDATE form_submission_cleanup SET state='removed', settled_at=$3, last_error_code=NULL, last_error=NULL
        WHERE submission_id=$1 AND seq=$2`,
      [...key, now],
    );
    return;
  }
  if (r.gone) return void (await fail({ code: 'not_found', message: 'The storage connection was removed.' }));
  if (r.notTried) {
    if (now.getTime() - new Date(row.queued_at).getTime() >= CLEANUP_NOT_TRIED_BOUND_MS)
      return void (await fail({
        code: r.error.code,
        message: 'The workstation could not be reached for 30 days.',
      }));
    await ctx.pool.query(
      `UPDATE form_submission_cleanup SET last_error_code=$3, last_error=$4, next_attempt_at=$5
        WHERE submission_id=$1 AND seq=$2`,
      [...key, r.error.code, r.error.message, new Date(now.getTime() + RETRY_BASE_MS)],
    );
    return;
  }
  // The path could not have come from a write: retrying cannot change that.
  if (r.error.code === 'invalid') return void (await fail(r.error));
  const attempts = row.attempts + 1;
  if (attempts >= MAX_CLEANUP_ATTEMPTS) {
    await ctx.pool.query(
      `UPDATE form_submission_cleanup SET state='failed', attempts=$3, settled_at=$4, last_error_code=$5, last_error=$6
        WHERE submission_id=$1 AND seq=$2`,
      [...key, attempts, now, r.error.code, r.error.message],
    );
    return;
  }
  await ctx.pool.query(
    `UPDATE form_submission_cleanup SET attempts=$3, last_error_code=$4, last_error=$5, next_attempt_at=$6
      WHERE submission_id=$1 AND seq=$2`,
    [...key, attempts, r.error.code, r.error.message, new Date(now.getTime() + backoffMs(attempts))],
  );
}

let running: Promise<unknown> | null = null;
let lastStart = 0;

/**
 * Starts a sweep without waiting for it, so a slow runner cannot hold up the scheduler's serial chain. Single-flight,
 * and at most one start per minute.
 */
export function kickFormUploadCleanup(ctx: Ctx): void {
  const t = ctx.clock.now().getTime();
  if (running || t - lastStart < MIN_SWEEP_GAP_MS) return;
  lastStart = t;
  running = sweepFormUploadCleanup(ctx)
    .catch((err) => ctx.log.error({ err: err?.name }, 'form upload cleanup failed'))
    .finally(() => {
      running = null;
    });
}

/** Test hook: forget the single-flight state. */
export function resetFormUploadCleanupForTests(): void {
  running = null;
  lastStart = 0;
}
