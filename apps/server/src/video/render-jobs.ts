import { VIDEO_LIMITS, VIDEO_POST_LIMITS, WORKER_OUTDATED_LIKE } from '@aom/shared';
import { videoStorageUsed } from '../commands/video-posts.ts';
import type { Ctx } from '../context.ts';
import { exec, one, type Row } from '../db/sql.ts';
import { alertVideoOnce } from './sweep.ts';

/**
 * The database side of a render (core DESIGN R16 "Shared code"): claim, lease, rendered, failed and the duration limit.
 * Both the in-process path (`renderNext` in sweep.ts: `AOM_VIDEO_ROLE=render|all` on a host with the database, as
 * self-hosters run it) and the render job API (routes/render-jobs.ts, for remote workers) use these, so the two behave
 * the same. In-process claims hold a 40 min lease; remote claims 10 min, extended by every heartbeat.
 */

export const IN_PROCESS_LEASE_MS = 40 * 60_000;

/** A render that may start: of an approved post once its `not_before` has passed, or an explicit preview in review. */
const CLAIMABLE = `NOT x.library AND p.script IS NOT NULL
  AND ((p.status='approved' AND (x.not_before IS NULL OR x.not_before <= $1))
       OR (x.preview AND p.status IN ('draft','in_review')))
  AND ((x.status='queued' AND (x.lease_until IS NULL OR x.lease_until <= $1))
       OR (x.status='rendering' AND x.lease_until < $1))
  AND x.attempts < $2`;

/** Renders a refused push put back with a wait are free again once a current worker asks. */
export async function releaseOutdatedWaits(ctx: Ctx): Promise<void> {
  await exec(
    ctx.pool,
    `UPDATE video_renders SET lease_until=NULL
      WHERE status='queued' AND NOT library AND lease_until > $1 AND error LIKE $2`,
    [ctx.clock.now(), WORKER_OUTDATED_LIKE],
  );
}

/**
 * Claims one render (only previews with `previewsOnly`): one at a time across every worker, under the disk budget.
 * `workerId` binds the claim to a remote worker (null for the in-process path, which clears any earlier binding).
 */
export async function claimRender(
  ctx: Ctx,
  opts: { previewsOnly?: boolean; leaseMs: number; workerId: string | null },
): Promise<Row | undefined> {
  const now = ctx.clock.now();
  const claimable = opts.previewsOnly ? `${CLAIMABLE} AND x.preview` : CLAIMABLE;
  // the disk budget: nothing starts while the rendered videos on disk plus room for one more pass the limit
  const waiting = await one(
    ctx.pool,
    `SELECT 1 AS x FROM video_renders x JOIN video_posts p ON p.id = x.post_id AND p.revision = x.revision
      WHERE ${claimable} LIMIT 1`,
    [now, VIDEO_POST_LIMITS.maxAttempts],
  );
  if (!waiting) return undefined;
  const used = await videoStorageUsed(ctx);
  if (used + VIDEO_POST_LIMITS.renderReserveBytes > ctx.config.videoMaxBytes) {
    await alertVideoOnce(
      ctx,
      `storage:${now.toISOString().slice(0, 10)}`,
      'The video disk is full',
      `Rendered videos take ${Math.round(used / 1024 ** 2)} MB of the ${Math.round(ctx.config.videoMaxBytes / 1024 ** 2)} MB budget (AOM_VIDEO_MAX_BYTES), so no new render starts until published videos are cleaned up.`,
    );
    return undefined;
  }
  // one render at a time even with several render workers: the claim runs under a transaction-scoped advisory lock, so
  // two workers cannot both see "nothing is rendering" (READ COMMITTED would let them)
  const db = await ctx.pool.connect();
  try {
    await db.query('BEGIN');
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('video-render-claim'))`);
    const claimed = await one(
      db,
      `UPDATE video_renders r SET status='rendering', lease_until=$3, attempts=r.attempts+1, error=NULL, worker_id=$4,
              encoder=NULL
        WHERE r.id = (
          SELECT x.id FROM video_renders x JOIN video_posts p ON p.id = x.post_id AND p.revision = x.revision
           WHERE ${claimable}
             AND NOT EXISTS (SELECT 1 FROM video_renders y WHERE y.status='rendering' AND y.lease_until >= $1)
           ORDER BY x.not_before NULLS FIRST, p.slot_at NULLS LAST, x.created_at LIMIT 1 FOR UPDATE OF x SKIP LOCKED)
        RETURNING r.*`,
      [now, VIDEO_POST_LIMITS.maxAttempts, new Date(now.getTime() + opts.leaseMs), opts.workerId],
    );
    await db.query('COMMIT');
    return claimed;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

/** Extends the lease of a render this attempt still holds. False when the attempt lost it (reclaimed or finished). */
export async function extendLease(
  ctx: Ctx,
  r: { id: string; attempts: number },
  leaseMs: number,
  workerId: string | null = null,
): Promise<boolean> {
  return (
    (await exec(
      ctx.pool,
      `UPDATE video_renders SET lease_until=$2
        WHERE id=$1 AND status='rendering' AND attempts=$3 AND worker_id IS NOT DISTINCT FROM $4`,
      [r.id, new Date(ctx.clock.now().getTime() + leaseMs), r.attempts, workerId],
    )) > 0
  );
}

/** The error of a video over its format's limit, or null when it fits. */
export function durationOverLimit(format: 'long' | 'short', seconds: number): string | null {
  const max = VIDEO_LIMITS.maxSeconds[format];
  return seconds > max
    ? `the video is ${Math.round(seconds)} seconds; the limit is ${max}. Shorten the script.`
    : null;
}

/** A video over the limit fails for good (no retry: the script must change). */
export async function failTooLong(
  ctx: Ctx,
  r: { id: string; attempts: number },
  message: string,
): Promise<void> {
  await exec(
    ctx.pool,
    `UPDATE video_renders SET status='failed', attempts=$3, error=$2, finished_at=$4, lease_until=NULL
      WHERE id=$1 AND status='rendering' AND attempts=$5`,
    [r.id, message, VIDEO_POST_LIMITS.maxAttempts, ctx.clock.now(), r.attempts],
  );
}

/** The render is done: its files (paths relative to AOM_VIDEO_DIR), length, size and the encoder it used. */
export async function markRendered(
  ctx: Ctx,
  r: { id: string; attempts: number },
  out: {
    durationSeconds: number;
    bytes: number;
    artifacts: Record<string, string | null>;
    encoder: 'nvenc' | 'cpu' | 'cpu_fallback' | null;
  },
): Promise<boolean> {
  return (
    (await exec(
      ctx.pool,
      `UPDATE video_renders SET status='rendered', lease_until=NULL, error=NULL, duration_s=$2, bytes=$3, artifacts=$4::jsonb,
              finished_at=$5, encoder=$7
        WHERE id=$1 AND status='rendering' AND attempts=$6`,
      [
        r.id,
        out.durationSeconds,
        out.bytes,
        JSON.stringify(Object.fromEntries(Object.entries(out.artifacts).filter(([, v]) => v))),
        ctx.clock.now(),
        r.attempts,
        out.encoder,
      ],
    )) > 0
  );
}

/**
 * A failed attempt: back to the queue (waiting attempts x 1 minute) or, after the last attempt, failed for good. A stale
 * worker (its lease ran out and the render was reclaimed) never overwrites the new owner's row.
 */
export async function markFailed(
  ctx: Ctx,
  r: { id: string; attempts: number },
  error: string,
): Promise<boolean> {
  const message = error.slice(0, 480);
  const final = r.attempts >= VIDEO_POST_LIMITS.maxAttempts;
  return (
    (await exec(
      ctx.pool,
      `UPDATE video_renders SET status=$2, error=$3, lease_until=$6, finished_at=$4
        WHERE id=$1 AND status='rendering' AND attempts=$5`,
      [
        r.id,
        final ? 'failed' : 'queued',
        message,
        final ? ctx.clock.now() : null,
        r.attempts,
        final ? null : new Date(ctx.clock.now().getTime() + r.attempts * 60_000),
      ],
    )) > 0
  );
}
