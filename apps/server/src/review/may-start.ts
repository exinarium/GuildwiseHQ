import { type Queryable, rows } from '../db/sql.ts';

/** The most review rounds one pull request gets for heads that moved between the two checkouts. */
export const MAX_HEADS_DIFFER_ROUNDS = 3;

/**
 * One review round per pull request; only a round refused for lack of a token is tried again, and a round whose two
 * runs saw different heads (the pull request moved) is tried again, at most `MAX_HEADS_DIFFER_ROUNDS` rounds in all.
 * Runs recorded before rounds existed and not yet in a round count as a round of one.
 */
export async function mayStart(db: Queryable, prReviewId: string): Promise<boolean> {
  const list = await rows(
    db,
    `SELECT state, end_code FROM (
       SELECT state, end_code, started_at FROM pr_review_rounds WHERE pr_review_id=$1
       UNION ALL
       SELECT state, error_code AS end_code, started_at FROM pr_review_runs
        WHERE pr_review_id=$1 AND replay_id IS NULL AND round_id IS NULL AND reviewer='first'
     ) x ORDER BY started_at DESC`,
    [prReviewId],
  );
  if (list.length === 0) return true;
  const last = list[0] as Record<string, unknown>;
  if (last.state !== 'failed') return false; // running, posting, posted, timed out: never again by itself
  // no_token is not an attempt: the gate decides when the repository is ready again. Any other failure is final.
  if (last.end_code === 'no_token') return true;
  return last.end_code === 'heads_differ' && list.length < MAX_HEADS_DIFFER_ROUNDS;
}
