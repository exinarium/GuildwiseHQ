import {
  type FindingMark,
  type PostedFindingDto,
  type PostedFindingRow,
  PR_REVIEWER_LABEL,
  type PrReviewer,
  REPLAY_REVIEWERS,
  type ReplayDto,
  type ReplayFailureReason,
  type ReplayFindingStep,
  type ReplayResult,
  type ReviewTargetsDto,
  replayFindingView,
} from '@aom/shared';
import { projectRole } from '../authz/scope.ts';
import { one, type Queryable, rows } from '../db/sql.ts';
import { notFound } from '../errors.ts';

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

/**
 * Blind: before the replay is finished the DTO has totals only. No reviewer, model, per-reviewer count, run duration
 * or run summary appears in it.
 */
export async function getReplayDto(
  db: Queryable,
  replayId: string,
  canManage: boolean,
): Promise<ReplayDto | undefined> {
  const rp = await one(
    db,
    `SELECT rp.*, r.name AS repo_name FROM pr_replays rp LEFT JOIN project_repos r ON r.id = rp.project_repo_id WHERE rp.id=$1`,
    [replayId],
  );
  if (!rp) return undefined;
  const prs = await rows(db, 'SELECT * FROM pr_replay_prs WHERE replay_id=$1 ORDER BY idx', [replayId]);
  const last = await rows(
    db,
    `SELECT DISTINCT ON (replay_pr_id, reviewer) state, attempt, retryable
       FROM pr_review_runs WHERE replay_id=$1 ORDER BY replay_pr_id, reviewer, started_at DESC, attempt DESC`,
    [replayId],
  );
  const counts = await one(
    db,
    `SELECT count(*) FILTER (WHERE f.disposition='posted')::int AS to_mark,
            count(m.finding_id) FILTER (WHERE f.disposition='posted')::int AS marked
       FROM pr_review_findings f LEFT JOIN pr_review_finding_marks m ON m.finding_id = f.id
      WHERE f.replay_id=$1`,
    [replayId],
  );
  const finished = rp.state === 'finished';
  return {
    id: rp.id as string,
    projectId: rp.project_id as string,
    repoId: rp.project_repo_id as string,
    repoName: (rp.repo_name as string | null) ?? '',
    state: rp.state as ReplayDto['state'],
    startedAt: iso(rp.started_at) as string,
    finishedAt: iso(rp.finished_at),
    failure: rp.failure_reason
      ? {
          reason: rp.failure_reason as ReplayFailureReason,
          found: rp.failure_found === null ? null : Number(rp.failure_found),
          detail: (rp.failure_detail as string | null) ?? null,
        }
      : null,
    prs: prs.map((p) => ({
      id: p.id as string,
      changeId: p.change_id as string,
      url: p.url as string,
      title: p.title as string,
      mergedAt: iso(p.merged_at) as string,
    })),
    progress: {
      runsTotal: prs.length * REPLAY_REVIEWERS.length,
      runsDone: last.filter((l) => l.state === 'offline_completed').length,
      runsFailed: last.filter((l) => l.state === 'failed' || l.state === 'timed_out').length,
      findingsToMark: Number(counts?.to_mark ?? 0),
      findingsMarked: Number(counts?.marked ?? 0),
    },
    result: finished ? ((rp.result as ReplayResult | null) ?? null) : null,
    canManage,
  };
}

export async function listReplays(db: Queryable, userId: string, projectId: string): Promise<ReplayDto[]> {
  const role = await projectRole(db, userId, projectId);
  if (!role) throw notFound('project not found');
  const ids = await rows(db, 'SELECT id FROM pr_replays WHERE project_id=$1 ORDER BY started_at DESC', [
    projectId,
  ]);
  const out: ReplayDto[] = [];
  for (const i of ids) {
    const d = await getReplayDto(db, i.id as string, role === 'owner');
    if (d) out.push(d);
  }
  return out;
}

const SELECT_FINDINGS = (withReviewers: boolean) => `
  SELECT f.id, f.replay_pr_id, f.run_id, f.rank, f.severity, f.path, f.line, f.title, f.body, f.disposition,
         m.mark, m.marked_at, p.idx AS pr_idx, p.change_id, p.url AS pr_url, p.title AS pr_title
         ${
           withReviewers
             ? `, COALESCE((SELECT json_agg(json_build_object('key', a.reviewer, 'model', a.model))
                            FROM pr_review_finding_attribution a WHERE a.finding_id = f.id), '[]'::json) AS reviewers`
             : ''
         }
    FROM pr_review_findings f
    JOIN pr_replay_prs p ON p.id = f.replay_pr_id
    LEFT JOIN pr_review_finding_marks m ON m.finding_id = f.id`;

function toRow(r: Record<string, unknown>): PostedFindingRow {
  const reviewers = ((r.reviewers as Array<{ key: PrReviewer; model: string | null }> | undefined) ?? []).map(
    (x) => ({
      key: x.key,
      label: PR_REVIEWER_LABEL[x.key] ?? x.key,
      model: x.model ?? null,
    }),
  );
  return {
    id: r.id as string,
    prReviewId: r.replay_pr_id as string,
    runId: r.run_id as string,
    rank: r.rank === null || r.rank === undefined ? null : Number(r.rank),
    severity: r.severity as 'high' | 'medium' | 'low',
    path: r.path as string,
    line: r.line === null || r.line === undefined ? null : Number(r.line),
    title: r.title as string,
    body: r.body as string,
    postedAt: null,
    reviewUrl: null,
    mark: (r.mark as FindingMark | null) ?? null,
    markedAt: iso(r.marked_at),
    reviewers,
  };
}

async function isFinished(db: Queryable, replayId: string): Promise<boolean> {
  const rp = await one(db, 'SELECT state FROM pr_replays WHERE id=$1', [replayId]);
  return rp?.state === 'finished';
}

/** One replay finding as the owner sees it: reviewers only when the whole replay is finished. */
export async function replayFindingStep(
  db: Queryable,
  _replayId: string,
  findingId: string,
  canMark: boolean,
): Promise<PostedFindingDto | undefined> {
  const f = await one(db, 'SELECT replay_id FROM pr_review_findings WHERE id=$1 AND replay_id IS NOT NULL', [
    findingId,
  ]);
  if (!f) return undefined;
  const revealed = await isFinished(db, f.replay_id as string);
  const r = await one(db, `${SELECT_FINDINGS(revealed)} WHERE f.id=$1`, [findingId]);
  return r ? replayFindingView(toRow(r), { revealed, canMark: canMark && !revealed }) : undefined;
}

/** The first unmarked would-post finding, in a reviewer-independent order. */
export async function nextReplayFinding(
  db: Queryable,
  replayId: string,
  canMark: boolean,
): Promise<ReplayFindingStep | null> {
  const all = await rows(
    db,
    `${SELECT_FINDINGS(false)} WHERE f.replay_id=$1 AND f.disposition='posted' ORDER BY p.idx, md5(f.id::text)`,
    [replayId],
  );
  const pos = all.findIndex((r) => !r.mark);
  if (pos < 0) return null;
  const r = all[pos] as Record<string, unknown>;
  return {
    finding: replayFindingView(toRow(r), { revealed: false, canMark }),
    pr: { changeId: r.change_id as string, url: r.pr_url as string, title: r.pr_title as string },
    position: pos + 1,
    total: all.length,
  };
}

/** Would-post findings (or the held-back ones) in marking order; reviewers once the replay is finished. */
export async function listReplayFindings(
  db: Queryable,
  replayId: string,
  opts: { held?: boolean; canMark: boolean },
): Promise<PostedFindingDto[]> {
  const revealed = await isFinished(db, replayId);
  const list = await rows(
    db,
    `${SELECT_FINDINGS(revealed)} WHERE f.replay_id=$1 AND f.disposition=$2 ORDER BY p.idx, md5(f.id::text)`,
    [replayId, opts.held ? 'held_back' : 'posted'],
  );
  return list.map((r) =>
    replayFindingView(toRow(r), { revealed, canMark: opts.canMark && !opts.held && !revealed }),
  );
}

export async function getReviewTargets(db: Queryable, projectId: string): Promise<ReviewTargetsDto> {
  const p = await one(
    db,
    `SELECT review_precision_target, review_effort_target_hours, review_targets_replay_id, review_targets_set_at
       FROM projects WHERE id=$1`,
    [projectId],
  );
  return {
    precisionTarget: p?.review_precision_target == null ? null : Number(p.review_precision_target),
    effortTargetHoursPerWeek:
      p?.review_effort_target_hours == null ? null : Number(p.review_effort_target_hours),
    replayId: (p?.review_targets_replay_id as string | null) ?? null,
    setAt: iso(p?.review_targets_set_at),
  };
}
