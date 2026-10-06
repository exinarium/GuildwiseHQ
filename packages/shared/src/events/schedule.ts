import { z } from 'zod';
import { defineEvent, Id, IsoDate } from './define.ts';

export const ScheduleKind = z.enum(['feed', 'regression', 'card']);
export type ScheduleKind = z.infer<typeof ScheduleKind>;

/** What a scheduled run puts on the card it emits. */
export const CardTemplateSchema = z.object({
  title: z.string().min(1).max(300),
  /** Card type; defaults to the project workflow's first card type. */
  cardType: z.string().min(1).optional(),
  fields: z.record(z.string(), z.unknown()).default({}),
  priority: z.number().int().min(1).max(9).optional(),
});
export type CardTemplate = z.infer<typeof CardTemplateSchema>;

const ScheduleBody = z.object({
  scheduleId: Id,
  projectId: Id,
  name: z.string().min(1).max(120),
  kind: ScheduleKind,
  /** Standard 5-field cron expression, evaluated in `timezone`. */
  cron: z.string().min(1).max(100),
  /** IANA time zone, e.g. `Africa/Johannesburg`. */
  timezone: z.string().min(1).max(60),
  cardTemplate: CardTemplateSchema,
  enabled: z.boolean(),
  /** The next time the schedule fires (computed by the server from `cron` and `timezone`). */
  nextFireAt: IsoDate.nullable(),
});

/** Scheduler events (docs/ARCHITECTURE.md section 5.2 and 10, M5). */
export const scheduleEvents = [
  /** `interestId`: the interest that owns this schedule (docs/design/interests.md). */
  defineEvent('ScheduleCreated', ScheduleBody.extend({ interestId: Id.optional() })),
  defineEvent('ScheduleUpdated', ScheduleBody),
  /** Adopts a schedule into an interest, or (null) unlinks it. Linking back-fills `cards.interest_id` of its earlier cards. */
  defineEvent('ScheduleLinked', z.object({ scheduleId: Id, interestId: Id.nullable() })),
  defineEvent('ScheduleDeleted', z.object({ scheduleId: Id })),
  /** Always appended together with the `CardCreated{scheduled:true, origin:'schedule'}` it causes. */
  defineEvent(
    'ScheduleFired',
    z.object({ scheduleId: Id, cardId: Id, firedFor: IsoDate, nextFireAt: IsoDate.nullable() }),
  ),
  /**
   * A due fire that did not happen because the organization is not running (suspended or cancelled) or the feature is
   * switched off: recorded, not retried; the next fire is the next one on the cron.
   */
  defineEvent(
    'ScheduleSkipped',
    z.object({
      scheduleId: Id,
      firedFor: IsoDate,
      nextFireAt: IsoDate.nullable(),
      reason: z.enum(['org_suspended', 'feature_disabled']),
    }),
  ),
  /** The manager ran a feed (or schedule) right now; same card path as `ScheduleFired`. */
  defineEvent(
    'FeedRunRequested',
    z.object({ projectId: Id, scheduleId: Id.optional(), cardId: Id, requestedBy: Id }),
  ),
] as const;
