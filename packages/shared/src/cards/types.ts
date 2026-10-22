import { z } from 'zod';

export const CardType = z.enum([
  'feature',
  'bug',
  'support',
  'refactor',
  'docs',
  'research',
  'feed',
  'regression',
]);
export type CardType = z.infer<typeof CardType>;

export const CardStatus = z.enum([
  'draft',
  'queued',
  'claimed',
  'blocked',
  'waiting',
  'held',
  'done',
  'cancelled',
]);
export type CardStatus = z.infer<typeof CardStatus>;

/**
 * The completion actions a command may set. `push_branch` was retired (backlog #61: no card or agent branch is pushed
 * unless the goal is a pull request); it is only kept in the Stored* variants below so old events, rows and
 * finalized cards still parse.
 */
export const CompletionAction = z.enum(['pr', 'merge']);
export type CompletionAction = z.infer<typeof CompletionAction>;

/** Every completion action ever stored, including the retired `push_branch`. Events and responses use this. */
export const StoredCompletionAction = z.enum(['pr', 'push_branch', 'merge']);
export type StoredCompletionAction = z.infer<typeof StoredCompletionAction>;

/** A completion action, or `none`: an investigation-only card whose report lives in the vault ends without any git step. */
export const FinalizeAction = z.enum(['pr', 'merge', 'none']);
export type FinalizeAction = z.infer<typeof FinalizeAction>;

/** Like `FinalizeAction`, plus the retired `push_branch`: old `FinalizeRequested` / `CardFinalized` events. */
export const StoredFinalizeAction = z.enum(['pr', 'push_branch', 'merge', 'none']);
export type StoredFinalizeAction = z.infer<typeof StoredFinalizeAction>;

/**
 * What each completion action means, in the words of the UI and the docs. Two branches per repository: the **main
 * branch** (where pull requests go) and the **working branch** (where card work is integrated; may be the same).
 * The stored values are unchanged: `merge` is "commit and push to the working branch".
 */
export const COMPLETION_ACTION_LABELS: Record<
  StoredCompletionAction,
  { label: string; description: string }
> = {
  merge: {
    label: 'Commit and push to the working branch',
    description:
      'No pull request. The card branch is merged into the working branch and the working branch is pushed. A missing working branch is created from the main branch first.',
  },
  pr: {
    label: 'Pull request',
    description:
      'The card branch is pushed and a pull request is opened for review into the working branch (the main branch when you use one branch). Pull requests from the working branch to the main branch are opened from the project settings.',
  },
  push_branch: {
    label: 'Push the card branch only (retired)',
    description:
      'No longer offered: a card branch is only pushed for a pull request. Cards that finished this way keep the label.',
  },
};

export const RiskTier = z.enum(['small', 'large']);
export type RiskTier = z.infer<typeof RiskTier>;

export const DecisionPolicy = z.enum(['owner_only', 'any_manager']);
export type DecisionPolicy = z.infer<typeof DecisionPolicy>;

export const CardOrigin = z.enum([
  'manual',
  'intake',
  'schedule',
  'test_failure',
  'full_suite',
  'regression',
  'interest',
  /** Started by a `subworkflow` stage of a parent card. */
  'subworkflow',
  /** Started by an automation trigger (a card stage, an intake ticket, ...). */
  'trigger',
  /** Started by an inbound e-mail. */
  'email',
]);
export type CardOrigin = z.infer<typeof CardOrigin>;

export const ReworkReason = z.enum([
  'missed_requirement',
  'broke_convention',
  'weak_tests',
  'poor_structure',
  'spec_unclear',
  'out_of_scope_test_change',
  /** A likely break of existing behaviour outside the card. */
  'regression_risk',
]);
export type ReworkReason = z.infer<typeof ReworkReason>;

export const DiffStats = z.object({
  files: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  architecturalPaths: z.array(z.string()).default([]),
  /** M9: how many of the changed files are test files (null/absent when the runner does not report it). */
  testFiles: z.number().int().nonnegative().optional(),
});
export type DiffStats = z.infer<typeof DiffStats>;

export const ClaimReleaseReason = z.enum([
  'handoff',
  'question',
  'agent_retired',
  'lease_expired',
  'runner_rejected',
  'runner_lost_shift',
  'shift_failed',
  'manual',
  'workstation_unlinked',
  'member_removed',
  'org_cancelled',
]);
export type ClaimReleaseReason = z.infer<typeof ClaimReleaseReason>;

export const ThreadMessageKind = z.enum([
  'comment',
  'question',
  'answer',
  'handoff',
  'review',
  'evidence',
  'chat',
  'system',
]);
export type ThreadMessageKind = z.infer<typeof ThreadMessageKind>;

export const TestEvidence = z.object({
  commands: z.array(z.string()).default([]),
  summary: z.string(),
  outputExcerpt: z.string().default(''),
  /** `aom test fail --title`: the bug title (failures only). */
  title: z.string().optional(),
});
export type TestEvidence = z.infer<typeof TestEvidence>;

/** The reviewer's overall risk of the change (`aom review --risk`). `unknown`: an older runner reported none. */
export const ReviewRisk = z.enum(['low', 'medium', 'high']);
export type ReviewRisk = z.infer<typeof ReviewRisk>;
export const StoredReviewRisk = z.enum(['low', 'medium', 'high', 'unknown']);
export type StoredReviewRisk = z.infer<typeof StoredReviewRisk>;
/** Size caps of the reviewer's risk text. */
export const RISK_ANALYSIS_MAX = 20000;
export const QA_FOCUS_MAX = 2000;

export const ReviewData = z.object({
  score: z.number().int().min(1).max(5),
  reasons: z.array(ReworkReason).optional(),
  criteriaMissed: z.array(z.string()).optional(),
  /** Absent from an older runner: the server stores `unknown`. */
  risk: ReviewRisk.optional(),
  riskAnalysis: z.string().max(RISK_ANALYSIS_MAX).optional(),
  qaFocus: z.string().max(QA_FOCUS_MAX).optional(),
});
export type ReviewData = z.infer<typeof ReviewData>;

/**
 * The priority of a card nobody prioritised (the API stays numeric, 1 = most urgent … 9). The labels in the UI are
 * Urgent 1, High 3, Normal 5, Low 8; before 2026-10 the default was 2, which now reads as Urgent, so it moved to 5.
 */
export const DEFAULT_CARD_PRIORITY = 5;
/** The old default: a `CardCreated` carrying it was never a conscious choice, so the projection reads it as the new default. */
export const LEGACY_DEFAULT_CARD_PRIORITY = 2;
