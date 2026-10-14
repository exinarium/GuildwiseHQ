import { z } from 'zod';
import { defineEvent, Id } from './define.ts';
import { ExternalSystem } from './intake.ts';

/** Batch intake (#63): the owner hands the BA a list of tickets; one item and one `batch_intake` BA task per ticket. */
export const intakeBatchEvents = [
  defineEvent(
    'IntakeBatchCreated',
    z.object({
      batchId: Id,
      createdBy: Id,
      /** Default project for every ticket; absent: the BA maps each. */
      projectId: Id.optional(),
      note: z.string().max(5000).optional(),
      items: z.array(
        z.object({
          itemId: Id,
          position: z.number().int(),
          system: ExternalSystem,
          key: z.string().min(1).max(200),
          url: z.string().max(1000).optional(),
          /** The BA task queued for the item (separate `BaTaskQueued`); absent for a skipped item. */
          taskId: Id.optional(),
          /** Set when the ticket already has cards or an intake: the item starts `skipped` with this reason. */
          skipReason: z.string().max(1000).optional(),
          existingCardRefs: z.array(z.string()).optional(),
        }),
      ),
    }),
  ),
  /** The item's intake (the ticket's chat thread and card links) was created by the BA's first card verb. */
  defineEvent('IntakeBatchItemLinked', z.object({ batchId: Id, itemId: Id, intakeId: Id })),
  /** The BA asked the owner: the item waits on a desk question. */
  defineEvent(
    'IntakeBatchItemWaiting',
    z.object({ batchId: Id, itemId: Id, deskItemId: Id, question: z.string().max(4000) }),
  ),
  /** The owner answered (or the owner retried a failed item): a new BA task for the same item. */
  defineEvent(
    'IntakeBatchItemRequeued',
    z.object({
      batchId: Id,
      itemId: Id,
      taskId: Id,
      reason: z.enum(['answered', 'retry']),
      answer: z.string().max(20000).optional(),
    }),
  ),
  defineEvent(
    'IntakeBatchItemResolved',
    z.object({
      batchId: Id,
      itemId: Id,
      outcome: z.enum(['done', 'skipped', 'failed', 'cancelled']),
      cardRefs: z.array(z.string()).default([]),
      summary: z.string().max(20000).optional(),
      reason: z.string().max(2000).optional(),
    }),
  ),
  /** Queued and waiting items are cancelled; items a BA is working on finish. */
  defineEvent('IntakeBatchCancelled', z.object({ batchId: Id, cancelledBy: Id })),
] as const;
