import { z } from 'zod';
import { OwnerPendingKindSchema } from '../review/owner-pending.ts';
import { defineEvent, Id, IsoDate } from './define.ts';

/**
 * Owner-pending timers (stream `owner-pending-<timerId>`; project scope when the item has a project, else org scope). The
 * timer only reminds: none of these events changes the state of the item it watches.
 */
export const ownerPendingEvents = [
  defineEvent(
    'OwnerPendingRegistered',
    z.object({
      timerId: Id,
      kind: OwnerPendingKindSchema,
      orgId: Id,
      projectId: Id.optional(),
      cardId: Id.optional(),
      subjectId: z.string().min(1).max(200),
      ownerUserId: Id,
      title: z.string().min(1).max(200),
      url: z.string().max(400).optional(),
      startedAt: IsoDate,
      dueAt: IsoDate,
      timezone: z.string().min(1).max(64),
    }),
  ),
  defineEvent(
    'OwnerPendingReminded',
    z.object({
      timerId: Id,
      /** The due instant this reminder is for (the projector applies it only while it matches). */
      firedFor: IsoDate,
      deskItemId: Id,
      recipients: z.array(Id),
    }),
  ),
  defineEvent(
    'OwnerPendingResolved',
    z.object({
      timerId: Id,
      reason: z.enum(['owner_acted', 'closed']),
      by: Id.optional(),
    }),
  ),
];
