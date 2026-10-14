import { z } from 'zod';
import { CardStatus, CardType, RiskTier } from '../cards/types.ts';
import { Seniority } from '../roles/schema.ts';
import { IsoTime } from './common.ts';

/**
 * Could any agent ever take this card's current stage? `blocked`: nobody hired could (hire one); `waiting`: agents
 * exist but are offline, busy or their workstation lacks what the card needs. `ok: true` carries nothing else.
 */
export const WorkabilitySchema = z.object({
  ok: z.boolean(),
  level: z.enum(['blocked', 'waiting']).optional(),
  reason: z.string().optional(),
  /** What to hire to fix a `blocked` card: the HR board's Hire form is prefilled with it. */
  hire: z.object({ roleKey: z.string(), seniority: Seniority.optional() }).optional(),
  /** Set when the cause is a project setting (a working branch the runner rejected): the tab to open in project settings. */
  settings: z.enum(['repositories']).optional(),
});
export type Workability = z.infer<typeof WorkabilitySchema>;

/** Why a `blocked` card is blocked: the open desk item holding it (the question or approval waiting on a manager). */
export const BlockedReasonSchema = z.object({
  deskItemId: z.uuid(),
  kind: z.string(),
  title: z.string(),
  /** More items hold the card when above zero. */
  others: z.number().int().default(0),
});
export type BlockedReason = z.infer<typeof BlockedReasonSchema>;

/** An open repository hygiene finding on the card's repository (a conflict, failed auth, an unconfirmed branch, ...). */
export const CardHygieneSchema = z.object({
  kind: z.string(),
  repoName: z.string(),
  detail: z.string(),
});
export type CardHygiene = z.infer<typeof CardHygieneSchema>;

/** The project's budget when it affects this card (the card waits for, or runs under, a used-up or nearly used-up month). */
export const CardBudgetSchema = z.object({
  state: z.enum(['warning', 'paused', 'overridden']),
  /** Null for a viewer who may not see amounts. */
  percent: z.number().nullable(),
  resetsAt: IsoTime,
  canEdit: z.boolean(),
});
export type CardBudget = z.infer<typeof CardBudgetSchema>;

export const BoardCardSchema = z.object({
  id: z.uuid(),
  ref: z.string(),
  title: z.string(),
  cardType: CardType,
  /** Set when the card runs on another workflow than the project's (a research card in a code project). */
  workflowKey: z.string().optional(),
  stage: z.string(),
  status: CardStatus,
  assignee: z.object({ agentId: z.uuid(), name: z.string() }).nullable(),
  /** `max(queuedAt, claimedAt, updatedAt)`, ISO; clients compute age. */
  updatedAt: IsoTime,
  queuedAt: IsoTime.nullable(),
  riskTier: RiskTier.nullable(),
  blocked: z.boolean(),
  reworkRound: z.number().int(),
  priority: z.number().int(),
  /** M4: the open bug card this (waiting) card waits on, for the Test column's "waiting on bug" state. */
  waitingOn: z
    .object({
      id: z.uuid(),
      ref: z.string(),
      /** Sub-workflow child the card waits for: what the chip shows (title and column only when the viewer may see the child). */
      title: z.string().nullable().optional(),
      column: z.string().nullable().optional(),
      projectKey: z.string().nullable().optional(),
      projectName: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  /**
   * Why a `waiting` card waits: a bug it spawned, the manager's merge approval, a running merge, DevOps, or the child
   * card of its sub-workflow step.
   */
  waitingFor: z
    .enum(['bug', 'approval', 'finalizing', 'devops', 'subworkflow', 'qa', 'approval_step'])
    .nullable()
    .optional(),
  /** An approval step: who the card waits for (absent outside approval steps). */
  approval: z
    .object({
      approverUserId: z.uuid(),
      approverName: z.string(),
      stageLabel: z.string(),
    })
    .nullable()
    .optional(),
  /** Manual QA: who the card waits for (absent outside the QA stages). */
  qa: z
    .object({
      state: z.enum(['steps', 'open']),
      assigneeUserId: z.uuid(),
      assigneeName: z.string(),
    })
    .nullable()
    .optional(),
  /** The card was started by a sub-workflow step of this parent card ("Started by APP-41"). */
  startedBy: z.object({ id: z.uuid(), ref: z.string() }).nullable().optional(),
  /** M4: suite (full E2E / regression) cards are marked on the board. */
  origin: z.string().optional(),
  /** Absent or `ok` for a workable card; see `WorkabilitySchema`. */
  workability: WorkabilitySchema.optional(),
  /** Loop breaker: the card is held back until `until` after `failures` failed shifts. */
  backoff: z.object({ until: IsoTime, failures: z.number().int() }).nullable().optional(),
  /** Present on a `blocked` card: the reason, so the card can say it. */
  blockedReason: BlockedReasonSchema.nullable().optional(),
  /** Open hygiene findings on this card's repository (absent when none). */
  hygiene: z.array(CardHygieneSchema).optional(),
  /** Absent unless the project's budget is at the warning level or beyond. */
  budget: CardBudgetSchema.optional(),
  /** The phase this card belongs to (a small chip on the card). */
  phase: z
    .object({ id: z.uuid(), ref: z.string(), assignment: z.enum(['proposed', 'confirmed']) })
    .nullable()
    .optional(),
});
export type BoardCard = z.infer<typeof BoardCardSchema>;

export const BoardColumnSchema = z.object({ name: z.string(), cards: z.array(BoardCardSchema) });
export type BoardColumn = z.infer<typeof BoardColumnSchema>;

/** `phaseId`: a phase id, or `none` for cards without a phase. */
export const BoardQuerySchema = z.object({
  projectId: z.uuid(),
  phaseId: z.union([z.uuid(), z.literal('none')]).optional(),
});
/** `GET /api/board?projectId=` : columns in display order (see `boardColumns`), cancelled cards omitted. */
export const BoardResponseSchema = z.object({
  projectId: z.uuid(),
  workflowKey: z.string(),
  columns: z.array(BoardColumnSchema),
});
export type BoardResponse = z.infer<typeof BoardResponseSchema>;

/** `GET /api/search/cards?q=` : cards of the viewer's projects whose ref starts with, or whose title contains, `q` (the command palette). */
export const CardSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(20).default(8),
});
export const CardSearchResponseSchema = z.object({
  cards: z.array(
    z.object({
      id: z.uuid(),
      ref: z.string(),
      title: z.string(),
      status: z.string(),
      projectKey: z.string(),
      projectName: z.string(),
    }),
  ),
});
export type CardSearchResponse = z.infer<typeof CardSearchResponseSchema>;

/** Done and cancelled cards leave the board this long after they were finished; the project's archive lists them (#51). */
export const CARD_ARCHIVE_AFTER_HOURS = 24;

/** `GET /api/archive?projectId=`: the archived cards of a project, newest finished first. Dates are `YYYY-MM-DD` (UTC days). */
export const ArchiveQuerySchema = z.object({
  projectId: z.uuid(),
  /** Matches the ref (prefix), the title or the ticket key (`externalRef`) of the card. */
  q: z.string().trim().max(100).optional(),
  status: z.enum(['done', 'cancelled']).optional(),
  agentId: z.uuid().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type ArchiveQuery = z.infer<typeof ArchiveQuerySchema>;

export const ArchivedCardSchema = z.object({
  id: z.uuid(),
  ref: z.string(),
  title: z.string(),
  cardType: CardType,
  status: z.enum(['done', 'cancelled']),
  externalRef: z.string().nullable(),
  priority: z.number().int(),
  finishedAt: IsoTime,
  /** How a done card landed (`pr`, `push_branch`, `merge`), when known. */
  completionAction: z.string().nullable(),
  /** The agent that last handed the card over (null for a card that never had a shift). */
  lastAgent: z.string().nullable(),
});
export type ArchivedCard = z.infer<typeof ArchivedCardSchema>;

export const ArchiveResponseSchema = z.object({
  projectId: z.uuid(),
  afterHours: z.number().int(),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  cards: z.array(ArchivedCardSchema),
});
export type ArchiveResponse = z.infer<typeof ArchiveResponseSchema>;
