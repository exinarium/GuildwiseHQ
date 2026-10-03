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

export const CardStatus = z.enum(['draft', 'queued', 'claimed', 'blocked', 'waiting', 'done', 'cancelled']);
export type CardStatus = z.infer<typeof CardStatus>;

export const CompletionAction = z.enum(['pr', 'push_branch', 'merge']);
export type CompletionAction = z.infer<typeof CompletionAction>;

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
]);
export type CardOrigin = z.infer<typeof CardOrigin>;

export const ReworkReason = z.enum([
  'missed_requirement',
  'broke_convention',
  'weak_tests',
  'poor_structure',
  'spec_unclear',
  'out_of_scope_test_change',
]);
export type ReworkReason = z.infer<typeof ReworkReason>;

export const DiffStats = z.object({
  files: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  architecturalPaths: z.array(z.string()).default([]),
  outOfScopeTestChange: z.boolean().optional(),
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

export const ReviewData = z.object({
  score: z.number().int().min(1).max(5),
  reasons: z.array(ReworkReason).optional(),
  criteriaMissed: z.array(z.string()).optional(),
});
export type ReviewData = z.infer<typeof ReviewData>;
