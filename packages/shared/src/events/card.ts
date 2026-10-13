import { z } from 'zod';
import {
  CardOrigin,
  CardStatus,
  CardType,
  ClaimReleaseReason,
  CompletionAction,
  DEFAULT_CARD_PRIORITY,
  DecisionPolicy,
  DiffStats,
  FinalizeAction,
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
    /** Run the investigate & design stage (architect) before build. */
    designNeeded: z.boolean(),
    /** The card only investigates (investigate -> finalize, no build). */
    investigationOnly: z.boolean(),
    /** Merge the latest main branch first: true/false overrides the project setting, null follows it. */
    mergeMainFirst: z.boolean().nullable(),
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
      /** The run of that interest this card is (an `InterestRunStarted` is appended with it). */
      interestRunId: Id.optional(),
      /** The interest's preferred agents by workflow role: a soft preference, never a claim window. */
      preferredAgents: z.record(z.string(), Id).optional(),
      repoId: Id.optional(),
      priority: z.number().int().min(1).max(9).default(DEFAULT_CARD_PRIORITY),
      docsNeeded: z.boolean().default(false),
      /** Run the investigate & design stage before build (default: the project's design step setting). */
      designNeeded: z.boolean().default(false),
      /** The card only investigates and ends in Finalize with a recorded result; implies `designNeeded`. */
      investigationOnly: z.boolean().default(false),
      /** Merge the latest main branch before work starts: null/absent follows the project setting. */
      mergeMainFirst: z.boolean().nullable().optional(),
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
      /** `runner_rejected`: why the runner refused the shift, for the board's workability warning. */
      rejection: z
        .object({
          reason: z.string(),
          /** The runner's detail, readable on its own ("working branch 'main' does not exist in Barcode Camera ..."). */
          detail: z.string(),
          /** `branch`: the cause is the repository's working branch (fixed in project settings). */
          kind: z.enum(['branch']).optional(),
          repoId: Id.optional(),
        })
        .optional(),
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
      /** `review`; the stage a project variant inserted after build when there is one (docs/design/architect-and-workflows.md 4.2). */
      toStage: Stage,
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
      /** `review` while more approvals are due, else the next stage (`test`, or a step a project variant inserted). */
      toStage: Stage,
    }),
  ),
  defineEvent(
    'TestPassed',
    z.object({
      cardId: Id,
      testerAgentId: Id,
      evidence: TestEvidence,
      /** `docs` or `finalize`, or a step a project variant inserted after test. */
      toStage: Stage,
    }),
  ),
  defineEvent(
    'TestFailed',
    z.object({ cardId: Id, testerAgentId: Id, bugCardId: Id, evidence: TestEvidence, summary: z.string() }),
  ),
  defineEvent('ChildCardResolved', z.object({ cardId: Id, childCardId: Id, toStage: z.literal('test') })),
  /**
   * A `subworkflow` stage started a child card (docs/design/workflow-builder.md section 4). Appended with the child's
   * `CardCreated{origin:'subworkflow', parentCardId: cardId}`. `workflowVersion` is the version the child is pinned to.
   */
  defineEvent(
    'SubworkflowStarted',
    z.object({
      cardId: Id,
      stageId: Stage,
      childCardId: Id,
      childProjectId: Id,
      workflowKey: z.string().min(1),
      workflowVersion: z.number().int().min(1),
      mode: z.enum(['wait', 'continue']),
      /** Rework round of the parent when the stage was entered: part of the dedupe key (parent, stage, round). */
      reworkRound: z.number().int().min(0).default(0),
    }),
  ),
  /**
   * A card moved back into a `subworkflow` stage whose earlier child is still open: it waits on that child again
   * instead of starting a second one (no new run row).
   */
  defineEvent(
    'SubworkflowAttached',
    z.object({
      cardId: Id,
      stageId: Stage,
      childCardId: Id,
      reworkRound: z.number().int().min(0).default(0),
    }),
  ),
  /** The child of a waiting `subworkflow` stage ended: the parent takes its `done` or `failed` outcome. */
  defineEvent(
    'SubworkflowResolved',
    z.object({
      cardId: Id,
      stageId: Stage,
      childCardId: Id,
      result: z.enum(['done', 'cancelled']),
      /** Parent field values copied back from the child (`fieldsOut`), applied with this event. */
      fields: Fields.default({}),
    }),
  ),
  /** The server declined to start a sub-workflow (a desk notice is raised). */
  defineEvent(
    'SubworkflowRefused',
    z.object({
      cardId: Id,
      stageId: Stage,
      workflowKey: z.string().min(1),
      reason: z.enum([
        'depth',
        'cycle',
        'not_found',
        'not_approved',
        'not_enabled',
        'not_member',
        'invalid_mapping',
      ]),
      detail: z.string().max(1000).default(''),
    }),
  ),
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
  /**
   * A done or cancelled card goes back to work by a manager. `fromStatus` is what it was (`done` / `cancelled`); the
   * branch, worktree and any earlier finalize result stay on the card.
   */
  defineEvent(
    'CardReopened',
    z.object({
      cardId: Id,
      fromStage: Stage,
      fromStatus: z.enum(['done', 'cancelled']),
      toStage: Stage,
      status: CardStatus,
      reason: z.string(),
      by: Id,
    }),
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
      action: FinalizeAction,
      requestedBy: Id,
      /** A large-tier merge that skipped the desk approval because the project setting allows it. */
      withoutApproval: z.boolean().optional(),
    }),
  ),
  defineEvent(
    'CardFinalized',
    z.object({
      cardId: Id,
      action: FinalizeAction,
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
    z.object({
      cardId: Id,
      reason: z.string(),
      cause: z.enum(['project_archived', 'project_converted']).optional(),
    }),
  ),
  /**
   * The architect's report (investigation or design) was recorded with the outcome of the investigate stage. `location`
   * `repo`: `reportPath` is a file on the card branch (`commit`); `vault`: it is a path in the project vault.
   */
  defineEvent(
    'InvestigationReported',
    z.object({
      cardId: Id,
      reportPath: z.string().min(1),
      location: z.enum(['repo', 'vault']),
      summary: z.string(),
      commit: z.string().optional(),
      /** The card only investigated (no build follows). */
      investigationOnly: z.boolean().default(false),
    }),
  ),
  /**
   * The runner merged the latest main branch before the card's worktree was created (`mergeMainFirst`): into the working
   * branch, into the card branch, left as a conflict for the architect, or skipped because it conflicted.
   */
  defineEvent(
    'CardMainSynced',
    z.object({
      cardId: Id,
      repoId: Id,
      result: z.enum(['merged_into_working', 'merged_into_card', 'conflict_in_card', 'skipped_conflict']),
      mainBranch: z.string().optional(),
      workingBranch: z.string().optional(),
      commit: z.string().optional(),
      files: z.array(z.string()).optional(),
    }),
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
  /** A file was attached to the card. Metadata only: the bytes live in `card_attachment_data`, never in the event log. */
  defineEvent(
    'CardAttachmentAdded',
    z.object({
      cardId: Id,
      attachmentId: Id,
      name: z.string().min(1).max(300),
      contentType: z.string().min(1).max(200),
      size: z.number().int().positive(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      /** Where it came from, e.g. `jira DCPL-4276`; absent: uploaded by hand. */
      source: z.string().max(200).optional(),
    }),
  ),
  defineEvent(
    'CardAttachmentRemoved',
    z.object({ cardId: Id, attachmentId: Id, name: z.string().min(1).max(300) }),
  ),
] as const;
