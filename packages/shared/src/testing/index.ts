import { z } from 'zod';
import { CompletionAction, TestEvidence } from '../cards/types.ts';
import { ForgeKindSchema } from '../forge/index.ts';

/**
 * M4 contract shared by the server and the runner: the `finalize.execute` runner command, the tester environment
 * check and the constants of the bug loop (docs/ARCHITECTURE.md sections 5.2, 9.5, 13.5, 13.6 and 24).
 */

/** Minutes E2E work may wait with every tester busy before the bottleneck alert appears (section 9.5). */
export const TESTER_BOTTLENECK_MINUTES = 5;

/** Desk `subkind` values M4 introduces. */
export const DESK_SUBKIND = {
  largeMerge: 'large_merge',
  testerBottleneck: 'tester_bottleneck',
  testEnvironment: 'test_environment',
  bugReported: 'bug_reported',
  finalizeFailed: 'finalize_failed',
  prNotice: 'pr_notice',
  savedWork: 'saved_work',
  outbound: 'outbound',
  outboundFailed: 'outbound_failed',
  repoCreate: 'repo_create',
  repoCreateFailed: 'repo_create_failed',
  loopBackoff: 'loop_backoff',
  /** D5: a project environment needs access or failed on a workstation. */
  environmentAttention: 'environment_attention',
  /** G-Q2: DevOps is trying to resolve a rebase/merge conflict (a notice). */
  conflictAttempt: 'conflict_attempt',
  /** G-Q2: two DevOps attempts failed; the conflict needs a person. */
  conflictUnresolved: 'conflict_unresolved',
  /** The latest main branch could not be merged into the working branch before a build (a notice). */
  mainMergeSkipped: 'main_merge_skipped',
  mainBranchUnset: 'main_branch_unset',
  /** Investigate & design is switched on for a project but no architect is hired (a notice). */
  noArchitect: 'no_architect',
  /** A sub-workflow stage could not start its child card; the parent card is blocked until the manager looks (an alert). */
  subworkflowRefused: 'subworkflow_refused',
} as const;

/** Card origins whose card is a suite (full E2E suite or regression run) rather than a feature under test. */
export const SUITE_ORIGINS = ['full_suite', 'regression'] as const;
export const isSuiteOrigin = (origin: string | null | undefined): boolean =>
  origin === 'full_suite' || origin === 'regression';

/** Payload of the `finalize.execute` runner command. The runner executes the completion action (no agent involved). */
export const FinalizeExecutePayloadSchema = z.object({
  cardId: z.uuid(),
  ref: z.string(),
  title: z.string(),
  projectKey: z.string(),
  /** Keeps worktree directories of same-keyed projects (other organizations) apart; absent in old commands. */
  projectId: z.uuid().optional(),
  action: CompletionAction,
  repoId: z.uuid(),
  remoteUrlNormalized: z.string(),
  baseBranch: z.string(),
  branchName: z.string(),
  /** Where the card's worktree lives on the workstation (null when unknown: the runner recreates it). */
  worktreePath: z.string().nullable(),
  prTitle: z.string().optional(),
  prBody: z.string().optional(),
  /** The git provider chosen on the repository (absent: detected from the remote URL). */
  forge: ForgeKindSchema.optional(),
});
export type FinalizeExecutePayload = z.infer<typeof FinalizeExecutePayloadSchema>;

/** `command.result.result` of `finalize.execute`. Expected failures set `ok: false` with `error` or `conflict`. */
export const FinalizeResultSchema = z.object({
  ok: z.boolean(),
  action: CompletionAction,
  mergeCommit: z.string().optional(),
  prUrl: z.string().optional(),
  pushedBranch: z.string().optional(),
  /** E.g. `gh` was not available: the branch was pushed and the manager opens the PR by hand. */
  notice: z.string().optional(),
  /** The working branch is protected: the change went out as a pull request instead of a merge (`action` is then `pr`). */
  protectedBranch: z.boolean().optional(),
  /** The pre-finalize rebase conflicted (card goes to Rework, no agent resolves it). */
  conflict: z.boolean().optional(),
  conflictedFiles: z.array(z.string()).optional(),
  error: z.string().optional(),
});
export type FinalizeResult = z.infer<typeof FinalizeResultSchema>;

/** Data of the `fail` outcome of a tester: the bug that becomes a child card (or a standalone bug after finalize). */
export const TestFailDataSchema = TestEvidence.extend({ title: z.string().min(1).max(300) });
export type TestFailData = z.infer<typeof TestFailDataSchema>;

/** Bug card description assembled from a tester's failure report. */
export function bugDescription(input: { note: string; evidence: TestEvidence; parentRef?: string }): string {
  const lines: string[] = [];
  if (input.parentRef) lines.push(`Found while testing ${input.parentRef}.`, '');
  lines.push(input.note.trim());
  if (input.evidence.summary.trim() && input.evidence.summary.trim() !== input.note.trim())
    lines.push('', `Evidence: ${input.evidence.summary.trim()}`);
  if (input.evidence.commands.length)
    lines.push('', 'Commands:', ...input.evidence.commands.map((c) => `- ${c}`));
  if (input.evidence.outputExcerpt.trim()) lines.push('', 'Output:', input.evidence.outputExcerpt.trim());
  return lines.join('\n');
}

/** Loop breaker (docs/design/phases.md B0): failed shifts on one card within a window put the card in back-off. */
export const LOOP_BREAKER = { failures: 3, windowMinutes: 10, baseMinutes: 1, capMinutes: 60 } as const;

/** Back-off after the `failures`-th failed shift of an episode (3 -> 1 min, 4 -> 2 min, ... capped at 1 h). */
export function loopBackoffMinutes(failures: number): number {
  return Math.min(
    LOOP_BREAKER.capMinutes,
    LOOP_BREAKER.baseMinutes * 2 ** Math.max(0, failures - LOOP_BREAKER.failures),
  );
}
