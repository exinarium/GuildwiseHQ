import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

/**
 * The 20-PR replay (projection of the `PrReplay*` events). Runs and findings go into the live tables with
 * `replay_id` set and `pr_review_id` NULL. A replay finding never gets `posted = true`: `disposition = 'posted'` only
 * means it would have been posted.
 */
export const prReplayProjectors: Record<string, Projector> = {
  PrReplayStarted: async (tx, e) => {
    const p = (e.event as EventOf<'PrReplayStarted'>).payload;
    await exec(
      tx,
      `INSERT INTO pr_replays (id, project_id, project_repo_id, state, request_id, workstation_id, started_by, started_at)
       VALUES ($1,$2,$3,'listing',$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
      [p.replayId, p.projectId, p.repoId, p.requestId, p.workstationId, p.by, p.at],
    );
  },
  PrReplayPrsSelected: async (tx, e) => {
    const p = (e.event as EventOf<'PrReplayPrsSelected'>).payload;
    for (const pr of p.prs) {
      await exec(
        tx,
        `INSERT INTO pr_replay_prs (id, replay_id, idx, change_id, url, title, author, head_branch, base_branch, head_sha,
                                    merge_commit_sha, merged_at, additions, deletions)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (id) DO NOTHING`,
        [
          pr.replayPrId,
          p.replayId,
          pr.idx,
          pr.changeId,
          pr.url,
          pr.title,
          pr.author,
          pr.headBranch,
          pr.baseBranch,
          pr.headSha,
          pr.mergeCommitSha,
          pr.mergedAt,
          pr.additions,
          pr.deletions,
        ],
      );
    }
    await exec(tx, `UPDATE pr_replays SET state='reviewing' WHERE id=$1`, [p.replayId]);
  },
  PrReplayFailed: async (tx, e) => {
    const p = (e.event as EventOf<'PrReplayFailed'>).payload;
    await exec(
      tx,
      `UPDATE pr_replays SET state='failed', finished_at=$2, failure_reason=$3, failure_found=$4, failure_detail=$5 WHERE id=$1`,
      [p.replayId, p.at, p.reason, p.found ?? null, p.detail ?? null],
    );
  },
  PrReplayRunStarted: async (tx, e) => {
    const p = (e.event as EventOf<'PrReplayRunStarted'>).payload;
    await exec(
      tx,
      `INSERT INTO pr_review_runs (id, pr_review_id, replay_id, replay_pr_id, attempt, project_id, reviewer, runtime, model,
                                   workstation_id, state, timeout_ms, started_at)
       VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,$8,$9,'running',$10,$11) ON CONFLICT (id) DO NOTHING`,
      [
        p.runId,
        p.replayId,
        p.replayPrId,
        p.attempt,
        p.projectId,
        p.reviewer,
        p.runtime,
        p.model,
        p.workstationId,
        p.timeoutMs,
        p.at,
      ],
    );
  },
  PrReplayRunCompleted: async (tx, e) => {
    const p = (e.event as EventOf<'PrReplayRunCompleted'>).payload;
    await exec(
      tx,
      `UPDATE pr_review_runs SET state='offline_completed', finished_at=$2, duration_ms=$3, head_sha=$4, base_sha=$5,
              summary=$6, changed_lines=$7, findings_cap=$8, held_back_count=$9
        WHERE id=$1`,
      [
        p.runId,
        p.at,
        p.durationMs,
        p.headSha,
        p.baseSha,
        p.summary,
        p.changedLines,
        p.findingsCap,
        p.findings.filter((f) => f.disposition === 'held_back').length,
      ],
    );
    for (const f of p.findings) {
      await exec(
        tx,
        `INSERT INTO pr_review_findings (id, run_id, pr_review_id, replay_id, replay_pr_id, idx, path, line, anchored,
                                         severity, title, body, rank, disposition, posted)
         VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,false) ON CONFLICT (id) DO NOTHING`,
        [
          f.findingId,
          p.runId,
          p.replayId,
          p.replayPrId,
          f.idx,
          f.path,
          f.line,
          f.anchored,
          f.severity,
          f.title,
          f.body,
          f.rank,
          f.disposition,
        ],
      );
    }
  },
  PrReplayRunTimedOut: async (tx, e) => {
    const p = (e.event as EventOf<'PrReplayRunTimedOut'>).payload;
    await exec(
      tx,
      `UPDATE pr_review_runs SET state='timed_out', finished_at=$2, duration_ms=$3, timed_out_by=$4,
              error_stage='run', error_code='timeout' WHERE id=$1`,
      [p.runId, p.at, p.durationMs, p.by],
    );
  },
  PrReplayRunFailed: async (tx, e) => {
    const p = (e.event as EventOf<'PrReplayRunFailed'>).payload;
    await exec(
      tx,
      `UPDATE pr_review_runs SET state='failed', finished_at=$2, duration_ms=COALESCE($3, duration_ms),
              error_stage='run', error_code=$4, error=$5, retryable=$6 WHERE id=$1`,
      [p.runId, p.at, p.durationMs ?? null, p.code, p.error, p.retryable],
    );
  },
  PrReplayReviewsDone: async (tx, e) => {
    const p = (e.event as EventOf<'PrReplayReviewsDone'>).payload;
    await exec(tx, `UPDATE pr_replays SET state='marking', reviews_done_at=$2 WHERE id=$1`, [
      p.replayId,
      p.at,
    ]);
  },
  PrReplayFindingShown: async (tx, e) => {
    const p = (e.event as EventOf<'PrReplayFindingShown'>).payload;
    // the clock only moves while the finding has no mark
    await exec(
      tx,
      `INSERT INTO pr_replay_finding_views (finding_id, replay_id, first_shown_at, last_shown_at, shown_count)
       VALUES ($1,$2,$3,$3,1)
       ON CONFLICT (finding_id) DO UPDATE SET
         last_shown_at = CASE WHEN EXISTS (SELECT 1 FROM pr_review_finding_marks m WHERE m.finding_id = pr_replay_finding_views.finding_id)
                              THEN pr_replay_finding_views.last_shown_at ELSE EXCLUDED.last_shown_at END,
         shown_count = pr_replay_finding_views.shown_count + 1`,
      [p.findingId, p.replayId, p.at],
    );
  },
  PrReplayMarkingFinished: async (tx, e) => {
    const p = (e.event as EventOf<'PrReplayMarkingFinished'>).payload;
    await exec(tx, `UPDATE pr_replays SET state='finished', finished_at=$2, result=$3 WHERE id=$1`, [
      p.replayId,
      p.at,
      JSON.stringify(p.result),
    ]);
  },
  PrReplayCancelled: async (tx, e) => {
    const p = (e.event as EventOf<'PrReplayCancelled'>).payload;
    await exec(tx, `UPDATE pr_replays SET state='cancelled', finished_at=$2 WHERE id=$1`, [p.replayId, p.at]);
  },
  PrReplayRetryRequested: async (tx, e) => {
    const p = (e.event as EventOf<'PrReplayRetryRequested'>).payload;
    await exec(tx, `UPDATE pr_replays SET state='reviewing', reviews_done_at=NULL WHERE id=$1`, [p.replayId]);
    // every unfinished slot gets a fresh set of attempts, tried again at once
    await exec(
      tx,
      `UPDATE pr_review_runs SET attempt=1, retryable=true, finished_at = $2::timestamptz - interval '1 day'
        WHERE replay_id=$1 AND state IN ('failed','timed_out')`,
      [p.replayId, p.at],
    );
  },
};
