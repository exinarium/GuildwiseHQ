import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

/** Reviewer runs of PR-only pull requests (projection of the `PrReviewRun*` events and `PrReviewPosted`). */
export const prReviewRunProjectors: Record<string, Projector> = {
  PrReviewRunStarted: async (tx, e) => {
    const p = (e.event as EventOf<'PrReviewRunStarted'>).payload;
    await exec(
      tx,
      `INSERT INTO pr_review_runs (id, pr_review_id, project_id, reviewer, runtime, model, workstation_id, state, timeout_ms, started_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'running',$8,$9)
       ON CONFLICT (id) DO NOTHING`,
      [
        p.runId,
        p.prReviewId,
        p.projectId,
        p.reviewer,
        p.runtime,
        p.model,
        p.workstationId,
        p.timeoutMs,
        p.at,
      ],
    );
    await exec(tx, 'UPDATE pr_reviews SET last_run_id=$2 WHERE id=$1', [p.prReviewId, p.runId]);
  },
  PrReviewRunCompleted: async (tx, e) => {
    const p = (e.event as EventOf<'PrReviewRunCompleted'>).payload;
    await exec(
      tx,
      `UPDATE pr_review_runs SET state='completed', finished_at=$2, duration_ms=$3, head_sha=$4, base_sha=$5, summary=$6
        WHERE id=$1`,
      [p.runId, p.at, p.durationMs, p.headSha, p.baseSha, p.summary],
    );
    for (const [idx, f] of p.findings.entries()) {
      await exec(
        tx,
        `INSERT INTO pr_review_findings (id, run_id, pr_review_id, idx, path, line, anchored, severity, title, body)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO NOTHING`,
        [f.findingId, p.runId, p.prReviewId, idx, f.path, f.line, f.anchored, f.severity, f.title, f.body],
      );
    }
  },
  PrReviewRunTimedOut: async (tx, e) => {
    const p = (e.event as EventOf<'PrReviewRunTimedOut'>).payload;
    await exec(
      tx,
      `UPDATE pr_review_runs SET state='timed_out', finished_at=$2, duration_ms=$3, timed_out_by=$4,
              error_stage='run', error_code='timeout'
        WHERE id=$1`,
      [p.runId, p.at, p.durationMs, p.by],
    );
  },
  PrReviewRunFailed: async (tx, e) => {
    const p = (e.event as EventOf<'PrReviewRunFailed'>).payload;
    await exec(
      tx,
      `UPDATE pr_review_runs SET state='failed', finished_at=$2, duration_ms=COALESCE($3, duration_ms),
              error_stage=$4, error_code=$5, error=$6, retryable=$7
        WHERE id=$1`,
      [p.runId, p.at, p.durationMs ?? null, p.stage, p.code, p.error, p.retryable],
    );
  },
  PrReviewPosted: async (tx, e) => {
    const p = (e.event as EventOf<'PrReviewPosted'>).payload;
    await exec(
      tx,
      `UPDATE pr_review_runs SET state='posted', review_url=$2, posted_at=$3, error_stage=NULL, error_code=NULL, error=NULL
        WHERE id=$1`,
      [p.runId, p.reviewUrl, p.at],
    );
    await exec(tx, 'UPDATE pr_review_findings SET posted=true WHERE run_id=$1 AND id = ANY($2::uuid[])', [
      p.runId,
      p.postedFindingIds,
    ]);
    await exec(
      tx,
      `UPDATE pr_reviews SET review_state='reviewed', reviewed_by=$2, reviewed_at=$3, last_run_id=$4 WHERE id=$1`,
      [p.prReviewId, p.reviewer, p.at, p.runId],
    );
  },
};
