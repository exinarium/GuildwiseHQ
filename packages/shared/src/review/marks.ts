import { z } from 'zod';
import { type PrReviewer, PrReviewerSchema } from './pr-review.ts';

/** One mark per posted finding: useful or noise. */
export const FindingMarkSchema = z.enum(['useful', 'noise']);
export type FindingMark = z.infer<typeof FindingMarkSchema>;

export const MarkFindingRequestSchema = z.object({ mark: FindingMarkSchema }).strict();
export type MarkFindingRequest = z.infer<typeof MarkFindingRequestSchema>;

/** Display names of the reviewers. */
export const PR_REVIEWER_LABEL: Record<PrReviewer, string> = {
  first: 'Sonnet reviewer',
  second: 'Opus reviewer',
};

/** Who produced a finding; present only once the finding is marked. */
export const FindingReviewerSchema = z.object({
  key: PrReviewerSchema,
  label: z.string(),
  model: z.string().nullable(),
});
export type FindingReviewer = z.infer<typeof FindingReviewerSchema>;

const SeveritySchema = z.enum(['high', 'medium', 'low']);

/** One posted finding as the owner sees it on the Pull requests tab. */
export const PostedFindingDtoSchema = z.object({
  id: z.uuid(),
  prReviewId: z.uuid(),
  runId: z.uuid(),
  rank: z.number().int().positive().nullable(),
  severity: SeveritySchema,
  path: z.string(),
  line: z.number().int().positive().nullable(),
  title: z.string(),
  body: z.string(),
  postedAt: z.string().nullable(),
  reviewUrl: z.string().nullable(),
  mark: FindingMarkSchema.nullable(),
  markedAt: z.string().nullable(),
  /** Blind marking: null while `mark` is null. */
  reviewers: z.array(FindingReviewerSchema).nullable(),
  canMark: z.boolean(),
});
export type PostedFindingDto = z.infer<typeof PostedFindingDtoSchema>;

export const PostedFindingsResponseSchema = z.object({ findings: z.array(PostedFindingDtoSchema) });
export type PostedFindingsResponse = z.infer<typeof PostedFindingsResponseSchema>;

export type PostedFindingRow = Omit<PostedFindingDto, 'reviewers' | 'canMark'> & {
  reviewers: FindingReviewer[];
};

/** The only way the server builds a finding DTO: drops the reviewers while the finding is unmarked. */
export function findingView(row: PostedFindingRow, opts: { canMark: boolean }): PostedFindingDto {
  const { reviewers, ...rest } = row;
  return { ...rest, reviewers: row.mark ? reviewers : null, canMark: opts.canMark };
}

/** PR-level reviewer details only once every posted finding is marked (an empty list reveals). */
export function reviewersRevealed(findings: ReadonlyArray<{ mark: FindingMark | null }>): boolean {
  return findings.every((f) => f.mark !== null);
}

export const ReviewerPrecisionSchema = z.object({
  reviewer: PrReviewerSchema,
  label: z.string(),
  models: z.array(z.string()),
  posted: z.number().int().nonnegative(),
  useful: z.number().int().nonnegative(),
  noise: z.number().int().nonnegative(),
  unmarked: z.number().int().nonnegative(),
  /** useful / posted; null when nothing was posted. */
  precision: z.number().min(0).max(1).nullable(),
});
export type ReviewerPrecision = z.infer<typeof ReviewerPrecisionSchema>;

export const ReviewerPrecisionResponseSchema = z.object({ reviewers: z.array(ReviewerPrecisionSchema) });
export type ReviewerPrecisionResponse = z.infer<typeof ReviewerPrecisionResponseSchema>;

/**
 * useful / posted per reviewer. A row counts when its disposition is 'posted' and `posted` is not false.
 * Held-back rows never count. Unmarked posted findings count in the denominator.
 */
export function reviewerPrecision(
  rows: ReadonlyArray<{
    reviewer: PrReviewer;
    model?: string | null;
    disposition: 'posted' | 'held_back';
    posted?: boolean;
    mark: FindingMark | null;
  }>,
): ReviewerPrecision[] {
  const by = new Map<PrReviewer, ReviewerPrecision>();
  for (const r of rows) {
    if (r.disposition !== 'posted' || r.posted === false) continue;
    let p = by.get(r.reviewer);
    if (!p) {
      p = {
        reviewer: r.reviewer,
        label: PR_REVIEWER_LABEL[r.reviewer],
        models: [],
        posted: 0,
        useful: 0,
        noise: 0,
        unmarked: 0,
        precision: null,
      };
      by.set(r.reviewer, p);
    }
    p.posted += 1;
    if (r.mark === 'useful') p.useful += 1;
    else if (r.mark === 'noise') p.noise += 1;
    else p.unmarked += 1;
    if (r.model && !p.models.includes(r.model)) p.models.push(r.model);
  }
  return [...by.values()]
    .map((p) => ({ ...p, precision: p.posted ? p.useful / p.posted : null }))
    .sort((a, b) => a.reviewer.localeCompare(b.reviewer));
}

/** Server: the same figure from counts already grouped in SQL. */
export function precisionOf(posted: number, useful: number): number | null {
  return posted > 0 ? useful / posted : null;
}

/** One marked finding as the 20-PR replay reads it. */
export const FindingMarkReplayRowSchema = z.object({
  findingId: z.uuid(),
  runId: z.uuid(),
  prReviewId: z.uuid(),
  projectId: z.uuid(),
  repoId: z.uuid(),
  repoName: z.string(),
  changeId: z.string(),
  prUrl: z.string(),
  headSha: z.string().nullable(),
  reviewer: PrReviewerSchema,
  model: z.string(),
  severity: SeveritySchema,
  rank: z.number().int().nullable(),
  path: z.string(),
  line: z.number().int().nullable(),
  title: z.string(),
  mark: FindingMarkSchema,
  blindMark: FindingMarkSchema,
  markedBy: z.uuid(),
  markedAt: z.string(),
  firstMarkedAt: z.string(),
  postedAt: z.string().nullable(),
});
export type FindingMarkReplayRow = z.infer<typeof FindingMarkReplayRowSchema>;

export const FindingMarkReplayResponseSchema = z.object({ marks: z.array(FindingMarkReplayRowSchema) });
export type FindingMarkReplayResponse = z.infer<typeof FindingMarkReplayResponseSchema>;
