import {
  type FindingMark,
  type FindingMarkReplayRow,
  findingView,
  type MarkFindingRequest,
  type PostedFindingDto,
  type PostedFindingRow,
  PR_REVIEWER_LABEL,
  type PrReviewer,
  precisionOf,
  type ReviewerPrecision,
  streamId,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { requireProjectMember } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { conflict, forbidden, notFound } from '../errors.ts';
import { projectScope, userActor } from './common.ts';

/**
 * The owner's useful/noise mark on a posted PR review finding. Only the project owner marks; the reviewer of a finding
 * is left out of every read until the finding is marked (blind marking: see `findingView`).
 */

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

const FINDING_SELECT = `
  SELECT f.id, f.pr_review_id, f.run_id, f.rank, f.severity, f.path, f.line, f.title, f.body,
         run.posted_at, run.review_url, m.mark, m.marked_at,
         COALESCE((SELECT json_agg(json_build_object('key', a.reviewer, 'model', a.model))
                     FROM pr_review_finding_attribution a WHERE a.finding_id = f.id), '[]'::json) AS reviewers
    FROM pr_review_findings f
    JOIN pr_review_runs run ON run.id = f.run_id
    LEFT JOIN pr_review_finding_marks m ON m.finding_id = f.id`;

function toRow(r: Record<string, unknown>): PostedFindingRow {
  const reviewers = (r.reviewers as Array<{ key: PrReviewer; model: string | null }>).map((x) => ({
    key: x.key,
    label: PR_REVIEWER_LABEL[x.key] ?? x.key,
    model: x.model ?? null,
  }));
  return {
    id: r.id as string,
    prReviewId: r.pr_review_id as string,
    runId: r.run_id as string,
    rank: r.rank === null || r.rank === undefined ? null : Number(r.rank),
    severity: r.severity as 'high' | 'medium' | 'low',
    path: r.path as string,
    line: r.line === null || r.line === undefined ? null : Number(r.line),
    title: r.title as string,
    body: r.body as string,
    postedAt: iso(r.posted_at),
    reviewUrl: (r.review_url as string | null) ?? null,
    mark: (r.mark as FindingMark | null) ?? null,
    markedAt: iso(r.marked_at),
    reviewers,
  };
}

/** The posted findings of a pull request (every run), blind while unmarked. */
export async function listPostedFindings(
  db: Queryable,
  prReviewId: string,
  opts: { canMark: boolean },
): Promise<PostedFindingDto[]> {
  const list = await rows(
    db,
    `${FINDING_SELECT} WHERE f.pr_review_id=$1 AND f.posted
      ORDER BY run.posted_at DESC, f.rank NULLS LAST, f.path, f.line NULLS FIRST, f.id`,
    [prReviewId],
  );
  return list.map((r) => findingView(toRow(r), opts));
}

export async function loadPostedFinding(
  db: Queryable,
  findingId: string,
  opts: { canMark: boolean },
): Promise<PostedFindingDto | undefined> {
  const r = await one(db, `${FINDING_SELECT} WHERE f.id=$1 AND f.posted`, [findingId]);
  return r ? findingView(toRow(r), opts) : undefined;
}

/** Marks one posted finding (owner only: 404 for a non-member, 403 for a manager, 409 for an unposted finding). */
export async function markFinding(
  ctx: Ctx,
  user: AuthSession['user'],
  findingId: string,
  req: MarkFindingRequest,
): Promise<PostedFindingDto> {
  return withAppendTx(ctx.pool, async (tx) => {
    const f = await one(
      tx,
      `SELECT f.id, f.posted, f.run_id, f.pr_review_id, pr.project_id
         FROM pr_review_findings f JOIN pr_reviews pr ON pr.id = f.pr_review_id
        WHERE f.id=$1 FOR UPDATE OF f`,
      [findingId],
    );
    if (!f) throw notFound('finding not found');
    const role = await requireProjectMember(tx, user.id, f.project_id as string);
    if (role !== 'owner') throw forbidden('only the project owner marks findings');
    if (!f.posted) throw conflict('finding_not_posted', 'only posted findings can be marked');
    const prev = await one(tx, 'SELECT mark FROM pr_review_finding_marks WHERE finding_id=$1', [findingId]);
    if (prev?.mark !== req.mark) {
      const project = await one(tx, 'SELECT org_id FROM projects WHERE id=$1', [f.project_id]);
      await ctx.store.append(
        [
          {
            streamId: streamId.project(f.project_id as string),
            event: {
              type: 'PrReviewFindingMarked',
              payload: {
                projectId: f.project_id as string,
                prReviewId: f.pr_review_id as string,
                runId: f.run_id as string,
                findingId,
                mark: req.mark,
                previousMark: (prev?.mark as FindingMark | undefined) ?? null,
                markedBy: user.id,
                at: ctx.clock.now().toISOString(),
              },
            },
            actor: userActor(user.id),
            scope: projectScope(project?.org_id as string, f.project_id as string),
          },
        ],
        { tx },
      );
    }
    const out = await loadPostedFinding(tx, findingId, { canMark: true });
    if (!out) throw notFound('finding not found');
    return out;
  });
}

/** Useful findings out of posted findings per reviewer for a project. Held-back and unposted findings never count. */
export async function reviewerPrecisionForProject(
  db: Queryable,
  projectId: string,
): Promise<ReviewerPrecision[]> {
  const list = await rows(
    db,
    `SELECT a.reviewer, array_agg(DISTINCT a.model) AS models,
            count(*)::int AS posted,
            count(*) FILTER (WHERE m.mark = 'useful')::int AS useful,
            count(*) FILTER (WHERE m.mark = 'noise')::int AS noise,
            count(*) FILTER (WHERE m.mark IS NULL)::int AS unmarked
       FROM pr_review_findings f
       JOIN pr_reviews pr ON pr.id = f.pr_review_id
       JOIN pr_review_finding_attribution a ON a.finding_id = f.id
       LEFT JOIN pr_review_finding_marks m ON m.finding_id = f.id
      WHERE pr.project_id = $1 AND f.posted
      GROUP BY a.reviewer ORDER BY a.reviewer`,
    [projectId],
  );
  return list.map((r) => ({
    reviewer: r.reviewer as PrReviewer,
    label: PR_REVIEWER_LABEL[r.reviewer as PrReviewer] ?? (r.reviewer as string),
    models: r.models as string[],
    posted: Number(r.posted),
    useful: Number(r.useful),
    noise: Number(r.noise),
    unmarked: Number(r.unmarked),
    precision: precisionOf(Number(r.posted), Number(r.useful)),
  }));
}

/** Marked posted findings with reviewer, PR and mark: the input to the 20-PR replay. */
export async function findingMarksForReplay(
  db: Queryable,
  projectId: string,
  opts: { since?: string; reviewer?: string } = {},
): Promise<FindingMarkReplayRow[]> {
  const list = await rows(
    db,
    `SELECT m.finding_id, m.run_id, m.pr_review_id, m.project_id, pr.project_repo_id AS repo_id, r.name AS repo_name,
            pr.change_id, pr.url AS pr_url, run.head_sha, a.reviewer, a.model,
            f.severity, f.rank, f.path, f.line, f.title,
            m.mark, m.blind_mark, m.marked_by, m.marked_at, m.first_marked_at, run.posted_at
       FROM pr_review_finding_marks m
       JOIN pr_review_findings f ON f.id = m.finding_id
       JOIN pr_review_runs run ON run.id = f.run_id
       JOIN pr_reviews pr ON pr.id = f.pr_review_id
       JOIN project_repos r ON r.id = pr.project_repo_id
       JOIN pr_review_finding_attribution a ON a.finding_id = f.id
      WHERE m.project_id = $1 AND f.posted
        AND ($2::timestamptz IS NULL OR m.marked_at >= $2) AND ($3::text IS NULL OR a.reviewer = $3)
      ORDER BY run.posted_at, f.rank NULLS LAST, m.finding_id`,
    [projectId, opts.since ?? null, opts.reviewer ?? null],
  );
  return list.map((r) => ({
    findingId: r.finding_id as string,
    runId: r.run_id as string,
    prReviewId: r.pr_review_id as string,
    projectId: r.project_id as string,
    repoId: r.repo_id as string,
    repoName: r.repo_name as string,
    changeId: r.change_id as string,
    prUrl: r.pr_url as string,
    headSha: (r.head_sha as string | null) ?? null,
    reviewer: r.reviewer as PrReviewer,
    model: r.model as string,
    severity: r.severity as 'high' | 'medium' | 'low',
    rank: r.rank === null ? null : Number(r.rank),
    path: r.path as string,
    line: r.line === null ? null : Number(r.line),
    title: r.title as string,
    mark: r.mark as FindingMark,
    blindMark: r.blind_mark as FindingMark,
    markedBy: r.marked_by as string,
    markedAt: iso(r.marked_at) as string,
    firstMarkedAt: iso(r.first_marked_at) as string,
    postedAt: iso(r.posted_at),
  }));
}
