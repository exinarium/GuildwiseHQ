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
  /** How often the same subject was raised while this item was open (1: once). */
  repeatCount: z.number().int().min(1).optional(),
  /** A hint about the item (a waiting large-merge approval the project setting now allows to merge without you). */
  hint: z.string().nullable().optional(),
  /** M7: the intake whose ticket this mapping question (`subkind 'unmapped_ticket'`) is about. */
  intakeId: z.uuid().nullable().optional(),
  /** M7: set when an agent (not the manager) answered the question. */
  answeredByAgentName: z.string().nullable().optional(),
  /** The role of that agent (`ceo`: the item shows as a CEO decision). */
  answeredByAgentRole: z.string().nullable().optional(),
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
  data: z
    .object({
      workstationId: z.string().optional(),
      key: z.string().optional(),
      /** A `playbook_input_needed` notice: the guided session that waits for the owner's answers. */
      threadId: z.uuid().optional(),
      /** `ceo_permission` items ("authorize this execution"): what the runtime wants to run, and until when it waits. */
      askId: z.string().optional(),
      turnId: z.string().optional(),
      tool: z.string().optional(),
      input: z.string().optional(),
      reason: z.string().optional(),
      expiresAt: z.string().optional(),
    })
    .optional(),
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
  /** `ceo_decision` items: one decision the CEO took on its own, and where its review by the owner stands. */
  ceoDecision: z
    .object({
      question: z.string(),
      decision: z.string(),
      reason: z.string(),
      confidence: z.number().nullable(),
      ceoName: z.string().nullable(),
      class: z.string().nullable(),
      source: z.enum(['act', 'chain']),
      /** The question the CEO answered (when the decision answered one). */
      questionItemId: z.uuid().nullable(),
      /** The owner acknowledged or corrected it (a decision recorded on a resolved question is open for review until then). */
      reviewed: z.boolean().optional(),
      correction: z
        .object({
          text: z.string(),
          at: IsoTime,
          applied: z.string().nullable(),
          /** pending: the BA is analysing; analysed: the CEO's turn; lesson: the BA finalises; done: concluded. */
          review: z.enum(['pending', 'analysed', 'lesson', 'done']),
          analysis: z.string().nullable(),
          lesson: z.string().nullable(),
          /** The BA's assessment of what already happened because of the decision. */
          consequences: z.string().nullable().optional(),
          /** The fix cards the BA proposed in its analysis (not created yet). */
          proposedCards: z
            .array(
              z.object({
                title: z.string(),
                project: z.string(),
                change: z.string(),
                acceptanceCriteria: z.array(z.string()),
              }),
            )
            .optional(),
          noFixReason: z.string().nullable().optional(),
          /** The CEO's reply: its stance, what it got wrong, and comments on the proposed cards. */
          ceoReply: z
            .object({
              stance: z.enum(['agree', 'disagree']).nullable(),
              reflection: z.string().nullable(),
              cardChanges: z.string().nullable(),
              /** The lesson was recorded by the server because the CEO could not reply. */
              withoutCeo: z.boolean(),
              at: IsoTime.nullable(),
            })
            .nullable()
            .optional(),
          /** The BA's final turn: what it did and the fix cards it created. */
          final: z
            .object({
              summary: z.string(),
              cards: z.array(
                z.object({ cardId: z.uuid(), ref: z.string(), title: z.string(), projectKey: z.string() }),
              ),
              skipped: z.array(z.string()),
              fallback: z.boolean(),
              at: IsoTime.nullable(),
            })
            .nullable()
            .optional(),
        })
        .nullable(),
      acknowledgedAt: IsoTime.nullable(),
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
          /** The owner may correct this decision ("I'd rather you hadn't"). */
          correctable: z.boolean().optional(),
        }),
      ),
      /** Off-board jobs that keep coming back ("Things you keep asking me"). */
      repeats: z
        .array(
          z.object({
            id: z.string(),
            key: z.string(),
            suggestion: z.enum(['feature', 'skill', 'automation']),
            count7: z.number().int(),
            count30: z.number().int(),
            projectKey: z.string().nullable(),
            jobs: z.array(z.object({ id: z.string(), title: z.string(), at: z.string() })),
            detectedAt: z.string(),
          }),
        )
        .optional(),
      /** Order turns of the last 24 hours (full-power standing orders), each correctable. */
      orderTurns: z
        .array(
          z.object({
            turnId: z.string(),
            at: z.string(),
            entryId: z.string(),
            orderTitle: z.string(),
            outcome: z.enum(['running', 'done', 'declined', 'failed']),
            summary: z.string(),
            commands: z.array(z.string()),
            ask: z.string().nullable(),
            corrected: z.boolean(),
          }),
        )
        .optional(),
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
  counts: z.object({
    open: z.number().int(),
    blocking: z.number().int(),
    urgent: z.number().int(),
    /** CEO decisions waiting for the owner's review: informational, not part of `open`. */
    ceoDecisions: z.number().int().optional(),
  }),
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
  /** The answer keeps the card parked until this condition holds (the card is not returned to the queue). */
  keepBlockedUntil: z.string().trim().min(1).max(500).optional(),
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
  /** Approving a standing-order proposal that repeats a live order: `merge` puts its wording into that order. */
  onDuplicate: z.literal('merge').optional(),
  /** Q69: approving "where should this playbook run?" names one of the person's own workstations (the item's options). */
  workstationId: z.uuid().optional(),
});
export type ResolveDeskItemRequest = z.infer<typeof ResolveDeskItemRequestSchema>;

export const DismissDeskItemRequestSchema = z.object({ note: z.string().max(2000).optional() });

/** `POST /api/desk/:id/ceo-decision/correct` */
export const CorrectCeoDecisionRequestSchema = z.object({
  correction: z.string().trim().min(1).max(4000),
  /** Also undo the decision now, where there is a clean way (re-open the question the CEO answered). */
  applyNow: z.boolean().default(false),
});
export type CorrectCeoDecisionRequest = z.infer<typeof CorrectCeoDecisionRequestSchema>;

/** `POST /api/desk/ceo-decisions/acknowledge-all` */
export const AcknowledgeAllCeoDecisionsResponseSchema = z.object({ acknowledged: z.number().int() });
export type AcknowledgeAllCeoDecisionsResponse = z.infer<typeof AcknowledgeAllCeoDecisionsResponseSchema>;
