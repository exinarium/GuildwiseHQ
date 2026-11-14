import { z } from 'zod';
import { FindingDispositionSchema } from '../review/findings.ts';
import { PrReviewerSchema } from '../review/pr-review.ts';
import { ReplayFailureReasonSchema, ReplayResultSchema } from '../review/replay.ts';
import { defineEvent, Id, IsoDate } from './define.ts';

const Sha = z.string().max(64);

/**
 * The 20-PR replay (stream `prreplay-<id>`). Runs and findings of a replay are projected into `pr_review_runs` and
 * `pr_review_findings` with the replay ids set, so no live reader sees a replay event as a live one.
 */
export const prReplayEvents = [
  defineEvent(
    'PrReplayStarted',
    z.object({
      replayId: Id,
      projectId: Id,
      repoId: Id,
      requestId: Id,
      workstationId: Id.nullable(),
      by: Id,
      at: IsoDate,
    }),
  ),
  defineEvent(
    'PrReplayPrsSelected',
    z.object({
      replayId: Id,
      prs: z
        .array(
          z.object({
            replayPrId: Id,
            idx: z.number().int().nonnegative(),
            changeId: z.string().min(1).max(40),
            url: z.string().max(500),
            title: z.string().max(300),
            author: z.string().max(100).nullable(),
            headBranch: z.string().max(200),
            baseBranch: z.string().max(200),
            headSha: Sha,
            mergeCommitSha: Sha,
            mergedAt: IsoDate,
            additions: z.number().int().nonnegative(),
            deletions: z.number().int().nonnegative(),
          }),
        )
        .max(100),
      at: IsoDate,
    }),
  ),
  defineEvent(
    'PrReplayFailed',
    z.object({
      replayId: Id,
      reason: ReplayFailureReasonSchema,
      found: z.number().int().optional(),
      detail: z.string().max(400).optional(),
      at: IsoDate,
    }),
  ),
  defineEvent(
    'PrReplayRunStarted',
    z.object({
      replayId: Id,
      replayPrId: Id,
      projectId: Id,
      runId: Id,
      reviewer: PrReviewerSchema,
      runtime: z.string().max(40),
      model: z.string().max(120),
      workstationId: Id,
      timeoutMs: z.number().int().positive(),
      attempt: z.number().int().positive(),
      at: IsoDate,
    }),
  ),
  defineEvent(
    'PrReplayRunCompleted',
    z.object({
      replayId: Id,
      replayPrId: Id,
      runId: Id,
      headSha: Sha,
      baseSha: Sha,
      durationMs: z.number().int().nonnegative(),
      changedLines: z.number().int().nonnegative().nullable(),
      findingsCap: z.number().int().min(1).max(5),
      summary: z.string().max(2000),
      findings: z
        .array(
          z.object({
            findingId: Id,
            idx: z.number().int().nonnegative(),
            rank: z.number().int().positive(),
            path: z.string().max(500),
            line: z.number().int().positive().nullable(),
            anchored: z.boolean(),
            severity: z.enum(['high', 'medium', 'low']),
            title: z.string().max(200),
            body: z.string().max(4000),
            /** `posted`: would have been posted (never actually posted). */
            disposition: FindingDispositionSchema,
          }),
        )
        .max(50),
      at: IsoDate,
    }),
  ),
  defineEvent(
    'PrReplayRunTimedOut',
    z.object({
      replayId: Id,
      replayPrId: Id,
      runId: Id,
      durationMs: z.number().int().nonnegative(),
      phase: z.enum(['checkout', 'review']),
      by: z.enum(['runner', 'server']),
      at: IsoDate,
    }),
  ),
  defineEvent(
    'PrReplayRunFailed',
    z.object({
      replayId: Id,
      replayPrId: Id,
      runId: Id,
      code: z.string().max(40),
      error: z.string().max(400),
      retryable: z.boolean(),
      durationMs: z.number().int().nonnegative().optional(),
      at: IsoDate,
    }),
  ),
  /** Every review slot is terminal: marking starts. */
  defineEvent('PrReplayReviewsDone', z.object({ replayId: Id, at: IsoDate })),
  /** A would-post finding was shown to the owner in the marking view (effort clock). */
  defineEvent('PrReplayFindingShown', z.object({ replayId: Id, findingId: Id, at: IsoDate })),
  /** The last would-post finding was marked: the result is fixed and the reviewers are revealed. */
  defineEvent('PrReplayMarkingFinished', z.object({ replayId: Id, result: ReplayResultSchema, at: IsoDate })),
  defineEvent('PrReplayCancelled', z.object({ replayId: Id, by: Id, at: IsoDate })),
  /** The owner asked for the reviews that did not finish to be tried again. */
  defineEvent('PrReplayRetryRequested', z.object({ replayId: Id, by: Id, at: IsoDate })),
] as const;
