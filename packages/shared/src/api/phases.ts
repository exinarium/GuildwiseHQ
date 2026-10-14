import { z } from 'zod';
import { StoredCompletionAction } from '../cards/types.ts';
import {
  BaTaskKind,
  BaTaskStatus,
  DeployTargetKind,
  FollowupDelegate,
  FollowupKind,
  FollowupListSchema,
  FollowupStatus,
  PhaseAssignment,
  PhaseCardOutcome,
  PhaseOutstandingSchema,
  PhaseStatus,
} from '../phases/index.ts';
import { HttpUrlSchema } from '../safe.ts';
import { IsoTime } from './common.ts';
import { SpendBriefSchema } from './costs.ts';

// ------------------------------------------------------------------------------------- deploy targets

export const DeployTargetDtoSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  name: z.string(),
  kind: DeployTargetKind,
  /** `remote_ssh`: whose DevOps engineer deploys; `local_docker`: null (every project member's workstation deploys). */
  workstationId: z.uuid().nullable(),
  workstationName: z.string().nullable(),
  host: z.string().nullable(),
  appUrl: z.string().nullable(),
  notes: z.string(),
  createdAt: IsoTime,
});
export type DeployTargetDto = z.infer<typeof DeployTargetDtoSchema>;

/** An SSH host alias or `user@host`: no spaces, no leading `-`, no shell characters. */
export const SshHostSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._@:-]*$/, 'a host alias or user@host without spaces');

const DeployTargetBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: DeployTargetKind,
  workstationId: z.uuid().nullable().optional(),
  host: SshHostSchema.nullable().optional(),
  appUrl: HttpUrlSchema.nullable().optional(),
  notes: z.string().max(4000).default(''),
});
export const CreateDeployTargetRequestSchema = DeployTargetBodySchema;
export type CreateDeployTargetRequest = z.infer<typeof CreateDeployTargetRequestSchema>;
export const PatchDeployTargetRequestSchema = DeployTargetBodySchema.partial();
export type PatchDeployTargetRequest = z.infer<typeof PatchDeployTargetRequestSchema>;
export const DeployTargetsResponseSchema = z.object({ targets: z.array(DeployTargetDtoSchema) });
export type DeployTargetsResponse = z.infer<typeof DeployTargetsResponseSchema>;

/** A workstation of an active project member, as the remote deploy-target form lists it (no paths or hostnames). */
export const ProjectWorkstationSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  ownerId: z.uuid(),
  ownerName: z.string(),
  /** True when the workstation belongs to the viewer. */
  mine: z.boolean(),
  connected: z.boolean(),
  /** Has an active DevOps engineer: a deploy needs one. */
  hasDevops: z.boolean(),
});
export type ProjectWorkstation = z.infer<typeof ProjectWorkstationSchema>;
export const ProjectWorkstationsResponseSchema = z.object({
  workstations: z.array(ProjectWorkstationSchema),
});
export type ProjectWorkstationsResponse = z.infer<typeof ProjectWorkstationsResponseSchema>;

// -------------------------------------------------------------------------------------------- phases

export const PhaseRefDtoSchema = z.object({
  id: z.uuid(),
  ref: z.string(),
  name: z.string(),
  status: PhaseStatus,
  assignment: PhaseAssignment.optional(),
});
export type PhaseRefDto = z.infer<typeof PhaseRefDtoSchema>;

export const PhaseFollowupSummarySchema = z.object({
  id: z.uuid(),
  position: z.number().int(),
  kind: FollowupKind,
  label: z.string(),
  status: FollowupStatus,
});

export const PhaseSummaryDtoSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  number: z.number().int(),
  ref: z.string(),
  name: z.string(),
  description: z.string(),
  status: PhaseStatus,
  workingBranch: z.string().nullable(),
  createdBy: z.object({ kind: z.enum(['user', 'agent']), name: z.string().nullable() }),
  memberCount: z.number().int(),
  resolvedCount: z.number().int(),
  proposedCount: z.number().int(),
  followups: z.array(PhaseFollowupSummarySchema),
  /** Cost tracking: what the phase's cards and BA tasks cost (organization members only). */
  spend: SpendBriefSchema.optional(),
  createdAt: IsoTime,
  completedAt: IsoTime.nullable(),
});
export type PhaseSummaryDto = z.infer<typeof PhaseSummaryDtoSchema>;
export const PhasesResponseSchema = z.object({ phases: z.array(PhaseSummaryDtoSchema) });
export type PhasesResponse = z.infer<typeof PhasesResponseSchema>;

export const PhaseMemberDtoSchema = z.object({
  cardId: z.uuid(),
  ref: z.string(),
  title: z.string(),
  stage: z.string(),
  status: z.string(),
  assignment: PhaseAssignment,
  outcome: z.enum(['finalized', 'closed_manually', 'cancelled', 'waiting_merge', 'published']).nullable(),
  action: StoredCompletionAction.nullable(),
  resultRef: z
    .object({ mergeCommit: z.string(), prUrl: z.string(), pushedBranch: z.string() })
    .partial()
    .nullable(),
  /** The card's work is in the working branch. */
  merged: z.boolean(),
  branchName: z.string().nullable(),
  /** A finalized `pr` / `push_branch` card waiting for its merge: a member may confirm it by hand. */
  canConfirmMerge: z.boolean(),
});
export type PhaseMemberDto = z.infer<typeof PhaseMemberDtoSchema>;

export const PhaseFollowupDtoSchema = z.object({
  id: z.uuid(),
  position: z.number().int(),
  kind: FollowupKind,
  label: z.string(),
  targetId: z.uuid().nullable(),
  targetName: z.string().nullable(),
  platform: z.string().nullable(),
  instruction: z.string(),
  note: z.string(),
  status: FollowupStatus,
  delegate: FollowupDelegate.nullable(),
  brief: z.string().nullable(),
  devopsRequests: z.array(
    z.object({
      id: z.uuid(),
      workstationName: z.string(),
      status: z.string(),
      threadId: z.uuid(),
      summary: z.string().nullable(),
    }),
  ),
  regressionCards: z.array(z.object({ id: z.uuid(), ref: z.string(), status: z.string() })),
  resultSummary: z.string().nullable(),
  evidence: z.record(z.string(), z.unknown()),
  mock: z.unknown().nullable().optional(),
  startedAt: IsoTime.nullable(),
  finishedAt: IsoTime.nullable(),
});
export type PhaseFollowupDto = z.infer<typeof PhaseFollowupDtoSchema>;

export const PhaseDetailDtoSchema = PhaseSummaryDtoSchema.extend({
  members: z.array(PhaseMemberDtoSchema),
  followupDetails: z.array(PhaseFollowupDtoSchema),
  cardOutcomes: z.array(PhaseCardOutcome),
  report: z.string().nullable(),
  outstanding: z.array(PhaseOutstandingSchema),
  resultsReport: z.string().nullable(),
  proposalDeskItemId: z.uuid().nullable(),
  reportDeskItemId: z.uuid().nullable(),
  resultsDeskItemId: z.uuid().nullable(),
  threadId: z.uuid(),
  approvedAt: IsoTime.nullable(),
  finishedAt: IsoTime.nullable(),
  /** Follow-ups may still be edited (up to the manager's approval). */
  canEditFollowups: z.boolean(),
  canAssign: z.boolean(),
  canReopen: z.boolean(),
  /** BA background tasks of the phase (report, briefs, results) and their state. */
  tasks: z.array(
    z.object({
      id: z.uuid(),
      kind: BaTaskKind,
      status: BaTaskStatus,
      note: z.string().nullable(),
      createdAt: IsoTime,
    }),
  ),
  projectKey: z.string(),
});
export type PhaseDetailDto = z.infer<typeof PhaseDetailDtoSchema>;

/** The live data a `phase_proposal`, `phase_done` or `phase_results` desk item renders from. */
export const PhaseDeskBlockSchema = z.object({
  phaseId: z.uuid(),
  ref: z.string(),
  name: z.string(),
  status: PhaseStatus,
  projectKey: z.string(),
  members: z.array(PhaseMemberDtoSchema),
  followups: z.array(PhaseFollowupDtoSchema),
  cardOutcomes: z.array(PhaseCardOutcome),
  outstanding: z.array(PhaseOutstandingSchema),
  report: z.string().nullable(),
  resultsReport: z.string().nullable(),
  canEditFollowups: z.boolean(),
});
export type PhaseDeskBlock = z.infer<typeof PhaseDeskBlockSchema>;

export const PhaseParamsSchema = z.object({ id: z.uuid() });
export const PhaseByNumberParamsSchema = z.object({
  projectKey: z.string(),
  number: z.coerce.number().int().positive(),
});

export const CreatePhaseRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(4000).optional(),
  followups: FollowupListSchema.optional(),
  workingBranch: z.string().min(1).optional(),
});
export type CreatePhaseRequest = z.infer<typeof CreatePhaseRequestSchema>;

export const PatchPhaseRequestSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(4000).optional(),
  workingBranch: z.string().min(1).nullable().optional(),
});
export type PatchPhaseRequest = z.infer<typeof PatchPhaseRequestSchema>;

export const SetFollowupsRequestSchema = z.object({ followups: FollowupListSchema });
export type SetFollowupsRequest = z.infer<typeof SetFollowupsRequestSchema>;
export const FollowupDefaultsResponseSchema = z.object({ followups: FollowupListSchema });
export type FollowupDefaultsResponse = z.infer<typeof FollowupDefaultsResponseSchema>;

export const ReopenPhaseRequestSchema = z.object({ reason: z.string().trim().min(1).max(2000) });
export const AssignCardPhaseRequestSchema = z.object({ phaseId: z.uuid().nullable() });
export type AssignCardPhaseRequest = z.infer<typeof AssignCardPhaseRequestSchema>;
export const ConfirmMergedRequestSchema = z.object({ note: z.string().max(2000).optional() });
