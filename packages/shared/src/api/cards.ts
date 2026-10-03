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
import { IsoTime } from './common.ts';
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
  handoffs: z.array(HandoffDtoSchema),
  transitions: z.array(TransitionDtoSchema),
  threadId: z.uuid().nullable(),
  thread: z.array(ThreadMessageDtoSchema),
  currentShift: ShiftDtoSchema.nullable(),
  /** Allowed manager actions for the requesting user (for hiding buttons). */
  permissions: z.object({
    canEdit: z.boolean(),
    canSpecify: z.boolean(),
    canMove: z.boolean(),
    canRelease: z.boolean(),
    canCancel: z.boolean(),
    canComment: z.boolean(),
  }),
  diffStats: DiffStats.nullable().optional(),
  /** Open desk items blocking this card (M2). */
  blockers: z.array(z.object({ deskItemId: z.uuid(), title: z.string() })).default([]),
  /** M4: test runs (evidence), bug child / parent links and the finalize state. */
  testing: CardTestingSchema.optional(),
  /** M6: the published research note of a research card. */
  publication: PublicationDtoSchema.nullable().optional(),
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
  priority: z.number().int().min(1).max(9).optional(),
  dependencies: z.array(z.uuid()).optional(),
  /** Specify immediately; if required fields are missing the card stays draft and the response lists them. */
  specify: z.boolean().optional(),
});
export type CreateCardRequest = z.infer<typeof CreateCardRequestSchema>;

export const CreateCardResponseSchema = z.object({
  card: CardDtoSchema,
  /** Present when `specify` was requested but could not be done. */
  missing: z.array(z.string()).optional(),
});

/** `PATCH /api/cards/:id` (owner). */
export const PatchCardRequestSchema = CardChangesSchema.omit({ riskTierOverridden: true, ownerUserId: true });
export type PatchCardRequest = z.infer<typeof PatchCardRequestSchema>;

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
