import { z } from 'zod';
import { UserAvatarSchema } from '../avatars/index.ts';
import { DecisionPolicy } from '../cards/types.ts';
import { DeskItemKind, DeskItemStatus, DeskOptionSchema } from '../events/desk.ts';
import { LedgerScope } from '../events/ledger.ts';
import { EscalationStepSchema } from '../intake/index.ts';
import { FloorDigestSchema } from '../reporter/index.ts';
import { IsoTime } from './common.ts';
import { DigestItemDtoSchema } from './digest.ts';
import { PhaseDeskBlockSchema } from './phases.ts';

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
  /** The manager who answered and their picture (null: initials). */
  answeredByUserId: z.uuid().nullable().optional(),
  answeredByAvatar: UserAvatarSchema.nullable().optional(),
  /** The agent that answered, for its face. */
  answeredByAgentId: z.uuid().nullable().optional(),
  decisionPolicy: DecisionPolicy.nullable(),
  /** M7: who looked at the question on its way to the desk (senior peer, BA), and who answered it. */
  escalationTrail: z.array(EscalationStepSchema).optional(),
  /** A hint about the item (a waiting large-merge approval the project setting now allows to merge without you). */
  hint: z.string().nullable().optional(),
  /** M7: the intake whose ticket this mapping question (`subkind 'unmapped_ticket'`) is about. */
  intakeId: z.uuid().nullable().optional(),
  /** M7: set when an agent (not the manager) answered the question. */
  answeredByAgentName: z.string().nullable().optional(),
  /** M5: the items of a digest rating item (`kind 'rating'`), for rating them in place. */
  digestItems: z.array(DigestItemDtoSchema).optional(),
  /** The interest a digest rating item belongs to (a link to its digest tab). */
  interest: z.object({ id: z.uuid(), name: z.string() }).nullable().optional(),
  /** Phases: the phase a `phase_proposal`, `phase_done` or `phase_results` item is about (live data). */
  phase: PhaseDeskBlockSchema.nullable().optional(),
  /** Part B: the BA's note on this item (context, how often it was asked, a recommendation). */
  baNote: z.string().nullable().optional(),
  baNoteAt: IsoTime.nullable().optional(),
  /** Part B: how the routing handled the item (`passed`: the BA looked at it; `released`: the BA ran out of time). */
  triage: z.enum(['none', 'pending', 'passed', 'released', 'dismissed', 'merged']).optional(),
  supersededBy: z.uuid().nullable().optional(),
  /** Part B: the standing BA chat the report links to. */
  chatThreadId: z.uuid().nullable().optional(),
  /** Part B: the structured digest behind a floor report. */
  floor: FloorDigestSchema.nullable().optional(),
  /** Budget notices: the project the notice is about ("Raise budget" and "Override" act on it). */
  budgetProject: z
    .object({ projectId: z.uuid(), projectKey: z.string(), interestId: z.uuid().optional() })
    .nullable()
    .optional(),
  /** Workstation notices (`claude_auth_expired`, `mcp_needs_sign_in`): which workstation, for the Integrations deep link. */
  data: z.object({ workstationId: z.string().optional(), key: z.string().optional() }).optional(),
  /** The CEO agent (docs/design/ceo-agent-v2.md section 6): the action that answered or handled the item (Undo), and its recommendation. */
  ceo: z
    .object({
      actionId: z.uuid().nullable(),
      agentName: z.string().nullable(),
      reason: z.string().nullable(),
      confidence: z.number().nullable(),
      undoable: z.boolean(),
      recommendation: z
        .object({
          actionId: z.uuid(),
          option: z.string().nullable(),
          text: z.string().nullable(),
          reason: z.string(),
          confidence: z.number(),
        })
        .nullable(),
    })
    .nullable()
    .optional(),
  /** The CEO's daily report: the actions of the last 24 hours (for Undo) and the training scores. */
  ceoReport: z
    .object({
      actions: z.array(
        z.object({
          id: z.uuid(),
          class: z.string(),
          mode: z.string(),
          status: z.string(),
          subject: z.string(),
          undoable: z.boolean(),
        }),
      ),
      scores: z.array(z.object({ class: z.string(), agreed: z.number().int(), total: z.number().int() })),
      fallback: z.boolean(),
    })
    .nullable()
    .optional(),
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
  /** "Remember this for the CEO": the answer is kept as an owner rule (only the organization Owner's answers count). */
  remember: z.boolean().optional(),
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
