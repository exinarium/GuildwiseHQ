import { z } from 'zod';
import { defineEvent, Id } from './define.ts';

/** feature = requirements/decisions on a card or epic; decision = project ADR log; standing_order = rules every agent loads. */
export const LedgerScope = z.enum(['feature', 'decision', 'standing_order']);
export type LedgerScope = z.infer<typeof LedgerScope>;

/** A calendar date, YYYY-MM-DD (no time, no zone). */
export const CalendarDate = z.iso.date();

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
      /** Optional date the owner wants to look at this entry again (release 1.4.0). */
      reviewDate: CalendarDate.optional(),
      /** Set only by a rule pack install (business mode): which pack rule this entry is. */
      rulePack: z
        .object({
          packId: z.string().min(1).max(80),
          ruleId: z.string().min(1).max(80),
          packVersion: z.number().int().positive(),
        })
        .optional(),
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
  /**
   * The review date of an entry was set, changed or cleared (`reviewDate: null`). `confirmed`: the owner reviewed a due
   * entry and kept it (with a new date or none). Wording, version and full-power authority are not touched.
   */
  defineEvent(
    'LedgerEntryReviewDateSet',
    z.object({ entryId: Id, reviewDate: CalendarDate.nullable(), confirmed: z.boolean().default(false) }),
  ),
  /** A rule pack was installed in an organization (business mode). */
  defineEvent(
    'RulePackInstalled',
    z.object({
      packId: z.string().min(1).max(80),
      packVersion: z.number().int().positive(),
      /** New entries. */
      added: z.array(Id).max(200),
      /** Already installed (edited or not). */
      kept: z.array(Id).max(200).default([]),
      /** Covered by the organization's own rule: nothing added. */
      skipped: z
        .array(z.object({ ruleId: z.string(), existingId: Id }))
        .max(200)
        .default([]),
    }),
  ),
  /** A rule pack was removed: unedited rules retired, edited ones stay as the organization's own. */
  defineEvent(
    'RulePackRemoved',
    z.object({
      packId: z.string().min(1).max(80),
      retired: z.array(Id).max(200),
      kept: z.array(Id).max(200).default([]),
    }),
  ),
] as const;
