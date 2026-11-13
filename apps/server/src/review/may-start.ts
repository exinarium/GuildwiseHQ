import { type Queryable, rows } from '../db/sql.ts';

/** One run per pull request; only a run refused for lack of a token is tried again. */
export async function mayStart(db: Queryable, prReviewId: string): Promise<boolean> {
  const runs = await rows(
    db,
    `SELECT state, error_code, retryable, finished_at FROM pr_review_runs
      WHERE pr_review_id=$1 AND reviewer='first' ORDER BY started_at DESC`,
    [prReviewId],
  );
  if (runs.length === 0) return true;
  const last = runs[0] as Record<string, unknown>;
  if (last.state !== 'failed') return false; // running, completed (posting), posted, timed out: never again by itself
  // no_token is not an attempt: the gate decides when the repository is ready again. Any other failure is final.
  return last.error_code === 'no_token';
}
