import { z } from 'zod';
import { nextDay, zonedDayStart } from '../costs/index.ts';
import { Usage } from '../events/define.ts';
import { localParts } from '../reporter/index.ts';
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

export const PR_REVIEW_TRIGGERS = ['auto', 'manual'] as const;
export const PrReviewTriggerSchema = z.enum(PR_REVIEW_TRIGGERS);
export type PrReviewTrigger = z.infer<typeof PrReviewTriggerSchema>;

/** today: inside today's admission window; later: waits for a following day; blocked: no ready reviewer workstation. */
export const PrReviewQueueSlotSchema = z.enum(['today', 'later', 'blocked']);
export type PrReviewQueueSlot = z.infer<typeof PrReviewQueueSlotSchema>;

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
  /** Added + removed lines as the forge reports them; null/absent when it does not say. */
  changedLines: z.number().int().nonnegative().nullable().optional(),
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
export const PR_REVIEWERS = ['first', 'second'] as const;
export const PrReviewerSchema = z.enum(PR_REVIEWERS);
export type PrReviewer = z.infer<typeof PrReviewerSchema>;

/** Boardroom: the first run uses the smaller model. */
export const REVIEWER_MODEL: Record<PrReviewer, { runtime: string; model: string }> = {
  first: { runtime: 'claude-code', model: 'sonnet' },
  second: { runtime: 'claude-code', model: 'opus' },
};

/**
 * The reviewers that review live pull requests. The second reviewer (Opus) runs only offline, in the 20-PR replay,
 * until a later card adds it here.
 */
export const LIVE_REVIEWERS = ['first'] as const satisfies readonly PrReviewer[];

/** A reviewer run stops after this long, whatever it is doing. */
export const PR_REVIEW_TIMEOUT_MS = 10 * 60_000;

/** Announced by a runner that understands `pr_review.run` and `pr_review.post`. */
export const PR_REVIEW_CAPABILITY = 'pr-review:1';

export const PR_REVIEW_RUN_STATES = [
  'running',
  'completed',
  'posted',
  'timed_out',
  'failed',
  'offline_completed',
] as const;
export const PrReviewRunStateSchema = z.enum(PR_REVIEW_RUN_STATES);
export type PrReviewRunState = z.infer<typeof PrReviewRunStateSchema>;

const Sha40 = z.string().regex(/^[0-9a-f]{40}$/);

/** The replay block of an offline run: the merged pull request to review at its recorded head. */
export const ReplayRunBlockSchema = z
  .object({
    replayId: z.uuid(),
    replayPrId: z.uuid(),
    headSha: Sha40,
    mergeCommitSha: Sha40,
  })
  .strict();
export type ReplayRunBlock = z.infer<typeof ReplayRunBlockSchema>;

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
    /** Offline run (20-PR replay): nothing is posted and no reviewer token is needed. `prReviewId` is the replay PR id. */
    offline: z.literal(true).optional(),
    replay: ReplayRunBlockSchema.optional(),
  })
  .strict()
  .refine((p) => !p.replay || p.offline === true, { message: 'replay requires offline' });
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
  /** Place in the run queue and why it waits; null when the pull request is not waiting in the queue. */
  queuePosition: z.number().int().positive().nullable().optional(),
  queueSlot: PrReviewQueueSlotSchema.nullable().optional(),
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
      trigger: PrReviewTriggerSchema.optional(),
      /** Findings the run produced, how many were held back by the cap, the cap, and the lines it came from. */
      findingsCount: z.number().optional(),
      heldBackCount: z.number().optional(),
      findingsCap: z.number().nullable().optional(),
      changedLines: z.number().nullable().optional(),
    })
    .nullable(),
});
export type PrReviewDto = z.infer<typeof PrReviewDtoSchema>;

// ---- daily cap on automatic reviews (PRD v22 F1.4) --------------------------------------------------------------

/** Boardroom default; the owner sets the cap per project. */
export const PR_REVIEW_DAILY_CAP_DEFAULT = 20;
export const PR_REVIEW_DAILY_CAP_MAX = 100;
export const PrReviewDailyCapSchema = z.number().int().min(1).max(PR_REVIEW_DAILY_CAP_MAX);
export const SetPrReviewCapRequestSchema = z.object({ cap: PrReviewDailyCapSchema });
export type SetPrReviewCapRequest = z.infer<typeof SetPrReviewCapRequestSchema>;

/** The local calendar day of `at` in `timeZone` (UTC when unknown or unset), with its [start, next) instants. */
export function reviewDayOf(
  at: Date,
  timeZone: string | null | undefined,
): { day: string; start: Date; next: Date } {
  const day = localParts(at, timeZone).date;
  return { day, start: zonedDayStart(day, timeZone), next: zonedDayStart(nextDay(day), timeZone) };
}

export interface QueueCandidate {
  id: string;
  openedAt: Date;
  changedLines: number | null;
}

/**
 * Run order of the queue: oldest first by the local day the pull request was opened; the same day: fewer changed lines
 * first (unknown size last); then the earlier open time; then the id (stable).
 */
export function compareQueue(tz: string | null | undefined) {
  return (a: QueueCandidate, b: QueueCandidate): number => {
    const da = localParts(a.openedAt, tz).date;
    const db = localParts(b.openedAt, tz).date;
    if (da !== db) return da < db ? -1 : 1;
    const la = a.changedLines ?? Number.POSITIVE_INFINITY;
    const lb = b.changedLines ?? Number.POSITIVE_INFINITY;
    if (la !== lb) return la < lb ? -1 : 1;
    if (a.openedAt.getTime() !== b.openedAt.getTime()) return a.openedAt.getTime() - b.openedAt.getTime();
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}

/** How many automatic reviews may still start today (never negative: the owner may lower the cap mid-day). */
export const autoReviewsLeft = (used: number, cap: number): number => Math.max(0, cap - used);

export const PR_REVIEW_BLOCKED_REASONS = [
  'reviewer_token_missing',
  'runner_outdated',
  'workstation_offline',
] as const;
export const PrReviewBlockedReasonSchema = z.enum(PR_REVIEW_BLOCKED_REASONS);
export type PrReviewBlockedReason = z.infer<typeof PrReviewBlockedReasonSchema>;

export const PrReviewQueueItemSchema = z.object({
  prReviewId: z.uuid(),
  /** 1 = runs next; blocked pull requests keep their place in run order. */
  position: z.number().int().positive(),
  repoId: z.uuid(),
  repoName: z.string(),
  changeId: z.string(),
  title: z.string(),
  url: z.string(),
  author: z.string().nullable(),
  openedAt: z.string(),
  openedDay: z.string(),
  changedLines: z.number().int().nullable(),
  slot: PrReviewQueueSlotSchema,
  blockedReason: PrReviewBlockedReasonSchema.nullable(),
  blockedProblem: z.string().nullable(),
});
export type PrReviewQueueItem = z.infer<typeof PrReviewQueueItemSchema>;

export const PrReviewQueueDtoSchema = z.object({
  day: z.string(),
  timeZone: z.string(),
  resetsAt: z.string(),
  used: z.number().int().nonnegative(),
  cap: z.number().int().positive(),
  /** Reviews the owner started by hand today: shown, never counted. */
  manualToday: z.number().int().nonnegative(),
  items: z.array(PrReviewQueueItemSchema),
});
export type PrReviewQueueDto = z.infer<typeof PrReviewQueueDtoSchema>;
