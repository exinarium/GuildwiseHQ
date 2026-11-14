import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

/**
 * The PR size check (projection of the `PrReview*Split*`, `PrReviewNeedsSplit`, `PrReviewTimedOutTwice` and
 * `PrReviewAttentionCleared` events): `pr_reviews` columns and `pr_split_notices`.
 */
export const prSizeCheckProjectors: Record<string, Projector> = {
  PrReviewNeedsSplit: async (tx, e) => {
    const p = (e.event as EventOf<'PrReviewNeedsSplit'>).payload;
    await exec(
      tx,
      `UPDATE pr_reviews SET review_state='needs_split', split_reason=$2, split_at=$3, split_total=$4, split_budget=$5,
              split_unit=$6, split_members=$7::jsonb, attention=NULL
        WHERE id=$1`,
      [p.prReviewId, p.reason, p.at, p.total, p.budget, p.unit, JSON.stringify(p.members)],
    );
    await exec(
      tx,
      `INSERT INTO pr_split_notices (id, pr_review_id, project_id, check_id, state, created_at)
       VALUES ($1,$2,$3,$4,'pending',$5)
       ON CONFLICT (id) DO NOTHING`,
      [p.noticeId, p.prReviewId, p.projectId, p.checkId, p.at],
    );
  },
  PrReviewSplitCleared: async (tx, e) => {
    const p = (e.event as EventOf<'PrReviewSplitCleared'>).payload;
    await exec(
      tx,
      `UPDATE pr_reviews SET review_state='not_reviewed', split_reason=NULL, split_at=NULL, split_total=NULL,
              split_budget=NULL, split_unit=NULL, split_members=NULL
        WHERE id=$1 AND review_state='needs_split'`,
      [p.prReviewId],
    );
  },
  PrReviewSplitNoticeQueued: async (tx, e) => {
    const p = (e.event as EventOf<'PrReviewSplitNoticeQueued'>).payload;
    await exec(
      tx,
      `UPDATE pr_split_notices SET state='queued', attempts=$2, workstation_id=$3, queued_at=$4 WHERE id=$1`,
      [p.noticeId, p.attempt, p.workstationId, p.at],
    );
  },
  PrReviewSplitNoticePosted: async (tx, e) => {
    const p = (e.event as EventOf<'PrReviewSplitNoticePosted'>).payload;
    await exec(
      tx,
      `UPDATE pr_split_notices SET state='posted', review_url=$2, posted_at=$3, error_code=NULL, error=NULL WHERE id=$1`,
      [p.noticeId, p.reviewUrl, p.at],
    );
  },
  PrReviewSplitNoticeFailed: async (tx, e) => {
    const p = (e.event as EventOf<'PrReviewSplitNoticeFailed'>).payload;
    await exec(
      tx,
      `UPDATE pr_split_notices SET state='failed', error_code=$2, error=$3, retryable=$4 WHERE id=$1`,
      [p.noticeId, p.code, p.error, p.retryable],
    );
  },
  PrReviewTimedOutTwice: async (tx, e) => {
    const p = (e.event as EventOf<'PrReviewTimedOutTwice'>).payload;
    await exec(tx, `UPDATE pr_reviews SET attention='timed_out_twice' WHERE id=$1`, [p.prReviewId]);
  },
  PrReviewAttentionCleared: async (tx, e) => {
    const p = (e.event as EventOf<'PrReviewAttentionCleared'>).payload;
    await exec(tx, `UPDATE pr_reviews SET attention=NULL WHERE id=$1`, [p.prReviewId]);
  },
};
