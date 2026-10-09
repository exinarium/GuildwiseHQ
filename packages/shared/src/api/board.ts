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
  waitingOn: z.object({ id: z.uuid(), ref: z.string() }).nullable().optional(),
  /** Why a `waiting` card waits: a bug it spawned, the manager's merge approval, a running merge, or DevOps. */
  waitingFor: z.enum(['bug', 'approval', 'finalizing', 'devops']).nullable().optional(),
  /** M4: suite (full E2E / regression) cards are marked on the board. */
  origin: z.string().optional(),
  /** Absent or `ok` for a workable card; see `WorkabilitySchema`. */
  workability: WorkabilitySchema.optional(),
  /** Loop breaker: the card is held back until `until` after `failures` failed shifts. */
  backoff: z.object({ until: IsoTime, failures: z.number().int() }).nullable().optional(),
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
