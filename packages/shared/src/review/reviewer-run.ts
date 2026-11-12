import { z } from 'zod';
import { GitRefSchema } from '../safe.ts';

/**
 * Reviewer runs on PR-only repositories: what a run is told, what a reviewer hands back, and what a workstation says
 * about its comment-only token. None of these carries a credential: the token is sealed on the workstation and the
 * server only ever learns whether one is there.
 */

/** What the server sends for one reviewer run. `.strict()` rejects any extra key such as `token`. */
export const ReviewerRunSpecSchema = z
  .object({
    runId: z.uuid(),
    projectId: z.uuid(),
    projectRepoId: z.uuid(),
    remoteUrlNormalized: z.string().max(500),
    prNumber: z.number().int().positive(),
    headSha: z.string().regex(/^[0-9a-f]{40}$/),
    baseSha: z.string().regex(/^[0-9a-f]{40}$/),
    baseRef: GitRefSchema,
  })
  .strict();
export type ReviewerRunSpec = z.infer<typeof ReviewerRunSpecSchema>;

/** One finding as the reviewer hands it to the runner, which posts it. */
export const ReviewFindingSchema = z
  .object({
    path: z.string().max(1000).optional(),
    line: z.number().int().positive().optional(),
    side: z.enum(['LEFT', 'RIGHT']).optional(),
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(10_000),
  })
  .strict();
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

/** The workstation's fact about a repository's reviewer token: present or not, never the value. */
export const ReviewerTokenFactSchema = z
  .object({
    present: z.boolean(),
    problem: z.enum(['unreadable', 'unsupported_host']).optional(),
  })
  .strict();
export type ReviewerTokenFact = z.infer<typeof ReviewerTokenFactSchema>;

/** What the owner sees on a PR-only repository. */
export const REVIEWER_TOKEN_STATES = ['present', 'missing'] as const;
export const ReviewerTokenStateSchema = z.enum(REVIEWER_TOKEN_STATES);
export type ReviewerTokenState = z.infer<typeof ReviewerTokenStateSchema>;
