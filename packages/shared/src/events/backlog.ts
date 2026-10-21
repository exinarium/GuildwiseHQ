import { z } from 'zod';
import { BacklogPriority, BacklogTag } from '../backlog/index.ts';
import { defineEvent, Id } from './define.ts';

/**
 * Project backlog (stream `backlog-<itemId>`, project scope). Wanted work that is not in development: none of these
 * events creates a card, a desk item or agent work. `BacklogSuggestionsReported` is on `ceo-<orgId>` (org scope).
 */
export const backlogEvents = [
  defineEvent(
    'BacklogItemAdded',
    z.object({
      itemId: Id,
      projectId: Id,
      title: z.string().min(1).max(300),
      description: z.string().max(8000).default(''),
      priority: BacklogPriority,
      tags: z.array(BacklogTag).max(20),
      flagged: z.boolean(),
      source: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('owner'), userId: Id }),
        z.object({
          kind: z.literal('agent'),
          agentId: Id,
          agentName: z.string(),
          shiftId: Id,
          cardId: Id.optional(),
          cardRef: z.string().optional(),
        }),
      ]),
    }),
  ),
  defineEvent(
    'BacklogItemEdited',
    z.object({
      itemId: Id,
      title: z.string().min(1).max(300).optional(),
      description: z.string().max(8000).optional(),
      priority: BacklogPriority.optional(),
      tags: z.array(BacklogTag).max(20).optional(),
    }),
  ),
  defineEvent('BacklogItemFlagged', z.object({ itemId: Id, flagged: z.boolean() })),
  defineEvent('BacklogItemDropped', z.object({ itemId: Id })),
  /** Send to BA: the item became a card (written in the same transaction as the card). */
  defineEvent('BacklogItemSent', z.object({ itemId: Id, cardId: Id, cardRef: z.string() })),
  /** The daily report listed these agent suggestions. */
  defineEvent(
    'BacklogSuggestionsReported',
    z.object({ orgId: Id, deskItemId: Id, itemIds: z.array(Id).max(200) }),
  ),
] as const;
