import { z } from 'zod';
import { InterestBodySchema } from '../interests/index.ts';
import { defineEvent, Id } from './define.ts';

/**
 * Interest events (docs/design/interests.md section 3), stream `interest-<id>`. Updates carry the full snapshot, like
 * `ScheduleUpdated`. The schedule the interest owns is changed by `Schedule*` events appended in the same transaction.
 */
export const interestEvents = [
  defineEvent('InterestCreated', InterestBodySchema),
  defineEvent('InterestUpdated', InterestBodySchema),
  defineEvent('InterestDeleted', z.object({ interestId: Id, keepSchedule: z.boolean().default(false) })),
] as const;
