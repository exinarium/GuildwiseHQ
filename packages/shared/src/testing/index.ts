import { z } from 'zod';
import { StoredCompletionAction, TestEvidence } from '../cards/types.ts';
import { ForgeKindSchema } from '../forge/index.ts';
import { CommitAsSchema } from '../repo/commit-identity.ts';

/**
 * M4 contract shared by the server and the runner: the `finalize.execute` runner command, the tester environment
 * check and the constants of the bug loop (docs/ARCHITECTURE.md sections 5.2, 9.5, 13.5, 13.6 and 24).
 */

/** Minutes E2E work may wait with every tester busy before the bottleneck alert appears (section 9.5). */
export const TESTER_BOTTLENECK_MINUTES = 5;

/** A suite flaky this many times within `FLAKY_WINDOW_DAYS` raises a desk notice for the project. */
export const FLAKY_NOTICE_COUNT = 3;
export const FLAKY_WINDOW_DAYS = 7;

/** Desk `subkind` values M4 introduces. */
export const DESK_SUBKIND = {
  largeMerge: 'large_merge',
  testerBottleneck: 'tester_bottleneck',
  testEnvironment: 'test_environment',
  /** A suite that failed and passed again (flaky) three times in seven days: a notice per project and suite. */
  flakySuite: 'flaky_suite',
  bugReported: 'bug_reported',
  finalizeFailed: 'finalize_failed',
  prNotice: 'pr_notice',
  savedWork: 'saved_work',
  /** Repository hygiene removed branches of finished cards (a notice, one per run). */
  branchCleanup: 'branch_cleanup',
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
  /** Backlog #65: no commit identity is set for a project on a workstation, so the runner refuses to commit (an alert). */
  noCommitIdentity: 'no_commit_identity',
  /** The runtime's login (Claude Code `/login`) expired on a workstation; cleared when it works again (a notice). */
  claudeAuthExpired: 'claude_auth_expired',
  /** The model usage limit (Claude subscription) was hit on a workstation; cleared when work can resume (a notice, backlog #73). */
  claudeUsageLimit: 'claude_usage_limit',
  /** A plugin MCP server granted to a project needs sign-in on a workstation; cleared when signed in (a notice). */
  mcpNeedsSignIn: 'mcp_needs_sign_in',
  /** Investigate & design is switched on for a project but no architect is hired (a notice). */
  noArchitect: 'no_architect',
  /** A sub-workflow stage could not start its child card; the parent card is blocked until the manager looks (an alert). */
  subworkflowRefused: 'subworkflow_refused',
  /** Manual QA (docs/design/manual-qa.md): a finished card waits for the person who started it to test it. */
  manualQa: 'manual_qa',
  /** A card waits at an approval step (workflow `human` step with purpose approval). */
  approvalStep: 'approval_step',
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
  action: StoredCompletionAction,
  repoId: z.uuid(),
  remoteUrlNormalized: z.string(),
  baseBranch: z.string(),
  branchName: z.string(),
  /** Where the card's worktree lives on the workstation (null when unknown: the runner recreates it). */
  worktreePath: z.string().nullable(),
  /**
   * Pull request branch name on the git host: the runner pushes `<local branch>:<remote name>`. `remoteBranch` is a name
   * pushed earlier (rework updates the same branch and pull request); otherwise `<prBranchPrefix>/<ticket>`, with
   * `-2`, `-3` when origin already has it. Absent (old servers): the local branch name is used.
   */
  prBranchPrefix: z.string().optional(),
  ticket: z.string().optional(),
  remoteBranch: z.string().optional(),
  prTitle: z.string().optional(),
  prBody: z.string().optional(),
  /** The git provider chosen on the repository (absent: detected from the remote URL). */
  forge: ForgeKindSchema.optional(),
  /** The project's "Commit as" setting (absent: the clone's or the workstation's git identity). */
  commitAs: CommitAsSchema.nullable().optional(),
});
export type FinalizeExecutePayload = z.infer<typeof FinalizeExecutePayloadSchema>;

/** `command.result.result` of `finalize.execute`. Expected failures set `ok: false` with `error` or `conflict`. */
export const FinalizeResultSchema = z.object({
  ok: z.boolean(),
  action: StoredCompletionAction,
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
