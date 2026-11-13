import { z } from 'zod';
import { Usage } from '../events/define.ts';
import { GitRefSchema } from '../safe.ts';
import { ReviewerRunSpecSchema, ReviewFindingSchema } from './reviewer-run.ts';

/**
 * PR-only review: a project repository whose open pull requests are reviewed by reviewers instead of being built by
 * cards. A pull request seen on such a repository is recorded with a review state.
 */

/** Review states of a recorded pull request. `not_reviewed` until a reviewer run completes. */
export const PR_REVIEW_STATES = ['not_reviewed', 'reviewed'] as const;
export const PrReviewStateSchema = z.enum(PR_REVIEW_STATES);
export type PrReviewState = z.infer<typeof PrReviewStateSchema>;

/** At most this many open pull requests are listed per repository and poll; above it the list is not complete. */
export const PR_LIST_LIMIT = 200;

/** One open pull request (merge request) as the git host reports it. */
export const OpenChangeSchema = z.object({
  id: z.string().min(1).max(40),
  url: z.string().max(500),
  title: z.string().max(300),
  author: z.string().max(100).nullable(),
  head: z.string().max(200),
  base: z.string().max(200),
  createdAt: z.iso.datetime({ offset: true }),
});
export type OpenChange = z.infer<typeof OpenChangeSchema>;

/** `command.result` of `repo.list_prs`. `complete: false`: there were more open pull requests than listed. */
export const RepoListPrsResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    complete: z.boolean(),
    changes: z.array(OpenChangeSchema).max(PR_LIST_LIMIT),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(['no_clone', 'unsupported', 'not_connected', 'error']),
    error: z.string().max(400).optional(),
  }),
]);
export type RepoListPrsResult = z.infer<typeof RepoListPrsResultSchema>;

/** Why a PR-only repository is not being polled (shown to the owner next to the switch). */
export const PR_REVIEW_PROBLEMS = [
  'no_clone',
  'old_runner',
  'unsupported',
  'not_connected',
  'error',
] as const;
export const PrReviewProblemSchema = z.enum(PR_REVIEW_PROBLEMS);
export type PrReviewProblem = z.infer<typeof PrReviewProblemSchema>;

/** The reviewers a pull request can have; the first is the smaller model. */
export const PR_REVIEWERS = ['first'] as const;
export const PrReviewerSchema = z.enum(PR_REVIEWERS);
export type PrReviewer = z.infer<typeof PrReviewerSchema>;

/** Boardroom: the first run uses the smaller model. */
export const REVIEWER_MODEL: Record<PrReviewer, { runtime: string; model: string }> = {
  first: { runtime: 'claude-code', model: 'sonnet' },
};

/** A reviewer run stops after this long, whatever it is doing. */
export const PR_REVIEW_TIMEOUT_MS = 10 * 60_000;

/** Announced by a runner that understands `pr_review.run` and `pr_review.post`. */
export const PR_REVIEW_CAPABILITY = 'pr-review:1';

export const PR_REVIEW_RUN_STATES = ['running', 'completed', 'posted', 'timed_out', 'failed'] as const;
export const PrReviewRunStateSchema = z.enum(PR_REVIEW_RUN_STATES);
export type PrReviewRunState = z.infer<typeof PrReviewRunStateSchema>;

const Sha40 = z.string().regex(/^[0-9a-f]{40}$/);

/** What the model writes (validated on the runner). */
export const ReviewerFindingSchema = z.object({
  path: z.string().min(1).max(500),
  /** A line in the new file; null: the finding is about the file or the pull request. */
  line: z.number().int().positive().nullable(),
  severity: z.enum(['high', 'medium', 'low']),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(4000),
});
export type ReviewerFinding = z.infer<typeof ReviewerFindingSchema>;

export const ReviewerOutputSchema = z.object({
  summary: z.string().max(2000),
  findings: z.array(ReviewerFindingSchema).max(50),
});
export type ReviewerOutput = z.infer<typeof ReviewerOutputSchema>;

/** `anchored`: the line is in a diff hunk (right side), so the host accepts it as an inline comment. */
export const PrReviewFindingSchema = ReviewerFindingSchema.extend({ anchored: z.boolean() });
export type PrReviewFinding = z.infer<typeof PrReviewFindingSchema>;

/** `pr_review.run`: no commit ids (the server has none: the runner looks them up). Never a token. */
export const PrReviewRunPayloadSchema = z
  .object({
    runId: z.uuid(),
    projectId: z.uuid(),
    prReviewId: z.uuid(),
    projectRepoId: z.uuid(),
    remoteUrlNormalized: z.string().max(500),
    prNumber: z.number().int().positive(),
    baseRef: GitRefSchema,
    title: z.string().max(300),
    reviewer: PrReviewerSchema,
    runtime: z.string().max(40),
    model: z.string().max(120),
    timeoutMs: z.number().int().positive().max(PR_REVIEW_TIMEOUT_MS),
  })
  .strict();
export type PrReviewRunPayload = z.infer<typeof PrReviewRunPayloadSchema>;

export const PR_REVIEW_FAILURE_CODES = [
  'model_error',
  'bad_output',
  'no_checkout',
  'head_moved',
  'no_token',
  'unsupported',
  'runtime_unavailable',
  'error',
] as const;
export const PrReviewFailureCodeSchema = z.enum(PR_REVIEW_FAILURE_CODES);
export type PrReviewFailureCode = z.infer<typeof PrReviewFailureCodeSchema>;

/** `command.result` of `pr_review.run`. The run never posts. */
export const PrReviewRunResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('completed'),
    headSha: Sha40,
    baseSha: Sha40,
    durationMs: z.number().int().nonnegative(),
    summary: z.string().max(2000),
    findings: z.array(PrReviewFindingSchema).max(50),
    /** Added + removed lines of the change; absent when the runner could not count them (the cap is then 5). */
    changedLines: z.number().int().nonnegative().optional(),
    usage: Usage.optional(),
  }),
  z.object({
    outcome: z.literal('timeout'),
    durationMs: z.number().int().nonnegative(),
    phase: z.enum(['checkout', 'review']),
  }),
  z.object({
    outcome: z.literal('failed'),
    durationMs: z.number().int().nonnegative(),
    code: PrReviewFailureCodeSchema,
    error: z.string().max(400),
    retryable: z.boolean(),
  }),
]);
export type PrReviewRunResult = z.infer<typeof PrReviewRunResultSchema>;

/** `pr_review.post`: what the poster takes, plus finding ids for the result. Never a token. */
export const PrReviewPostPayloadSchema = z
  .object({
    runId: z.uuid(),
    spec: ReviewerRunSpecSchema,
    /** Ends with the run marker (`prReviewMarker`), which makes a repeated post harmless. */
    summary: z.string().max(60_000),
    findings: z.array(z.object({ findingId: z.uuid(), finding: ReviewFindingSchema })).max(50),
  })
  .strict();
export type PrReviewPostPayload = z.infer<typeof PrReviewPostPayloadSchema>;

export const PrReviewPostResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), reviewUrl: z.string().max(500), alreadyPosted: z.boolean() }),
  z.object({
    ok: z.literal(false),
    code: z.enum(['no_token', 'forbidden', 'not_found', 'stale_head', 'unsupported', 'unreachable', 'error']),
    error: z.string().max(400),
  }),
]);
export type PrReviewPostResult = z.infer<typeof PrReviewPostResultSchema>;

/** The hidden line a posted review ends with, so a resent post command finds the review it already made. */
export const prReviewMarker = (runId: string): string => `<!-- review-run:${runId} -->`;

/** What the owner sees for one recorded pull request (project view, Pull requests tab). */
export const PrReviewDtoSchema = z.object({
  id: z.uuid(),
  repoId: z.uuid(),
  repoName: z.string(),
  changeId: z.string(),
  url: z.string(),
  title: z.string(),
  author: z.string().nullable(),
  openedAt: z.string(),
  state: PrReviewStateSchema,
  reviewedAt: z.string().nullable(),
  /** Null while `reviewersHidden` (blind marking). */
  reviewer: PrReviewerSchema.nullable(),
  /** True while the pull request has posted findings the owner has not marked: the reviewer is not shown. */
  reviewersHidden: z.boolean().optional(),
  unmarkedCount: z.number().optional(),
  /** `missing`: the repository's workstation holds no comment-only token, so no run starts. */
  reviewerToken: z.enum(['present', 'missing']).nullable(),
  lastRun: z
    .object({
      state: PrReviewRunStateSchema,
      startedAt: z.string(),
      finishedAt: z.string().nullable(),
      durationMs: z.number().nullable(),
      timeoutMs: z.number(),
      error: z.string().nullable(),
      code: z.string().nullable(),
      postedCount: z.number(),
      reviewUrl: z.string().nullable(),
      /** Findings the run produced, how many were held back by the cap, the cap, and the lines it came from. */
      findingsCount: z.number().optional(),
      heldBackCount: z.number().optional(),
      findingsCap: z.number().nullable().optional(),
      changedLines: z.number().nullable().optional(),
    })
    .nullable(),
});
export type PrReviewDto = z.infer<typeof PrReviewDtoSchema>;
