import { z } from 'zod';
import { SizeUnitSchema } from '../projects/review-settings.ts';
import { SizeExceptionReason } from '../review/size-exception.ts';
import { defineEvent, Id, IsoDate } from './define.ts';
import { DeskActorSchema } from './desk.ts';

/** Size exception requests (appended to the project stream; the projection keeps `pr_size_exceptions`). */
export const sizeExceptionEvents = [
  defineEvent(
    'SizeExceptionRequested',
    z.object({
      sizeExceptionId: Id,
      orgId: Id,
      projectId: Id,
      repoId: Id,
      prReviewId: Id,
      chainPrReviewIds: z.array(Id).max(200),
      size: z.number().int().nonnegative(),
      budget: z.number().int().nonnegative(),
      unit: SizeUnitSchema,
      members: z.array(z.object({ changeId: z.string(), size: z.number().int().nonnegative() })).max(200),
      reason: SizeExceptionReason,
      dueAt: IsoDate,
      at: IsoDate,
      deskItemId: Id,
      ownerUserId: Id,
      requestedBy: DeskActorSchema,
      agentId: Id.optional(),
    }),
  ),
  defineEvent(
    'SizeExceptionApproved',
    z.object({ sizeExceptionId: Id, by: Id, note: z.string().max(2000).optional(), at: IsoDate }),
  ),
  defineEvent(
    'SizeExceptionRejected',
    z.object({ sizeExceptionId: Id, by: Id, note: z.string().max(2000).optional(), at: IsoDate }),
  ),
  defineEvent('SizeExceptionLapsed', z.object({ sizeExceptionId: Id, at: IsoDate })),
  defineEvent(
    'SizeExceptionWithdrawn',
    z.object({ sizeExceptionId: Id, cause: z.enum(['pr_closed', 'grew']), at: IsoDate }),
  ),
];
