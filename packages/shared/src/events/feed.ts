import { z } from 'zod';
import { DigestItemSchema, FeedVerdictSchema } from '../feed/index.ts';
import { defineEvent, Id } from './define.ts';

/** Feed events (docs/ARCHITECTURE.md section 5.2, M5). */
export const feedEvents = [
  /**
   * A curator's digest was accepted. `items` are the new, non-duplicate items (at most the card's maximum per kind) in
   * the order they are appended to the project's running list. `nothingQualified` means nothing was logged.
   */
  defineEvent(
    'DigestPosted',
    z.object({
      cardId: Id,
      projectId: Id,
      items: z.array(DigestItemSchema),
      nothingQualified: z.boolean(),
      /** Candidates left out as duplicates (seen URL or same story). */
      duplicatesDropped: z.number().int().nonnegative().default(0),
      /** Candidates left out because of the per-kind maximum. */
      overMaximumDropped: z.number().int().nonnegative().default(0),
      /** The grouped rating item on the desk (absent when nothing qualified). */
      deskItemId: Id.optional(),
    }),
  ),
  defineEvent(
    'ItemRated',
    z.object({
      itemId: Id,
      projectId: Id,
      verdict: FeedVerdictSchema,
      reason: z.string().max(1000).optional(),
      ratedBy: Id,
    }),
  ),
  /** A curator suggested a rule from a pattern of verdicts; a desk approval item (`subkind 'taste_rule'`) carries it. */
  defineEvent(
    'TasteRuleProposed',
    z.object({
      projectId: Id,
      deskItemId: Id,
      rule: z.string().min(1).max(500),
      evidenceItemIds: z.array(Id).default([]),
    }),
  ),
] as const;
