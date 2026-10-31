import { z } from 'zod';
import { StoredCompletionAction, TestEvidence } from '../cards/types.ts';
import { ForgeKindSchema } from '../forge/index.ts';
import { CommitAsSchema } from '../repo/commit-identity.ts';
import { globToRegExp } from '../workflows/high-risk.ts';

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
  /** The release commit of a Ship release stopped at a step (Retry or Dismiss). */
  releaseFailed: 'release_failed',
  /** The release commit of a Ship release is on the working branch (a notice). */
  releaseCommitted: 'release_committed',
  releasePublished: 'release_published',
  loopBackoff: 'loop_backoff',
  /** A card failed `LOOP_PARK_FAILURES` shifts in one loop-breaker episode: it is parked on one blocking item (S4 hook). */
  loopParked: 'loop_parked',
  /** The same question asked again on the same card and stage with nothing changed: the card is parked (one item). */
  repeatQuestion: 'repeat_question',
  /** The same question was answered and asked again `SERIAL_REPEAT.parkAt` times with nothing changed: the card is parked (one item). */
  repeatLoop: 'repeat_loop',
  /** A card used its budget of passes, rounds or shifts: the architect arbitrates, then the owner. */
  stopLoss: 'stop_loss',
  /** The tester failed a card again after its bug card was cancelled, or keeps asking for rework: the CEO decides (one item). */
  testerLoop: 'tester_loop',
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
  /** The runner's role smoke test failed for a role on a workstation: that role gets no work there (an alert). */
  roleSmokeFailed: 'role_smoke_failed',
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
  /**
   * lean team: the commit the review and the owner approval were for. The runner refuses to land a branch that is at another
   * commit (before its own rebase onto the working branch); absent: no check.
   */
  expectedSha: z.string().max(64).optional(),
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
  /** lean team: the branch was at another commit than `expectedSha`; nothing was landed. */
  headMoved: z.boolean().optional(),
  headSha: z.string().optional(),
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

/**
 * Failures of one loop-breaker episode after which the card is parked (blocked on one desk item) instead of backing off
 * again: the dispatcher stops claiming it until a manager answers the item or moves the card back to the queue.
 */
export const LOOP_PARK_FAILURES = 10;

/** Back-off after the `failures`-th failed shift of an episode (3 -> 1 min, 4 -> 2 min, ... capped at 1 h). */
export function loopBackoffMinutes(failures: number): number {
  return Math.min(
    LOOP_BREAKER.capMinutes,
    LOOP_BREAKER.baseMinutes * 2 ** Math.max(0, failures - LOOP_BREAKER.failures),
  );
}

/** Consecutive tester reworks of one card with no new commit between them before the CEO is asked (`tester_loop`). */
export const TESTER_REWORK_CAP = 3;

/** All tester reworks of one card since its last test result or `tester_loop` answer, even when the branch moves between them. */
export const TESTER_TOTAL_REWORK_CAP = 6;

/** Option ids of a `tester_loop` question: each performs its action when the item is answered. */
export const TESTER_LOOP_OPTIONS = {
  builder: 'builder',
  tester: 'tester',
  cancel: 'cancel',
} as const;

const PATH_TOKEN = /(?:[A-Za-z0-9_.@~-]*\/)+[A-Za-z0-9_.@-]+\.[A-Za-z0-9]{1,8}\b/g;

/**
 * Does a failure report (the tester's note, title and evidence summary and output) name only the project's E2E paths?
 * Then the work may be in the E2E spec or its fixtures, which only the tester may change (production: GWP-11). This is a
 * HINT shown in the `tester_loop` question: it never overrides the scope the tester reported.
 * Conservative: any path outside the E2E globs, or no path at all, is not an E2E-only failure.
 */
export function e2eOnlyFailure(
  text: string,
  e2eGlobs: readonly string[],
): { e2eOnly: boolean; paths: string[]; reason: string } {
  const none = { e2eOnly: false, paths: [] as string[] };
  if (e2eGlobs.length === 0) return { ...none, reason: 'the project has no E2E paths' };
  const res = e2eGlobs.map((g) => globToRegExp(g));
  const clean = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ');
  const tokens = [...new Set(clean.match(PATH_TOKEN) ?? [])];
  const isE2e = (raw: string): boolean => {
    const path = raw.replace(/^(?:\.\/)+/, '');
    if (res.some((re) => re.test(path))) return true;
    if (!path.startsWith('/')) return false;
    // An absolute path (a worktree): any tail of it that is an E2E path.
    const parts = path.split('/').filter(Boolean);
    return parts.some((_, i) => res.some((re) => re.test(parts.slice(i).join('/'))));
  };
  const e2e = tokens.filter(isE2e);
  const other = tokens.filter((t) => !isE2e(t));
  if (other.length > 0)
    return { e2eOnly: false, paths: e2e, reason: `it names a path outside the E2E paths: ${other[0]}` };
  if (e2e.length > 0)
    return { e2eOnly: true, paths: e2e, reason: `it names only E2E paths (${e2e.slice(0, 3).join(', ')})` };
  return { ...none, reason: 'it names no E2E path' };
}
