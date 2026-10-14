import { z } from 'zod';
import { StoredCompletionAction, TestEvidence } from '../cards/types.ts';
import { defineEvent, Id } from './define.ts';

/** Platforms a regression run can target; `both` creates one card per platform. */
export const RegressionPlatform = z.enum(['web', 'mobile', 'both']);
export type RegressionPlatform = z.infer<typeof RegressionPlatform>;
export const TestPlatform = z.enum(['web', 'mobile']);
export type TestPlatform = z.infer<typeof TestPlatform>;

/** What the test environment of a workstation lacked when a tester shift was about to start (section 13 / spec "Test environment"). */
export const TestEnvProblem = z.enum([
  'app_not_deployed',
  'docker_missing',
  /** Integration tests are on but no run plan exists for the project on this workstation yet (DevOps works it out). */
  'run_plan_missing',
  /** The test environment did not come up (the plan failed) or is gone. */
  'run_failed',
  /** Remote mode: the target does not answer. */
  'target_unreachable',
]);
export type TestEnvProblem = z.infer<typeof TestEnvProblem>;

/** Kind of a suite card: spawned after finalize (`full_suite`) or requested by the manager (`regression`). */
export const SuiteKind = z.enum(['full_suite', 'regression']);
export type SuiteKind = z.infer<typeof SuiteKind>;

/**
 * Testing events (docs/ARCHITECTURE.md section 5.2, M4). Audience `project`. Suite and bug cards are created by a
 * `CardCreated` in the same append as the event that spawns them.
 */
export const testingEvents = [
  /** After `CardFinalized`: a `regression`-type suite card is created in the same append, queued at `test`. */
  defineEvent(
    'FullSuiteStarted',
    z.object({
      cardId: Id,
      branch: z.string(),
      testerAgentId: Id.optional(),
      suiteCardId: Id,
    }),
  ),
  /** A suite or regression card ended green; the card is done. */
  defineEvent(
    'FullSuitePassed',
    z.object({
      suiteCardId: Id,
      evidence: TestEvidence,
      kind: SuiteKind.default('full_suite'),
      platform: TestPlatform.optional(),
    }),
  ),
  /** A genuine failure: the card is done (nothing is blocked) and `BugReported` follows in the same append. */
  defineEvent(
    'FullSuiteFailed',
    z.object({
      suiteCardId: Id,
      evidence: TestEvidence,
      testSideFixed: z.boolean().default(false),
      kind: SuiteKind.default('full_suite'),
      platform: TestPlatform.optional(),
    }),
  ),
  /** A bug card in Spec (for the BA) plus a non-blocking desk alert, both in the same append. */
  defineEvent(
    'BugReported',
    z.object({
      suiteCardId: Id.optional(),
      regressionCardId: Id.optional(),
      title: z.string().min(1).max(300),
      description: z.string(),
      evidence: TestEvidence,
      bugCardId: Id,
      deskItemId: Id,
    }),
  ),
  /** The manager started a regression run; one regression card per platform (`both` = web + mobile). */
  defineEvent(
    'RegressionRequested',
    z.object({
      projectId: Id,
      platform: RegressionPlatform,
      requestedBy: Id,
      regressionCardId: Id,
      /** Every card created for this request (`regressionCardId` is the first). */
      regressionCardIds: z.array(Id).default([]),
    }),
  ),
  /** Pinned desk alert (one open per project): E2E work waits and all testers are busy. */
  defineEvent(
    'TesterBottleneck',
    z.object({
      projectId: Id,
      deskItemId: Id,
      waitingCardIds: z.array(Id),
      busyTesterIds: z.array(Id),
      recommendation: z.object({ hire: z.literal('tester'), count: z.number().int().positive() }),
    }),
  ),
  /** The tester shift could not start: the app is not deployed or Docker is missing; a DevOps request was raised. */
  defineEvent(
    'TestEnvironmentParked',
    z.object({ cardId: Id, requestId: Id, problem: TestEnvProblem, detail: z.string().default('') }),
  ),
  /** The parked card's DevOps request completed: the card returns to the Test queue. */
  defineEvent('TestEnvironmentReady', z.object({ cardId: Id, requestId: Id })),
  /** Large-tier merge: the manager must approve on the desk before `finalize.execute` is queued. */
  defineEvent(
    'FinalizeApprovalRequested',
    z.object({ cardId: Id, action: StoredCompletionAction, deskItemId: Id, requestedBy: Id }),
  ),
  /** The completion action failed (or the approval was refused): the card is back at Finalize. */
  defineEvent(
    'FinalizeFailed',
    z.object({
      cardId: Id,
      action: StoredCompletionAction,
      error: z.string(),
      conflictedFiles: z.array(z.string()).default([]),
    }),
  ),
] as const;
