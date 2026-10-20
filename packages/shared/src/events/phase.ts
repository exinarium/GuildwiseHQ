import { z } from 'zod';
import { AccountKeySchema } from '../claude/accounts.ts';
import {
  BaTaskKind,
  BaTaskStatus,
  DeployTargetKind,
  FollowupDelegate,
  FollowupListWithIdSchema,
  PhaseAssignment,
  PhaseCardOutcome,
  PhaseOutstandingSchema,
} from '../phases/index.ts';
import { defineEvent, Id } from './define.ts';
import { DeskActorSchema } from './desk.ts';

const Name = z.string().trim().min(1).max(120);
/** Phases are created by a member or by the BA (never by the system). */
const Creator = DeskActorSchema.extend({ kind: z.enum(['user', 'agent']) });
const Text = z.string().max(40000);

/**
 * Phase events (docs/design/phases.md A4). Streams: `phase-<id>`, `ba-task-<id>`, `project-<id>` (deploy targets,
 * default follow-ups) and `card-<id>` (`CardPhaseChanged`, `CardMergeVerified`). Audience `project`.
 */
export const phaseEvents = [
  defineEvent(
    'PhaseCreated',
    z.object({
      phaseId: Id,
      projectId: Id,
      number: z.number().int().positive(),
      ref: z.string().min(1),
      name: Name,
      description: z.string().max(4000).default(''),
      status: z.enum(['proposed', 'open']),
      createdBy: Creator,
      intakeId: Id.optional(),
      /** Set when the phase deploys from a branch other than the project's working branch. */
      workingBranch: z.string().min(1).optional(),
      followups: FollowupListWithIdSchema.default([]),
    }),
  ),
  defineEvent(
    'PhaseUpdated',
    z.object({
      phaseId: Id,
      changes: z.object({
        name: Name.optional(),
        description: z.string().max(4000).optional(),
        workingBranch: z.string().min(1).nullable().optional(),
      }),
      by: DeskActorSchema,
    }),
  ),
  /** Replaces the phase's follow-up list (editable states only; follow-up ids are kept by the caller). */
  defineEvent(
    'PhaseFollowupsSet',
    z.object({ phaseId: Id, followups: FollowupListWithIdSchema, by: DeskActorSchema }),
  ),
  /** A card joined, moved between or left phases (`phaseId: null`). On the card's stream. */
  defineEvent(
    'CardPhaseChanged',
    z.object({
      cardId: Id,
      phaseId: Id.nullable(),
      previousPhaseId: Id.optional(),
      assignment: PhaseAssignment.nullable(),
      by: DeskActorSchema,
      /** `bug_filed`: a bug card filed after finalize joined the phase of the card (or follow-up) it came from. */
      cause: z.enum(['bug_filed']).optional(),
    }),
  ),
  /**
   * The card's work is in the phase's working branch. For `pr` / `push_branch` the runner checked it with git (the
   * card branch's head is an ancestor of the working branch), or a member confirmed it by hand (`manual`).
   */
  defineEvent(
    'CardMergeVerified',
    z.object({
      cardId: Id,
      workingBranch: z.string().min(1),
      branchName: z.string().optional(),
      branchDeleted: z.boolean().default(false),
      remoteBranchDeleted: z.boolean().default(false),
      manual: z.boolean().default(false),
      by: DeskActorSchema.optional(),
    }),
  ),
  defineEvent(
    'PhaseProposalSubmitted',
    z.object({
      phaseId: Id,
      deskItemId: Id,
      proposedCardIds: z.array(Id),
      newPhase: z.boolean(),
    }),
  ),
  defineEvent(
    'PhaseConfirmed',
    z.object({ phaseId: Id, by: DeskActorSchema, confirmedCardIds: z.array(Id) }),
  ),
  defineEvent(
    'PhaseProposalRejected',
    z.object({
      phaseId: Id,
      by: DeskActorSchema,
      reason: z.string().optional(),
      clearedCardIds: z.array(Id),
      discard: z.boolean(),
    }),
  ),
  defineEvent(
    'PhaseCompleted',
    z.object({ phaseId: Id, cardOutcomes: z.array(PhaseCardOutcome), baTaskId: Id }),
  ),
  defineEvent(
    'PhaseReportPosted',
    z.object({
      phaseId: Id,
      deskItemId: Id,
      report: Text,
      outstanding: z.array(PhaseOutstandingSchema).default([]),
      by: DeskActorSchema,
    }),
  ),
  defineEvent('PhaseReopened', z.object({ phaseId: Id, by: DeskActorSchema, reason: z.string().max(2000) })),
  defineEvent(
    'PhaseFollowupsApproved',
    z.object({
      phaseId: Id,
      by: DeskActorSchema,
      deskItemId: Id.optional(),
      followups: FollowupListWithIdSchema,
      baTaskId: Id.optional(),
    }),
  ),
  defineEvent(
    'PhaseFollowupsRejected',
    z.object({ phaseId: Id, by: DeskActorSchema, deskItemId: Id.optional(), note: z.string().optional() }),
  ),
  defineEvent(
    'PhaseFollowupBriefed',
    z.object({
      phaseId: Id,
      followupId: Id,
      delegate: FollowupDelegate,
      brief: z.string().min(1).max(20000),
      by: DeskActorSchema,
    }),
  ),
  defineEvent(
    'PhaseFollowupStarted',
    z.object({
      phaseId: Id,
      followupId: Id,
      delegate: FollowupDelegate,
      /** A deploy to the local stack fans out: one DevOps request per workstation of every project member. */
      devopsRequestIds: z.array(Id).default([]),
      regressionCardIds: z.array(Id).default([]),
      baTaskId: Id.optional(),
      /** Workstations that were offline when a local deploy started: skipped and listed in the results. */
      skippedOffline: z.array(z.object({ id: Id, name: z.string(), owner: z.string() })).optional(),
    }),
  ),
  defineEvent(
    'PhaseFollowupFinished',
    z.object({
      phaseId: Id,
      followupId: Id,
      status: z.enum(['succeeded', 'failed', 'skipped', 'cancelled']),
      summary: z.string().max(20000),
      evidence: z.record(z.string(), z.unknown()).default({}),
    }),
  ),
  defineEvent(
    'PhaseFollowupsFinished',
    z.object({ phaseId: Id, status: z.enum(['done', 'done_with_failures']), baTaskId: Id.optional() }),
  ),
  defineEvent(
    'PhaseResultsReported',
    z.object({
      phaseId: Id,
      deskItemId: Id,
      report: Text,
      finalStatus: z.enum(['done', 'done_with_failures']),
      by: DeskActorSchema,
    }),
  ),
  /** The project was archived: the phase and its pending follow-ups are cancelled. */
  defineEvent('PhaseCancelled', z.object({ phaseId: Id, reason: z.string().max(2000) })),
  defineEvent(
    'ProjectFollowupDefaultsSet',
    z.object({ projectId: Id, followups: FollowupListWithIdSchema, changedBy: Id }),
  ),
  defineEvent(
    'DeployTargetAdded',
    z.object({
      targetId: Id,
      projectId: Id,
      name: Name,
      kind: DeployTargetKind,
      /** `remote_ssh`: whose DevOps engineer deploys. `local_docker` fans out to every workstation: null. */
      workstationId: Id.nullable(),
      host: z.string().optional(),
      appUrl: z.string().optional(),
      notes: z.string().max(4000).default(''),
      createdBy: Id,
      /** The tester may test this target (backlog #59, phase 4); a production target never. */
      testEnabled: z.boolean().optional(),
      production: z.boolean().optional(),
      destructiveOk: z.boolean().optional(),
      testHosts: z.array(z.string()).optional(),
      secretNames: z.array(z.string()).optional(),
    }),
  ),
  defineEvent(
    'DeployTargetUpdated',
    z.object({
      targetId: Id,
      changes: z.object({
        name: Name.optional(),
        kind: DeployTargetKind.optional(),
        workstationId: Id.nullable().optional(),
        host: z.string().nullable().optional(),
        appUrl: z.string().nullable().optional(),
        notes: z.string().max(4000).optional(),
        testEnabled: z.boolean().optional(),
        production: z.boolean().optional(),
        destructiveOk: z.boolean().optional(),
        testHosts: z.array(z.string()).optional(),
        secretNames: z.array(z.string()).optional(),
      }),
    }),
  ),
  defineEvent('DeployTargetRemoved', z.object({ targetId: Id })),
  defineEvent(
    'BaTaskQueued',
    z.object({
      taskId: Id,
      projectId: Id.optional(),
      phaseId: Id.optional(),
      followupId: Id.optional(),
      kind: BaTaskKind,
      preferredAgentId: Id.optional(),
      /** Part B reporter tasks: the signals / held or urgent desk items they cover, and the floor report's local date. */
      signalIds: z.array(Id).optional(),
      deskItemIds: z.array(Id).optional(),
      localDate: z.string().optional(),
      /** `scheduled_brief` (a schedule's BA task): what to do, where the answer goes, and which schedule asked. */
      instructions: z.string().max(2000).optional(),
      deliver: z.enum(['desk_notice', 'chat']).optional(),
      scheduleId: Id.optional(),
      scheduleName: z.string().max(120).optional(),
      /** The task is for the whole organization (any BA may take it); its project is only the carrier it is filed under. */
      orgLevel: z.boolean().optional(),
      /** `batch_intake`: the batch and the item this task works on. */
      batchId: Id.optional(),
      batchItemId: Id.optional(),
      /** `mail_reply_draft`: the draft request this task writes. */
      mailDraftId: Id.optional(),
      /** `spec_card`: the draft card whose missing fields the BA writes. */
      cardId: Id.optional(),
    }),
  ),
  /** A `ba_task` shift was dispatched to the runner (creates the shift row). */
  defineEvent(
    'BaTaskDispatched',
    z.object({
      taskId: Id,
      shiftId: Id,
      agentId: Id,
      workstationId: Id,
      /** The Claude account the shift runs on; absent = main. */
      accountKey: AccountKeySchema.optional(),
    }),
  ),
  /** `attempt`: the shift failed (crash, timeout, no report) and counts toward the retry limit. */
  defineEvent(
    'BaTaskRequeued',
    z.object({ taskId: Id, reason: z.string(), attempt: z.boolean().default(false) }),
  ),
  defineEvent(
    'BaTaskCompleted',
    z.object({
      taskId: Id,
      status: BaTaskStatus.exclude(['queued', 'running']),
      note: z.string().optional(),
    }),
  ),
] as const;
