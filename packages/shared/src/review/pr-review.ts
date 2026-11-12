import { z } from 'zod';

/**
 * PR-only review: a project repository whose open pull requests are reviewed by reviewers instead of being built by
 * cards. A pull request seen on such a repository is recorded with a review state.
 */

/** Review states of a recorded pull request. `not_reviewed` until a reviewer run completes. */
export const PR_REVIEW_STATES = ['not_reviewed'] as const;
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
