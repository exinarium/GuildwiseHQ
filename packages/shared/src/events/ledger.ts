import { z } from 'zod';
import { defineEvent, Id } from './define.ts';

/** feature = requirements/decisions on a card or epic; decision = project ADR log; standing_order = rules every agent loads. */
export const LedgerScope = z.enum(['feature', 'decision', 'standing_order']);
export type LedgerScope = z.infer<typeof LedgerScope>;

export const ledgerEvents = [
  defineEvent(
    'LedgerEntryAdded',
    z.object({
      entryId: Id,
      scope: LedgerScope,
      /** Null for org-wide standing orders. */
      projectId: Id.optional(),
      cardId: Id.optional(),
      title: z.string().min(1).max(300),
      body: z.string().min(1).max(20000),
      tags: z.array(z.string()).default([]),
      sourceDeskItemId: Id.optional(),
      /** Set when the entry should also be written to the organization or project vault (M3 `vault.write`). */
      vaultPath: z.string().optional(),
    }),
  ),
  defineEvent('LedgerEntrySuperseded', z.object({ entryId: Id, supersededBy: Id })),
] as const;
