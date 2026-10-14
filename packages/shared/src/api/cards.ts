import { z } from 'zod';
import { CardAttachmentDtoSchema } from '../attachments/index.ts';
import {
  CardOrigin,
  CardStatus,
  CardType,
  CompletionAction,
  DecisionPolicy,
  DiffStats,
  RiskTier,
  ThreadMessageKind,
} from '../cards/types.ts';
import { CardChangesSchema } from '../events/card.ts';
import { CardMcpUsageSchema } from '../mcp/index.ts';
import { WorkabilitySchema } from './board.ts';
import { IsoTime } from './common.ts';
import { SpendBriefSchema } from './costs.ts';
import { PublicationDtoSchema } from './research.ts';
import { ShiftDtoSchema } from './shifts.ts';
import { CardTestingSchema } from './testing.ts';

export const CardDtoSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  number: z.number().int(),
  ref: z.string(),
  title: z.string(),
  cardType: CardType,
  workflowKey: z.string(),
  workflowVersion: z.number().int(),
  stage: z.string(),
  status: CardStatus,
  column: z.string(),
  fields: z.record(z.string(), z.unknown()),
  ownerUserId: z.uuid(),
  decisionPolicy: DecisionPolicy,
  riskTier: RiskTier.nullable(),
  riskTierOverridden: z.boolean(),
  docsNeeded: z.boolean(),
  /** Architect: run Investigate & design before build. */
  designNeeded: z.boolean().optional(),
  /** Architect: the card only investigates (no build). */
  investigationOnly: z.boolean().optional(),
  /** Merge the latest main branch first: null follows the project setting. */
  mergeMainFirst: z.boolean().nullable().optional(),
  /** The architect's report once the investigate stage is done (null before). */
  investigation: z
    .object({
      reportPath: z.string(),
      location: z.enum(['repo', 'vault']),
      summary: z.string(),
      commit: z.string().nullable(),
      /** The file on the card branch's forge page when the remote is a known forge (else null). */
      url: z.string().nullable(),
      at: IsoTime,
    })
    .nullable()
    .optional(),
  /** What the runner did with the latest main branch before work started (null: nothing recorded). */
  mainSync: z
    .object({
      result: z.string(),
      mainBranch: z.string().nullable(),
      workingBranch: z.string().nullable(),
      files: z.array(z.string()),
      at: IsoTime,
    })
    .nullable()
    .optional(),
  /** The card's own override; null means it follows the project's default. */
  completionAction: CompletionAction.nullable(),
  /** How finished work lands now: the card's override, else the project's default. */
  effectiveCompletionAction: CompletionAction.nullable(),
  completionActionSource: z.enum(['project', 'card']),
  repoId: z.uuid().nullable(),
  baseBranch: z.string().nullable(),
  branchName: z.string().nullable(),
  homeWorkstationId: z.uuid().nullable(),
  parentCardId: z.uuid().nullable(),
  origin: CardOrigin,
  scheduled: z.boolean(),
  priority: z.number().int(),
  reworkRound: z.number().int(),
  claimedByAgentId: z.uuid().nullable(),
  claimedByAgentName: z.string().nullable(),
  claimedAt: IsoTime.nullable(),
  queuedAt: IsoTime.nullable(),
  blockedSince: IsoTime.nullable(),
  dependencies: z.array(
    z.object({ cardId: z.uuid(), ref: z.string(), title: z.string(), status: CardStatus }),
  ),
  createdAt: IsoTime,
  updatedAt: IsoTime,
  finalizedAt: IsoTime.nullable(),
  /** Loop breaker: set while the card is held back after repeated failed shifts. */
  backoff: z.object({ until: IsoTime, failures: z.number().int() }).nullable().optional(),
});
export type CardDto = z.infer<typeof CardDtoSchema>;

export const HandoffDtoSchema = z.object({
  id: z.uuid(),
  cardId: z.uuid(),
  shiftId: z.uuid().nullable(),
  agentId: z.uuid().nullable(),
  agentName: z.string().nullable(),
  stage: z.string(),
  outcome: z.string(),
  note: z.string(),
  data: z.record(z.string(), z.unknown()),
  createdAt: IsoTime,
});
export const TransitionDtoSchema = z.object({
  id: z.number().int(),
  fromStage: z.string().nullable(),
  toStage: z.string(),
  fromStatus: z.string().nullable(),
  toStatus: z.string(),
  agentId: z.uuid().nullable(),
  userId: z.uuid().nullable(),
  reason: z.string(),
  at: IsoTime,
});
/** A timeline entry that is not a stage or status change: a field edit or a risk tier override. */
export const CardActivityDtoSchema = z.object({
  id: z.number().int(),
  kind: z.enum(['edited', 'risk_tier', 'merge_policy', 'phase', 'merge_verified', 'reopened']),
  summary: z.string(),
  reason: z.string().nullable(),
  userId: z.uuid().nullable(),
  agentId: z.uuid().nullable(),
  actorName: z.string().nullable(),
  at: IsoTime,
});
export type CardActivityDto = z.infer<typeof CardActivityDtoSchema>;
export const ThreadMessageDtoSchema = z.object({
  id: z.uuid(),
  threadId: z.uuid(),
  authorKind: z.enum(['user', 'agent', 'system']),
  authorUserId: z.uuid().nullable(),
  authorAgentId: z.uuid().nullable(),
  authorName: z.string().nullable(),
  kind: ThreadMessageKind,
  body: z.string(),
  data: z.record(z.string(), z.unknown()),
  createdAt: IsoTime,
});
export type ThreadMessageDto = z.infer<typeof ThreadMessageDtoSchema>;

/** A child card a sub-workflow step of this card started (card detail "Sub-workflows" panel). */
export const SubworkflowChildDtoSchema = z.object({
  stageId: z.string(),
  stageLabel: z.string(),
  mode: z.enum(['wait', 'continue']),
  /** open = the card waits; continued = it moved on at once; done / cancelled = the child ended. */
  state: z.enum(['open', 'continued', 'done', 'cancelled']),
  workflowKey: z.string(),
  workflowVersion: z.number().int(),
  startedAt: IsoTime,
  resolvedAt: IsoTime.nullable(),
  /** Fields copied back from the child when it finished. */
  fieldsBack: z.record(z.string(), z.unknown()),
  child: z.object({
    id: z.uuid(),
    ref: z.string(),
    title: z.string(),
    status: CardStatus,
    stage: z.string(),
    column: z.string().nullable(),
    projectId: z.uuid(),
    projectKey: z.string(),
    projectName: z.string(),
    /** The viewer is a member of the child's project: title, column and the link are shown. */
    visible: z.boolean(),
    /** The child is still open and the viewer may cancel it (offered with "also cancel the child card"). */
    canCancel: z.boolean().optional(),
    /** The fields the parent mapped into the child (values at the child now). */
    fields: z.record(z.string(), z.unknown()),
  }),
});
export type SubworkflowChildDto = z.infer<typeof SubworkflowChildDtoSchema>;

export const SubworkflowsPanelSchema = z.object({
  /** The children this card's sub-workflow steps started (oldest first). */
  children: z.array(SubworkflowChildDtoSchema),
  /** The card that started this one (null: it is not a sub-workflow child). */
  startedBy: z
    .object({
      id: z.uuid(),
      ref: z.string(),
      title: z.string(),
      stageLabel: z.string(),
      projectKey: z.string(),
      visible: z.boolean(),
    })
    .nullable(),
});
export type SubworkflowsPanel = z.infer<typeof SubworkflowsPanelSchema>;

/** `GET /api/cards/:id` (also by ref, `WEB-12`): card + handoffs + transitions + thread + current shift. */
export const CardDetailResponseSchema = z.object({
  card: CardDtoSchema,
  /** Could any agent ever take the card's current stage (queued, unclaimed cards only). */
  workability: WorkabilitySchema.optional(),
  handoffs: z.array(HandoffDtoSchema),
  transitions: z.array(TransitionDtoSchema),
  /** Edits and risk tier overrides, shown in the timeline between the transitions (ordered by time). */
  activity: z.array(CardActivityDtoSchema).default([]),
  threadId: z.uuid().nullable(),
  thread: z.array(ThreadMessageDtoSchema),
  /** Files attached to the card (metadata; the bytes come from `/api/cards/:id/attachments/:attachmentId`). */
  attachments: z.array(CardAttachmentDtoSchema).optional(),
  currentShift: ShiftDtoSchema.nullable(),
  /** MCP servers and tools the card's agents used, per shift (only shifts that used any; oldest first). */
  mcpUsage: z.array(CardMcpUsageSchema).optional(),
  /** Allowed manager actions for the requesting user (for hiding buttons). */
  permissions: z.object({
    canEdit: z.boolean(),
    canSpecify: z.boolean(),
    canMove: z.boolean(),
    canRelease: z.boolean(),
    /** Release the loop breaker's back-off by hand. */
    canReleaseBackoff: z.boolean().optional(),
    canCancel: z.boolean(),
    /** Put a done or cancelled card back to work (owner and managers). */
    canReopen: z.boolean().optional(),
    canComment: z.boolean(),
    /** Add and remove attachments (who may edit the card, also while it is claimed). */
    canAttach: z.boolean().optional(),
    /** Set or clear the risk tier override: while the card is open and no merge is pending. */
    canSetRisk: z.boolean().default(false),
    /** Change the priority at any time (any card but a cancelled one, also while it is claimed). */
    canEditPriority: z.boolean().optional(),
    /** Change the completion action: while the card is open and no finalise is waiting for approval or running. */
    canEditCompletion: z.boolean().optional(),
    /** Put the card in a phase or take it out (the card is open and not a suite or bug child). */
    canSetPhase: z.boolean().optional(),
  }),
  diffStats: DiffStats.nullable().optional(),
  /** Open desk items blocking this card (M2). */
  blockers: z.array(z.object({ deskItemId: z.uuid(), title: z.string() })).default([]),
  /** M4: test runs (evidence), bug child / parent links and the finalize state. */
  testing: CardTestingSchema.optional(),
  /** Sub-workflows: children this card started and the parent that started it (absent: neither). */
  subworkflows: SubworkflowsPanelSchema.optional(),
  /** M6: the published research note of a research card. */
  publication: PublicationDtoSchema.nullable().optional(),
  /** Cost tracking: what the card's shifts cost so far (organization members only). */
  spend: SpendBriefSchema.optional(),
  /** The phase this card belongs to, if any. */
  phase: z
    .object({
      id: z.uuid(),
      ref: z.string(),
      name: z.string(),
      status: z.string(),
      assignment: z.enum(['proposed', 'confirmed']),
    })
    .nullable()
    .optional(),
});
export type CardDetailResponse = z.infer<typeof CardDetailResponseSchema>;

/** `POST /api/cards` */
export const CreateCardRequestSchema = z.object({
  projectId: z.uuid(),
  title: z.string().min(1).max(300),
  cardType: CardType,
  fields: z.record(z.string(), z.unknown()).default({}),
  repoId: z.uuid().optional(),
  completionAction: CompletionAction.optional(),
  docsNeeded: z.boolean().optional(),
  /** Run Investigate & design before build; absent: the project's design step setting. */
  designNeeded: z.boolean().optional(),
  /** Investigate only: no build follows; implies `designNeeded` (false is refused). */
  investigationOnly: z.boolean().optional(),
  /** Merge the latest main branch first: absent/null follows the project setting. */
  mergeMainFirst: z.boolean().nullable().optional(),
  priority: z.number().int().min(1).max(9).optional(),
  dependencies: z.array(z.uuid()).optional(),
  /** Specify immediately; if required fields are missing the card stays draft and the response lists them. */
  specify: z.boolean().optional(),
  /** "Research this": the interest the card belongs to (its research or feed project must be `projectId`). */
  interestId: z.uuid().optional(),
  /** One of the project's enabled workflows (project settings); absent: the default for the card type. */
  workflowKey: z.string().min(1).optional(),
});
export type CreateCardRequest = z.infer<typeof CreateCardRequestSchema>;

export const CreateCardResponseSchema = z.object({
  card: CardDtoSchema,
  /** Present when `specify` was requested but could not be done. */
  missing: z.array(z.string()).optional(),
});

/** `PATCH /api/cards/:id` (owner). */
export const PatchCardRequestSchema = CardChangesSchema.omit({
  riskTierOverridden: true,
  ownerUserId: true,
}).extend({
  /** Why the risk tier is overridden (required when `riskTier` is sent; `null` clears the override). */
  reason: z.string().trim().min(1).max(1000).optional(),
});
export type PatchCardRequest = z.infer<typeof PatchCardRequestSchema>;

/** The BA's `card.risk` RPC (`aom risk <small|large> --reason "..."`), checked on the server. */
export const RiskTierRpcParamsSchema = z.object({
  tier: RiskTier,
  reason: z.string().trim().min(1).max(1000),
});

/** `POST /api/cards/:id/specify` -> CardDetailResponse, or 422 with this body. */
export const SpecifyMissingResponseSchema = z.object({
  error: z.object({
    code: z.literal('missing_fields'),
    message: z.string(),
    details: z.object({ missing: z.array(z.string()) }),
  }),
});
export type SpecifyMissingResponse = z.infer<typeof SpecifyMissingResponseSchema>;

export const CommentRequestSchema = z.object({ body: z.string().min(1).max(20000) });
export const MoveCardRequestSchema = z.object({
  toStage: z.string().min(1),
  reason: z.string().min(1).max(2000),
});
/** `POST /api/cards/:id/reopen`: a done or cancelled card goes back to an agent or manual stage of its workflow. */
export const ReopenCardRequestSchema = MoveCardRequestSchema;
export const ReleaseCardRequestSchema = z.object({ reason: z.string().max(2000).optional() });
export const CancelCardRequestSchema = z.object({
  reason: z.string().min(1).max(2000),
  /**
   * Also cancel the open sub-workflow child card(s) this card waits on (only those the caller may cancel; the others
   * are left running). Default false: only this card is cancelled.
   */
  alsoCancelChildren: z.boolean().default(false),
});
export type CancelCardRequest = z.infer<typeof CancelCardRequestSchema>;
export const CardParamsSchema = z.object({ id: z.string().min(1) });
