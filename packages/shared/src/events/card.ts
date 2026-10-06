import { z } from 'zod';
import {
  CardOrigin,
  CardStatus,
  CardType,
  ClaimReleaseReason,
  CompletionAction,
  DecisionPolicy,
  DiffStats,
  ReworkReason,
  RiskTier,
  TestEvidence,
  ThreadMessageKind,
} from '../cards/types.ts';
import { defineEvent, Id, Note, Stage } from './define.ts';

const Fields = z.record(z.string(), z.unknown());

export const CardChangesSchema = z
  .object({
    title: z.string().min(1).max(300),
    fields: Fields,
    priority: z.number().int().min(1).max(9),
    repoId: Id.nullable(),
    docsNeeded: z.boolean(),
    completionAction: CompletionAction.nullable(),
    riskTier: RiskTier.nullable(),
    riskTierOverridden: z.boolean(),
    dependencies: z.array(Id),
    ownerUserId: Id,
  })
  .partial();
export type CardChanges = z.infer<typeof CardChangesSchema>;

export const cardEvents = [
  defineEvent(
    'CardCreated',
    z.object({
      cardId: Id,
      projectId: Id,
      number: z.number().int().positive(),
      ref: z.string().min(1),
      title: z.string().min(1).max(300),
      cardType: CardType,
      workflowVersionId: Id,
      stage: Stage,
      status: z.enum(['draft', 'queued']),
      fields: Fields,
      ownerUserId: Id,
      origin: CardOrigin,
      parentCardId: Id.optional(),
      worktreeCardId: Id.optional(),
      scheduled: z.boolean().default(false),
      scheduleId: Id.optional(),
      /** The interest this card belongs to (a scan of its schedule, or "Research this"). */
      interestId: Id.optional(),
      repoId: Id.optional(),
      priority: z.number().int().min(1).max(9).default(2),
      docsNeeded: z.boolean().default(false),
      completionAction: CompletionAction.optional(),
      riskTier: RiskTier.optional(),
      dependencies: z.array(Id).default([]),
      requiredCapabilities: z.array(z.string()).default([]),
      /** A regression card of a phase follow-up runs where the local stack was deployed. */
      homeWorkstationId: Id.optional(),
      /** Set on the regression cards a phase follow-up created (never phase members). */
      phaseFollowupId: Id.optional(),
    }),
  ),
  defineEvent(
    'CardUpdated',
    z.object({
      cardId: Id,
      changes: CardChangesSchema,
      /** Why the risk tier was overridden (set with `changes.riskTier`). */
      reason: z.string().optional(),
    }),
  ),
  defineEvent('CardSpecified', z.object({ cardId: Id, fromStage: Stage, toStage: Stage })),
  defineEvent('DecisionPolicyChanged', z.object({ cardId: Id, policy: DecisionPolicy })),
  defineEvent(
    'CardClaimed',
    z.object({
      cardId: Id,
      claimId: Id,
      agentId: Id,
      workstationId: Id,
      shiftId: Id,
      stage: Stage,
      overflow: z.boolean(),
      worktree: z
        .object({
          repoId: Id,
          baseBranch: z.string(),
          branchName: z.string(),
          worktreePath: z.string(),
          homeWorkstationId: Id,
          created: z.boolean(),
        })
        .nullable(),
    }),
  ),
  defineEvent(
    'ClaimReleased',
    z.object({
      cardId: Id,
      claimId: Id,
      agentId: Id,
      reason: ClaimReleaseReason,
      lastHandoffId: Id.optional(),
    }),
  ),
  defineEvent(
    'HandoffWritten',
    z.object({
      cardId: Id,
      handoffId: Id,
      shiftId: Id,
      agentId: Id,
      stage: Stage,
      outcome: z.string().min(1),
      note: Note,
      data: z.record(z.string(), z.unknown()).default({}),
    }),
  ),
  defineEvent(
    'ReviewRequested',
    z.object({
      cardId: Id,
      fromStage: z.literal('build'),
      toStage: z.literal('review'),
      riskTier: RiskTier,
      diffStats: DiffStats,
    }),
  ),
  defineEvent(
    'ChangesRequested',
    z.object({
      cardId: Id,
      fromStage: z.literal('review'),
      toStage: z.literal('build'),
      reviewerAgentId: Id,
      reasons: z.array(ReworkReason),
      score: z.number().int().min(1).max(5),
      criteriaMissed: z.array(z.string()),
      comments: z.string(),
    }),
  ),
  defineEvent(
    'ReviewApproved',
    z.object({
      cardId: Id,
      reviewerAgentId: Id,
      score: z.number().int().min(1).max(5),
      comments: z.string(),
      approvalsSoFar: z.number().int().min(1),
      approvalsRequired: z.number().int().min(1),
      toStage: z.enum(['review', 'test']),
    }),
  ),
  defineEvent(
    'TestPassed',
    z.object({
      cardId: Id,
      testerAgentId: Id,
      evidence: TestEvidence,
      toStage: z.enum(['docs', 'finalize']),
    }),
  ),
  defineEvent(
    'TestFailed',
    z.object({ cardId: Id, testerAgentId: Id, bugCardId: Id, evidence: TestEvidence, summary: z.string() }),
  ),
  defineEvent('ChildCardResolved', z.object({ cardId: Id, childCardId: Id, toStage: z.literal('test') })),
  defineEvent(
    'RebaseConflict',
    z.object({ cardId: Id, stage: Stage, baseBranch: z.string(), conflictedFiles: z.array(z.string()) }),
  ),
  defineEvent(
    'StageCompleted',
    z.object({
      cardId: Id,
      fromStage: Stage,
      toStage: Stage,
      outcome: z.string(),
      /** The outcome sends the card back for rework (research fact-check failure): increments the rework round. */
      rework: z.boolean().optional(),
    }),
  ),
  defineEvent(
    'CardMovedByManager',
    z.object({ cardId: Id, fromStage: Stage, toStage: Stage, status: CardStatus, reason: z.string() }),
  ),
  defineEvent(
    'CardRetryDeferred',
    z.object({
      cardId: Id,
      /** The card is not dispatched again before this time. */
      until: z.string(),
      /** Failed shifts of the episode so far. */
      failures: z.number().int().positive(),
      episodeId: Id,
      /** First back-off of the episode: the desk alert is raised with it. */
      newEpisode: z.boolean(),
    }),
  ),
  defineEvent(
    'CardRetryReleased',
    z.object({ cardId: Id, episodeId: Id, releasedBy: Id, reason: z.string().optional() }),
  ),
  defineEvent(
    'FinalizeRequested',
    z.object({
      cardId: Id,
      action: CompletionAction,
      requestedBy: Id,
      /** A large-tier merge that skipped the desk approval because the project setting allows it. */
      withoutApproval: z.boolean().optional(),
    }),
  ),
  defineEvent(
    'CardFinalized',
    z.object({
      cardId: Id,
      action: CompletionAction,
      resultRef: z.object({
        mergeCommit: z.string().optional(),
        prUrl: z.string().optional(),
        pushedBranch: z.string().optional(),
      }),
      toStage: z.literal('done'),
    }),
  ),
  /** `cause: 'project_archived'` marks a card closed because its project was archived (not cancelled by hand). */
  defineEvent(
    'CardCancelled',
    z.object({ cardId: Id, reason: z.string(), cause: z.enum(['project_archived']).optional() }),
  ),
  defineEvent(
    'ThreadMessagePosted',
    z.object({
      threadId: Id,
      messageId: Id,
      cardId: Id.optional(),
      authorKind: z.enum(['user', 'agent', 'system']),
      authorUserId: Id.optional(),
      authorAgentId: Id.optional(),
      kind: ThreadMessageKind,
      body: z.string(),
      data: z.record(z.string(), z.unknown()).default({}),
    }),
  ),
] as const;
