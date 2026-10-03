import { z } from 'zod';
import { CardStatus, CardType, RiskTier } from '../cards/types.ts';
import { IsoTime } from './common.ts';

export const BoardCardSchema = z.object({
  id: z.uuid(),
  ref: z.string(),
  title: z.string(),
  cardType: CardType,
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
});
export type BoardCard = z.infer<typeof BoardCardSchema>;

export const BoardColumnSchema = z.object({ name: z.string(), cards: z.array(BoardCardSchema) });
export type BoardColumn = z.infer<typeof BoardColumnSchema>;

export const BoardQuerySchema = z.object({ projectId: z.uuid() });
/** `GET /api/board?projectId=` : columns in display order (see `boardColumns`), cancelled cards omitted. */
export const BoardResponseSchema = z.object({
  projectId: z.uuid(),
  workflowKey: z.string(),
  columns: z.array(BoardColumnSchema),
});
export type BoardResponse = z.infer<typeof BoardResponseSchema>;
