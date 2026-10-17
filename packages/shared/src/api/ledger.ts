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
  /** 1 until the first edit (backlog #74). */
  version: z.number().int().default(1),
  editedAt: IsoTime.nullable().default(null),
  editedByName: z.string().nullable().default(null),
  /** Set once the entry was retired (never injected into prompts or found by a search). */
  retiredAt: IsoTime.nullable().default(null),
  retiredReason: z.string().nullable().default(null),
  /** Live orders that this one may contradict (flagged on save). */
  conflictsWith: z.array(z.uuid()).default([]),
  /** The caller may retire this entry. */
  canRetire: z.boolean().default(false),
  /** The caller may edit this entry (a live standing order they may manage). */
  canEdit: z.boolean().default(false),
  /** Full-text rank when a query was given. */
  rank: z.number().optional(),
});
export type LedgerEntryDto = z.infer<typeof LedgerEntryDtoSchema>;

export const LedgerQuerySchema = z.object({
  q: z.string().max(500).optional(),
  projectId: z.uuid().optional(),
  scope: z.enum(['all', 'feature', 'decision', 'standing_order']).default('all'),
  /** Also list retired entries (the web page greys them out). */
  includeRetired: z.enum(['true', 'false']).optional(),
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
    /**
     * What to do when a near-duplicate standing order exists: `refuse` (default, 409 with a pointer to the existing
     * entry) or `merge` (the existing entry takes the new wording; nothing new is saved).
     */
    onDuplicate: z.enum(['refuse', 'merge']).optional(),
  })
  .refine((v) => v.scope === 'standing_order' || !!v.projectId || !!v.cardId, {
    message: 'feature and decision entries need a projectId or a cardId',
    path: ['projectId'],
  });
export type CreateLedgerEntryRequest = z.infer<typeof CreateLedgerEntryRequestSchema>;

export const CreateLedgerEntryResponseSchema = z.object({
  entry: LedgerEntryDtoSchema,
  /** True when the entry merged into an existing near-duplicate instead of being added. */
  merged: z.boolean().optional(),
  /** Live entries this standing order may contradict; it was saved and one desk item raised. */
  conflictsWith: z.array(z.uuid()).optional(),
});

/** `POST /api/ledger/:id/retire`: withdraw an entry with a reason (optionally naming the entry that replaces it). */
export const RetireLedgerEntryRequestSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
  supersededBy: z.uuid().optional(),
});
export type RetireLedgerEntryRequest = z.infer<typeof RetireLedgerEntryRequestSchema>;

/** `PATCH /api/ledger/:id`: edit a live standing order. At least one of title, body, tags. */
export const EditLedgerEntryRequestSchema = z
  .object({
    title: z.string().min(1).max(300).optional(),
    body: z.string().min(1).max(20000).optional(),
    tags: z.array(z.string().min(1).max(60)).max(20).optional(),
  })
  .refine((v) => v.title !== undefined || v.body !== undefined || v.tags !== undefined, {
    message: 'give a new title, text or tags',
  });
export type EditLedgerEntryRequest = z.infer<typeof EditLedgerEntryRequestSchema>;

/** One wording of a standing order, newest first; `current` is the one agents are briefed with. */
export const LedgerVersionDtoSchema = z.object({
  version: z.number().int(),
  title: z.string(),
  body: z.string(),
  tags: z.array(z.string()),
  /** When this wording came into force, and who wrote it. */
  savedAt: IsoTime,
  savedByName: z.string().nullable(),
  current: z.boolean(),
});
export type LedgerVersionDto = z.infer<typeof LedgerVersionDtoSchema>;

export const LedgerHistoryResponseSchema = z.object({
  entry: LedgerEntryDtoSchema,
  versions: z.array(LedgerVersionDtoSchema),
});
export type LedgerHistoryResponse = z.infer<typeof LedgerHistoryResponseSchema>;

export const EditLedgerEntryResponseSchema = z.object({ entry: LedgerEntryDtoSchema });
