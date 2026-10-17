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
  /**
   * A standing order was edited in place (backlog #74). Carries the full new wording; the projection keeps the previous
   * version in `ledger_entry_versions`, so the history stays visible.
   */
  defineEvent(
    'LedgerEntryEdited',
    z.object({
      entryId: Id,
      title: z.string().min(1).max(300),
      body: z.string().min(1).max(20000),
      tags: z.array(z.string()).default([]),
    }),
  ),
  defineEvent('LedgerEntrySuperseded', z.object({ entryId: Id, supersededBy: Id })),
  /**
   * An entry was withdrawn (a one-off order, a duplicate, a rule replaced by a setting). A retired entry is kept for the
   * record but is never injected into a prompt and never found by a search. `supersededBy` names the entry that replaces
   * it when there is one. `by` is the actor kind as written ('owner', 'ba', 'ceo', 'system') for the history.
   */
  defineEvent(
    'LedgerEntryRetired',
    z.object({
      entryId: Id,
      reason: z.string().min(1).max(1000),
      supersededBy: Id.optional(),
      by: z.string().max(40).optional(),
    }),
  ),
  /**
   * A saved standing order may contradict a live one (same subject, opposing instruction). The order is kept and flagged;
   * `conflictsWith` names the entries it may contradict and `reason` the heuristic that fired.
   */
  defineEvent(
    'LedgerEntryFlagged',
    z.object({ entryId: Id, conflictsWith: z.array(Id).min(1).max(10), reason: z.string().max(500) }),
  ),
] as const;
