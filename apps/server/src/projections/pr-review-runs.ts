import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

/** A round of one ends with its run (a round of two ends with its own `PrReviewRoundEnded`). */
async function endRoundOfOne(
  tx: Parameters<Projector>[0],
  runId: string,
  state: 'timed_out' | 'failed',
  code: string,
  at: string,
): Promise<void> {
  await exec(
    tx,
    `UPDATE pr_review_rounds SET state=$2, finished_at=$3, end_code=$4, cause_run_id=$1
      WHERE id = (SELECT round_id FROM pr_review_runs WHERE id=$1)
        AND array_length(reviewers, 1) = 1 AND state IN ('running','posting')`,
    [runId, state, at, code],
  );
}

/** Reviewer runs of PR-only pull requests (projection of the `PrReviewRun*` events and `PrReviewPosted`). */
export const prReviewRunProjectors: Record<string, Projector> = {
  PrReviewRunStarted: async (tx, e) => {
    const p = (e.event as EventOf<'PrReviewRunStarted'>).payload;
    // an event from before rounds is a round of one with the run's own id
    const roundId = p.roundId ?? p.runId;
    await exec(
      tx,
      `INSERT INTO pr_review_rounds (id, pr_review_id, project_id, reviewers, trigger, requested_by, workstation_id, state, started_at)
       VALUES ($1,$2,$3,ARRAY[$4::text],$5,$6,$7,'running',$8)
       ON CONFLICT (id) DO NOTHING`,
      [roundId, p.prReviewId, p.projectId, p.reviewer, p.trigger ?? 'auto', p.requestedBy ?? null, p.workstationId, p.at],
    );
    await exec(
      tx,
      `INSERT INTO pr_review_runs (id, pr_review_id, project_id, reviewer, runtime, model, workstation_id, state, timeout_ms, started_at, trigger, requested_by, rerun_of_run_id, round_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'running',$8,$9,$10,$11,$12,$13)
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
        p.trigger ?? 'auto',
        p.requestedBy ?? null,
        p.rerunOfRunId ?? null,
        roundId,
      ],
    );
    if (p.rerunOfRunId)
      await exec(tx, 'UPDATE pr_review_rounds SET rerun_of_round_id=$2 WHERE id=$1', [roundId, p.rerunOfRunId]);
    await exec(tx, 'UPDATE pr_reviews SET last_run_id=$2 WHERE id=$1', [p.prReviewId, p.runId]);
  },
  PrReviewRunCompleted: async (tx, e) => {
    const p = (e.event as EventOf<'PrReviewRunCompleted'>).payload;
    await exec(
      tx,
      `UPDATE pr_review_runs SET state='completed', finished_at=$2, duration_ms=$3, head_sha=$4, base_sha=$5, summary=$6,
              changed_lines=$7, findings_cap=$8, held_back_count=$9
        WHERE id=$1`,
      [
        p.runId,
        p.at,
        p.durationMs,
        p.headSha,
        p.baseSha,
        p.summary,
        p.changedLines ?? null,
        p.findingsCap ?? null,
        p.findings.filter((f) => f.disposition === 'held_back').length,
      ],
    );
    // a round of one is posted as soon as its run is done (a round of two waits for its merge)
    await exec(
      tx,
      `UPDATE pr_review_rounds SET state='posting', posting_at=$2, changed_lines=$3, findings_cap=$4, held_back_count=$5
        WHERE id = (SELECT round_id FROM pr_review_runs WHERE id=$1) AND array_length(reviewers, 1) = 1 AND state='running'`,
      [
        p.runId,
        p.at,
        p.changedLines ?? null,
        p.findingsCap ?? null,
        p.findings.filter((f) => f.disposition === 'held_back').length,
      ],
    );
    for (const [idx, f] of p.findings.entries()) {
      await exec(
        tx,
        `INSERT INTO pr_review_findings (id, run_id, pr_review_id, idx, path, line, anchored, severity, title, body, rank, disposition)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id) DO NOTHING`,
        [
          f.findingId,
          p.runId,
          p.prReviewId,
          idx,
          f.path,
          f.line,
          f.anchored,
          f.severity,
          f.title,
          f.body,
          f.rank ?? null,
          f.disposition ?? 'posted',
        ],
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
    await endRoundOfOne(tx, p.runId, 'timed_out', 'timeout', p.at);
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
    await endRoundOfOne(tx, p.runId, 'failed', p.code, p.at);
  },
  PrReviewRunCancelled: async (tx, e) => {
    const p = (e.event as EventOf<'PrReviewRunCancelled'>).payload;
    await exec(
      tx,
      `UPDATE pr_review_runs SET state='cancelled', finished_at=$2, error_stage='run', error_code='cancelled'
        WHERE id=$1 AND state='running'`,
      [p.runId, p.at],
    );
  },
  PrReviewRoundStarted: async (tx, e) => {
    const p = (e.event as EventOf<'PrReviewRoundStarted'>).payload;
    await exec(
      tx,
      `INSERT INTO pr_review_rounds (id, pr_review_id, project_id, reviewers, trigger, requested_by, workstation_id, state, started_at)
       VALUES ($1,$2,$3,$4::text[],$5,$6,$7,'running',$8)
       ON CONFLICT (id) DO NOTHING`,
      [p.roundId, p.prReviewId, p.projectId, p.reviewers, p.trigger, p.requestedBy, p.workstationId, p.at],
    );
  },
  PrReviewRoundMerged: async (tx, e) => {
    const p = (e.event as EventOf<'PrReviewRoundMerged'>).payload;
    for (const f of p.findings)
      await exec(
        tx,
        `UPDATE pr_review_findings SET disposition=$2, rank=$3, merged_into=$4, severity=$5 WHERE id=$1`,
        [f.findingId, f.disposition, f.rank, f.mergedInto, f.severity],
      );
    await exec(
      tx,
      `UPDATE pr_review_rounds SET state='posting', posting_at=$2, changed_lines=$3, findings_cap=$4,
              held_back_count=$5, merged_count=$6
        WHERE id=$1`,
      [
        p.roundId,
        p.at,
        p.changedLines,
        p.findingsCap,
        p.findings.filter((f) => f.disposition === 'held_back').length,
        p.findings.filter((f) => f.disposition === 'merged').length,
      ],
    );
  },
  PrReviewRoundEnded: async (tx, e) => {
    const p = (e.event as EventOf<'PrReviewRoundEnded'>).payload;
    await exec(
      tx,
      `UPDATE pr_review_rounds SET state=$2, finished_at=$3, end_code=$4, cause_run_id=$5 WHERE id=$1`,
      [p.roundId, p.outcome, p.at, p.code, p.causeRunId],
    );
  },
  PrReviewPosted: async (tx, e) => {
    const p = (e.event as EventOf<'PrReviewPosted'>).payload;
    const roundId = p.roundId ?? p.runId;
    const reviewers = p.reviewers ?? [p.reviewer];
    await exec(
      tx,
      `UPDATE pr_review_runs SET state='posted', review_url=$2, posted_at=$3, error_stage=NULL, error_code=NULL, error=NULL
        WHERE round_id=$1 AND state NOT IN ('cancelled','timed_out')`,
      [roundId, p.reviewUrl, p.at],
    );
    await exec(
      tx,
      `UPDATE pr_review_findings SET posted=true
        WHERE run_id IN (SELECT id FROM pr_review_runs WHERE round_id=$1) AND id = ANY($2::uuid[])`,
      [roundId, p.postedFindingIds],
    );
    await exec(
      tx,
      `UPDATE pr_review_rounds SET state='posted', review_url=$2, posted_at=$3, finished_at=COALESCE(finished_at, $3),
              end_code=NULL, cause_run_id=NULL
        WHERE id=$1`,
      [roundId, p.reviewUrl, p.at],
    );
    await exec(
      tx,
      `UPDATE pr_reviews SET review_state='reviewed', reviewed_by=$2, reviewed_by_all=$3::text[], reviewed_at=$4, last_run_id=$5 WHERE id=$1`,
      [p.prReviewId, reviewers[0], reviewers, p.at, p.runId],
    );
  },
  PrReviewFindingMarked: async (tx, e) => {
    const p = (e.event as EventOf<'PrReviewFindingMarked'>).payload;
    await exec(
      tx,
      `INSERT INTO pr_review_finding_marks (finding_id, pr_review_id, run_id, project_id, mark, blind_mark, marked_by, marked_at, first_marked_at)
       VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$7)
       ON CONFLICT (finding_id) DO UPDATE SET mark=EXCLUDED.mark, marked_by=EXCLUDED.marked_by, marked_at=EXCLUDED.marked_at`,
      [p.findingId, p.prReviewId, p.runId, p.projectId, p.mark, p.markedBy, p.at],
    );
  },
};
