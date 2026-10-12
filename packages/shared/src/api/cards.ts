import { z } from 'zod';
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
  completionAction: CompletionAction.nullable(),
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
  kind: z.enum(['edited', 'risk_tier', 'merge_policy', 'phase', 'merge_verified']),
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
  currentShift: ShiftDtoSchema.nullable(),
  /** Allowed manager actions for the requesting user (for hiding buttons). */
  permissions: z.object({
    canEdit: z.boolean(),
    canSpecify: z.boolean(),
    canMove: z.boolean(),
    canRelease: z.boolean(),
    /** Release the loop breaker's back-off by hand. */
    canReleaseBackoff: z.boolean().optional(),
    canCancel: z.boolean(),
    canComment: z.boolean(),
    /** Set or clear the risk tier override: while the card is open and no merge is pending. */
    canSetRisk: z.boolean().default(false),
    /** Put the card in a phase or take it out (the card is open and not a suite or bug child). */
    canSetPhase: z.boolean().optional(),
  }),
  diffStats: DiffStats.nullable().optional(),
  /** Open desk items blocking this card (M2). */
  blockers: z.array(z.object({ deskItemId: z.uuid(), title: z.string() })).default([]),
  /** M4: test runs (evidence), bug child / parent links and the finalize state. */
  testing: CardTestingSchema.optional(),
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
export const ReleaseCardRequestSchema = z.object({ reason: z.string().max(2000).optional() });
export const CancelCardRequestSchema = z.object({ reason: z.string().min(1).max(2000) });
export const CardParamsSchema = z.object({ id: z.string().min(1) });
