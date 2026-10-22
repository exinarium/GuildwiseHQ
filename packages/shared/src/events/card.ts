import { z } from 'zod';
import { StoredBuildEvidenceSchema } from '../cards/lean-v6.ts';
import {
  CardOrigin,
  CardStatus,
  CardType,
  ClaimReleaseReason,
  DEFAULT_CARD_PRIORITY,
  DecisionPolicy,
  DiffStats,
  ReworkReason,
  RiskTier,
  StoredCompletionAction,
  StoredFinalizeAction,
  StoredReviewRisk,
  TestEvidence,
  ThreadMessageKind,
} from '../cards/types.ts';
import { AccountKeySchema } from '../claude/accounts.ts';
import { defineEvent, Id, Note, Stage } from './define.ts';

const Fields = z.record(z.string(), z.unknown());

export const CardChangesSchema = z
  .object({
    title: z.string().min(1).max(300),
    fields: Fields,
    priority: z.number().int().min(1).max(9),
    repoId: Id.nullable(),
    docsNeeded: z.boolean(),
    completionAction: StoredCompletionAction.nullable(),
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
      /**
       * `2` on every event written since priorities got labels (Urgent 1, High 3, Normal 5, Low 8): `priority` is taken as
       * written, a 2 included. Absent on older events, where a 2 was the old default and the projection reads it as 5.
       */
      priorityScale: z.literal(2).optional(),
      docsNeeded: z.boolean().default(false),
      /** Run the investigate & design stage before build (default: the project's design step setting). */
      designNeeded: z.boolean().default(false),
      /** The card only investigates and ends in Finalize with a recorded result; implies `designNeeded`. */
      investigationOnly: z.boolean().default(false),
      /** Merge the latest main branch before work starts: null/absent follows the project setting. */
      mergeMainFirst: z.boolean().nullable().optional(),
      completionAction: StoredCompletionAction.optional(),
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
      /** The Claude account the shift runs on; absent = main. */
      accountKey: AccountKeySchema.optional(),
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
  /** The card was taken from one agent and is preferred for another (release plus prefer). */
  defineEvent(
    'CardReassigned',
    z.object({
      cardId: Id,
      fromAgentId: Id.optional(),
      toAgentId: Id,
      by: Id.optional(),
      viaCeo: z.boolean().default(false),
    }),
  ),
  /**
   * A per-card model override: the card's next shifts run on this model and effort instead of the agent's own (the CEO
   * raises it when a card keeps failing for real reasons). Additive: cards without it run as before.
   */
  defineEvent(
    'CardModelRaised',
    z.object({
      cardId: Id,
      model: z.string().min(1).max(120),
      effort: z.string().min(1).max(20).optional(),
      runtime: z.string().min(1).max(60).optional(),
      by: Id.optional(),
      reason: z.string().max(2000).optional(),
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
      /** lean team: the commit the runner measured after the shift's autocommit, and the build evidence bound to it. */
      headSha: z.string().min(7).max(64).optional(),
      evidence: StoredBuildEvidenceSchema.optional(),
      /** lean team: computed by the server from the paths of the diff (auth, data and migrations, tenancy and billing). */
      highRisk: z.boolean().optional(),
      highRiskPaths: z.array(z.string().max(500)).max(50).optional(),
    }),
  ),
  defineEvent(
    'ChangesRequested',
    z.object({
      cardId: Id,
      /** `pre_review` (lean team): the Sonnet pre-review sent the card back; the cap counts only Opus review rounds. */
      fromStage: z.enum(['review', 'pre_review', 'merge_review']),
      toStage: z.literal('build'),
      reviewerAgentId: Id,
      reasons: z.array(ReworkReason),
      score: z.number().int().min(1).max(5),
      criteriaMissed: z.array(z.string()),
      comments: z.string(),
      /** The reviewer's risk call (absent in events from before backlog #70 and from an older runner: `unknown`). */
      risk: StoredReviewRisk.optional(),
      riskAnalysis: z.string().optional(),
      qaFocus: z.string().optional(),
    }),
  ),
  defineEvent(
    'ReviewApproved',
    z.object({
      cardId: Id,
      reviewerAgentId: Id,
      score: z.number().int().min(1).max(5),
      comments: z.string(),
      /** The reviewer's risk call (absent in events from before backlog #70 and from an older runner: `unknown`). */
      risk: StoredReviewRisk.optional(),
      riskAnalysis: z.string().optional(),
      qaFocus: z.string().optional(),
      approvalsSoFar: z.number().int().min(1),
      approvalsRequired: z.number().int().min(1),
      /** `review` while more approvals are due, else the next stage (`test`, or a step a project variant inserted). */
      toStage: Stage,
      /**
       * A card pinned to an older built-in `code` version moves to this newer one when it leaves Review (it has the
       * `test` guard and environment), with `integrationTests` set from the project's setting at that moment.
       */
      workflowVersionId: Id.optional(),
      integrationTests: z.boolean().optional(),
      /**
       * lean team: false when the second approval of a high-risk card may come from the same reviewer because no other
       * reviewer is hired (default: the reviewer is not offered the card again).
       */
      excludeReviewer: z.boolean().optional(),
      /** lean team: the owner approval decision of the last review approval, recorded with its reason. */
      ownerApproval: z
        .object({
          required: z.boolean(),
          reason: z.enum([
            'high_risk',
            'reviewer_high_risk',
            'large',
            'policy_always',
            'waived_large',
            'auto_small',
          ]),
        })
        .optional(),
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
  /**
   * A test failure whose cause is the E2E spec or its fixtures (`failureScope: 'e2e_spec'`): no bug card is created,
   * the card stays in Test and is queued for the tester again. Replay-safe: a plain status change.
   */
  defineEvent(
    'TestReworkRequested',
    z.object({ cardId: Id, testerAgentId: Id, evidence: TestEvidence, summary: z.string() }),
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
    z.object({
      cardId: Id,
      fromStage: Stage,
      toStage: Stage,
      status: CardStatus,
      reason: z.string(),
      /**
       * Set by moves that dismiss the card's open blockers themselves (`moveCard`): the projection then clears
       * `blocked_since` and every blocker row. Events without it keep the older rule (kept and loop-parked blockers,
       * only when the new status is queued).
       */
      clearsBlockers: z.boolean().optional(),
    }),
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
      /** The episode reached `LOOP_PARK_FAILURES`: the card is parked on a blocking desk item (signal for bug intake). */
      parked: z.boolean().optional(),
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
      action: StoredFinalizeAction,
      requestedBy: Id,
      /** A large-tier merge that skipped the desk approval because the project setting allows it. */
      withoutApproval: z.boolean().optional(),
    }),
  ),
  defineEvent(
    'CardFinalized',
    z.object({
      cardId: Id,
      action: StoredFinalizeAction,
      resultRef: z.object({
        mergeCommit: z.string().optional(),
        prUrl: z.string().optional(),
        pushedBranch: z.string().optional(),
      }),
      /** `done`, or the first manual QA stage when the project has manual QA on (docs/design/manual-qa.md). */
      toStage: z.enum(['done', 'qa_steps', 'manual_qa']),
      /** A card pinned to an older built-in version moves to this one when it enters manual QA (same stages up to Finalize). */
      workflowVersionId: Id.optional(),
    }),
  ),
  /**
   * `cause: 'project_archived'` marks a card closed because its project was archived (not cancelled by hand); `'split'` a
   * draft that was replaced by the cards in `childCardIds` (repository scoping: one card per repository or section).
   */
  defineEvent(
    'CardCancelled',
    z.object({
      cardId: Id,
      reason: z.string(),
      cause: z.enum(['project_archived', 'project_converted', 'split']).optional(),
      childCardIds: z.array(Id).optional(),
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
      /** A `repo` report written before the card branch existed: the text the builder commits at `reportPath`. */
      body: z.string().optional(),
      /** Assumptions about unlanded dependencies (a design made before they landed). */
      assumptions: z
        .array(z.object({ assumption: z.string(), dependency: z.string(), ifWrong: z.string() }))
        .optional(),
      /** The card only investigated (no build follows). */
      investigationOnly: z.boolean().default(false),
    }),
  ),
  /**
   * A design made before the card's dependencies landed is recorded: the card stays in the design stage until they
   * land, then the architect reviews the assumptions (backlog #80).
   */
  defineEvent(
    'DesignHeld',
    z.object({ cardId: Id, dependencies: z.array(z.string()), agentId: Id.optional() }),
  ),
  /**
   * Repair (boot data migration `design-held-status-2026-10`): a card whose design is held but whose projected status
   * still says `queued` (held before the `held` status existed) takes the `held` status. Idempotent in the projection.
   */
  defineEvent('DesignHoldConfirmed', z.object({ cardId: Id })),
  /** The assumption review is done: confirmed as they were, or the design revised; the card goes on to Build. */
  defineEvent(
    'DesignReviewed',
    z.object({
      cardId: Id,
      decision: z.enum(['confirm', 'revise']),
      confirmed: z.number().int().nonnegative(),
      revised: z.number().int().nonnegative(),
      note: z.string().default(''),
      agentId: Id.optional(),
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
