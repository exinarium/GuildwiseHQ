import { z } from 'zod';
import { LedgerScope } from '../events/ledger.ts';
import { IsoTime } from './common.ts';

export const LedgerEntryDtoSchema = z.object({
  id: z.uuid(),
  scope: LedgerScope,
  projectId: z.uuid().nullable(),
  projectKey: z.string().nullable(),
  cardId: z.uuid().nullable(),
  cardRef: z.string().nullable(),
  title: z.string(),
  body: z.string(),
  tags: z.array(z.string()),
  sourceDeskItemId: z.uuid().nullable(),
  vaultPath: z.string().nullable(),
  createdByKind: z.string(),
  createdByName: z.string().nullable(),
  supersededBy: z.uuid().nullable(),
  createdAt: IsoTime,
  /** Full-text rank when a query was given. */
  rank: z.number().optional(),
});
export type LedgerEntryDto = z.infer<typeof LedgerEntryDtoSchema>;

export const LedgerQuerySchema = z.object({
  q: z.string().max(500).optional(),
  projectId: z.uuid().optional(),
  scope: z.enum(['all', 'feature', 'decision', 'standing_order']).default('all'),
});
export type LedgerQuery = z.infer<typeof LedgerQuerySchema>;

export const LedgerListResponseSchema = z.object({ entries: z.array(LedgerEntryDtoSchema) });
export type LedgerListResponse = z.infer<typeof LedgerListResponseSchema>;

/** `POST /api/ledger`: the manager adds requirements and standing orders without a question prompting it. */
export const CreateLedgerEntryRequestSchema = z
  .object({
    scope: LedgerScope,
    projectId: z.uuid().optional(),
    cardId: z.uuid().optional(),
    title: z.string().min(1).max(300),
    body: z.string().min(1).max(20000),
    tags: z.array(z.string().min(1).max(60)).max(20).default([]),
  })
  .refine((v) => v.scope === 'standing_order' || !!v.projectId || !!v.cardId, {
    message: 'feature and decision entries need a projectId or a cardId',
    path: ['projectId'],
  });
export type CreateLedgerEntryRequest = z.infer<typeof CreateLedgerEntryRequestSchema>;

export const CreateLedgerEntryResponseSchema = z.object({ entry: LedgerEntryDtoSchema });
