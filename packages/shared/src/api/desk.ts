import { z } from 'zod';
import { DecisionPolicy } from '../cards/types.ts';
import { DeskItemKind, DeskItemStatus, DeskOptionSchema } from '../events/desk.ts';
import { LedgerScope } from '../events/ledger.ts';
import { IsoTime } from './common.ts';
import { DigestItemDtoSchema } from './digest.ts';

export const DeskLedgerChoiceSchema = z.object({
  /** "Add to ledger as": feature (card requirement), decision (project log) or standing order (every agent). */
  scope: LedgerScope.default('decision'),
  title: z.string().min(1).max(300).optional(),
  /** Standing orders only: apply to every project of the organization instead of this project. */
  orgWide: z.boolean().optional(),
});
export type DeskLedgerChoice = z.infer<typeof DeskLedgerChoiceSchema>;

export const DeskItemDtoSchema = z.object({
  id: z.uuid(),
  kind: DeskItemKind,
  subkind: z.string().nullable(),
  status: DeskItemStatus,
  routedTo: z.enum(['manager', 'agent']),
  title: z.string(),
  body: z.string(),
  /** What the asker was doing when the question came up. */
  doing: z.string(),
  options: z.array(DeskOptionSchema),
  /** Option id. */
  recommendation: z.string().nullable(),
  blocking: z.boolean(),
  pinned: z.boolean(),
  /** Urgent items (pinned) carry a badge. */
  urgent: z.boolean(),
  affectedCardIds: z.array(z.uuid()),
  affectedCount: z.number().int().nonnegative(),
  askedBy: z.object({
    kind: z.enum(['agent', 'user', 'system']),
    agentId: z.uuid().nullable(),
    agentName: z.string().nullable(),
    role: z.string().nullable(),
  }),
  card: z
    .object({
      id: z.uuid(),
      ref: z.string(),
      title: z.string(),
      stage: z.string(),
      status: z.string(),
      projectKey: z.string(),
    })
    .nullable(),
  projectId: z.uuid().nullable(),
  /** Ledger entries that matched the question when it was asked (duplicate check). */
  dedupEntries: z.array(z.object({ id: z.uuid(), scope: LedgerScope, title: z.string(), body: z.string() })),
  answer: z.string().nullable(),
  answerOption: z.string().nullable(),
  answeredAt: IsoTime.nullable(),
  answeredByName: z.string().nullable(),
  decisionPolicy: DecisionPolicy.nullable(),
  /** M5: the items of a digest rating item (`kind 'rating'`), for rating them in place. */
  digestItems: z.array(DigestItemDtoSchema).optional(),
  /** False for members who may see but not answer (owner_only on a shared card). */
  canAnswer: z.boolean(),
  createdAt: IsoTime,
});
export type DeskItemDto = z.infer<typeof DeskItemDtoSchema>;

export const DeskQuerySchema = z.object({
  projectId: z.uuid().optional(),
  status: z.enum(['open', 'closed', 'all']).default('open'),
});
export type DeskQuery = z.infer<typeof DeskQuerySchema>;

/** `GET /api/desk`: items ordered pinned DESC, blocking DESC, affected count DESC, age ASC. */
export const DeskListResponseSchema = z.object({
  items: z.array(DeskItemDtoSchema),
  counts: z.object({ open: z.number().int(), blocking: z.number().int(), urgent: z.number().int() }),
});
export type DeskListResponse = z.infer<typeof DeskListResponseSchema>;

export const DeskItemParamsSchema = z.object({ id: z.uuid() });

/** `POST /api/desk/:id/answer` */
export const AnswerDeskItemRequestSchema = z.object({
  answer: z.string().min(1).max(20000),
  optionId: z.string().min(1).optional(),
  ledger: DeskLedgerChoiceSchema.default({ scope: 'decision' }),
});
export type AnswerDeskItemRequest = z.infer<typeof AnswerDeskItemRequestSchema>;

export const AnswerDeskItemResponseSchema = z.object({
  item: DeskItemDtoSchema,
  ledgerEntryId: z.uuid(),
  unblockedCardIds: z.array(z.uuid()),
});
export type AnswerDeskItemResponse = z.infer<typeof AnswerDeskItemResponseSchema>;

/** `POST /api/desk/:id/resolve` (approvals, escalations, alerts) */
export const ResolveDeskItemRequestSchema = z.object({
  resolution: z.enum(['approved', 'rejected', 'acknowledged']),
  editedBody: z.string().max(20000).optional(),
  note: z.string().max(2000).optional(),
});
export type ResolveDeskItemRequest = z.infer<typeof ResolveDeskItemRequestSchema>;

export const DismissDeskItemRequestSchema = z.object({ note: z.string().max(2000).optional() });
