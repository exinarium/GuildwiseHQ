import { z } from 'zod';
import { CardTemplateSchema, ScheduleKind } from '../events/schedule.ts';
import { IsoTime } from './common.ts';

/** Presets offered by the Schedules page (cron, evaluated in the schedule's time zone). */
export const SCHEDULE_PRESETS = [
  { id: 'daily-0700', label: 'Daily at 07:00', cron: '0 7 * * *' },
  { id: 'daily-1800', label: 'Daily at 18:00', cron: '0 18 * * *' },
  { id: 'weekdays-0700', label: 'Weekdays at 07:00', cron: '0 7 * * 1-5' },
  { id: 'weekly-mon-0700', label: 'Mondays at 07:00', cron: '0 7 * * 1' },
  { id: 'hourly', label: 'Every hour', cron: '0 * * * *' },
] as const;

export const DEFAULT_SCHEDULE_CRON = SCHEDULE_PRESETS[0].cron;

export const ScheduleDtoSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  projectKey: z.string(),
  projectName: z.string(),
  name: z.string(),
  kind: ScheduleKind,
  cron: z.string(),
  timezone: z.string(),
  cardTemplate: CardTemplateSchema,
  enabled: z.boolean(),
  nextFireAt: IsoTime.nullable(),
  lastFiredAt: IsoTime.nullable(),
  /** The card the last run emitted. */
  lastCardId: z.uuid().nullable(),
  /** M9: consecutive failed fires (0 = healthy) and the last error; the schedule backs off between retries. */
  failCount: z.number().int().nonnegative().optional(),
  lastError: z.string().nullable().optional(),
  createdAt: IsoTime,
  /** The interest that owns this schedule (locked for direct edits), when linked. */
  interestId: z.uuid().nullable().optional(),
  interestName: z.string().nullable().optional(),
});
export type ScheduleDto = z.infer<typeof ScheduleDtoSchema>;

export const SchedulesQuerySchema = z.object({ projectId: z.uuid().optional() });
export const SchedulesResponseSchema = z.object({ schedules: z.array(ScheduleDtoSchema) });

/** `POST /api/schedules`. The cron is a standard 5-field expression; invalid expressions or zones are a 400. */
export const CreateScheduleRequestSchema = z.object({
  projectId: z.uuid(),
  name: z.string().min(1).max(120),
  kind: ScheduleKind.default('feed'),
  cron: z.string().min(1).max(100).default('0 7 * * *'),
  timezone: z.string().min(1).max(60).default('UTC'),
  cardTemplate: CardTemplateSchema,
  enabled: z.boolean().default(true),
});
export type CreateScheduleRequest = z.infer<typeof CreateScheduleRequestSchema>;

export const PatchScheduleRequestSchema = z
  .object({
    name: z.string().min(1).max(120),
    cron: z.string().min(1).max(100),
    timezone: z.string().min(1).max(60),
    cardTemplate: CardTemplateSchema,
    enabled: z.boolean(),
  })
  .partial();
export type PatchScheduleRequest = z.infer<typeof PatchScheduleRequestSchema>;

/** `POST /api/schedules/:id/run` and `POST /api/projects/:id/feed/run`: the card the run emitted. */
export const RunScheduleResponseSchema = z.object({ cardId: z.uuid(), ref: z.string() });
export type RunScheduleResponse = z.infer<typeof RunScheduleResponseSchema>;

/** `POST /api/projects/:id/feed/run`: run the project's feed now (from a schedule's template, else a default one). */
export const RunFeedRequestSchema = z.object({ scheduleId: z.uuid().optional() });
export type RunFeedRequest = z.infer<typeof RunFeedRequestSchema>;
