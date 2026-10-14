import { z } from 'zod';
import { defineEvent, Id } from './define.ts';

/**
 * Manual QA (docs/design/manual-qa.md). After Finalize a card may go to a person to test: `qa_steps` (an agent writes
 * the test steps) and `manual_qa` (the person passes, skips, sends back or hands over). `CardFinalized` moves the card
 * into the QA stages in the same append as `QaOpened`.
 */
export const QaAssigneeSource = z.enum(['starter', 'owner', 'project_owner', 'reassigned']);
export type QaAssigneeSource = z.infer<typeof QaAssigneeSource>;

export const qaEvents = [
  /** The card entered manual QA; `deskItemId` is the desk item addressed to the assignee. */
  defineEvent(
    'QaOpened',
    z.object({
      cardId: Id,
      assigneeUserId: Id,
      source: QaAssigneeSource,
      /** The first QA stage: `qa_steps` when an agent writes the steps, else `manual_qa`. */
      toStage: z.string().min(1),
      deskItemId: Id,
    }),
  ),
  /** The agent's test steps (markdown), posted on the card; the card now waits for the person. */
  defineEvent(
    'QaStepsPosted',
    z.object({ cardId: Id, steps: z.string().min(1).max(40000), agentId: Id.optional() }),
  ),
  /** Handed to another active member of the project; the old desk item is replaced by a new one. */
  defineEvent(
    'QaAssigned',
    z.object({
      cardId: Id,
      assigneeUserId: Id,
      previousUserId: Id.optional(),
      by: Id,
      deskItemId: Id,
      previousDeskItemId: Id.optional(),
    }),
  ),
  /** Accepted: the held outgoing ticket comment (if any) is released and the card is done. */
  defineEvent(
    'QaPassed',
    z.object({ cardId: Id, by: Id, note: z.string().max(5000).optional(), deskItemId: Id.optional() }),
  ),
  /** Not tested: same as passed, recorded as skipped. */
  defineEvent(
    'QaSkipped',
    z.object({ cardId: Id, by: Id, reason: z.string().max(5000).optional(), deskItemId: Id.optional() }),
  ),
  /** Failed: the card goes back to rework with the comment for the builder; the outgoing comment stays held. */
  defineEvent(
    'QaSentBack',
    z.object({
      cardId: Id,
      by: Id,
      comment: z.string().min(1).max(10000),
      toStage: z.string().min(1),
      deskItemId: Id.optional(),
    }),
  ),
] as const;
