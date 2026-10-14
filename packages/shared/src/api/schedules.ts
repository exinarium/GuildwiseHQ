import { z } from 'zod';
import {
  CardTemplateSchema,
  ScheduleActionSchema,
  ScheduleKind,
  ScheduleRunResultSchema,
  ScheduleRunTrigger,
  ScheduleTriggerSchema,
} from '../events/schedule.ts';
import { IsoTime } from './common.ts';

/** Presets offered by the Schedules page (cron, evaluated in the schedule's time zone). */
export const SCHEDULE_PRESETS = [
  { id: 'daily-0700', label: 'Daily at 07:00', cron: '0 7 * * *' },
  { id: 'daily-1800', label: 'Daily at 18:00', cron: '0 18 * * *' },
  { id: 'weekdays-0700', label: 'Weekdays at 07:00', cron: '0 7 * * 1-5' },
  { id: 'weekly-mon-0700', label: 'Mondays at 07:00', cron: '0 7 * * 1' },
  { id: 'weekdays-1800', label: 'Weekdays at 18:00', cron: '0 18 * * 1-5' },
  { id: 'weekly-fri-1600', label: 'Fridays at 16:00', cron: '0 16 * * 5' },
  { id: 'monthly-1st-0700', label: '1st of the month at 07:00', cron: '0 7 1 * *' },
  { id: 'every-15-min', label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { id: 'hourly', label: 'Every hour', cron: '0 * * * *' },
] as const;

export const DEFAULT_SCHEDULE_CRON = SCHEDULE_PRESETS[0].cron;

export const ScheduleDtoSchema = z.object({
  id: z.uuid(),
  /** Null: an organization-level schedule. */
  projectId: z.uuid().nullable(),
  projectKey: z.string().nullable(),
  projectName: z.string().nullable(),
  name: z.string(),
  kind: ScheduleKind,
  trigger: ScheduleTriggerSchema,
  action: ScheduleActionSchema,
  /** Cron triggers (and the poll cadence of `issue_labelled`): the expression and zone; null otherwise. */
  cron: z.string().nullable(),
  timezone: z.string().nullable(),
  /** Legacy shape: the card template of a `create_card` or `regression_run` action. */
  cardTemplate: CardTemplateSchema.optional(),
  enabled: z.boolean(),
  nextFireAt: IsoTime.nullable(),
  lastFiredAt: IsoTime.nullable(),
  /** The card the last run emitted. */
  lastCardId: z.uuid().nullable(),
  /** M9: consecutive failed fires (0 = healthy) and the last error; the schedule backs off between retries. */
  failCount: z.number().int().nonnegative().optional(),
  lastError: z.string().nullable().optional(),
  createdAt: IsoTime,
  ownerUserId: z.uuid().nullable().optional(),
  ownerName: z.string().nullable().optional(),
  /** An organization-level action: only the Owner and Admins create or change it. */
  orgLevel: z.boolean().optional(),
  /** The viewer may edit, pause, run and delete it. */
  canEdit: z.boolean().optional(),
  /** A webhook schedule has a signing secret (shown once, when created or rotated). */
  hasWebhookSecret: z.boolean().optional(),
  /** Incoming webhook: the URL to call (without the secret). */
  hookUrl: z.string().optional(),
  lastStatus: z.enum(['ok', 'failed', 'pending']).nullable().optional(),
  lastSummary: z.string().nullable().optional(),
});
export type ScheduleDto = z.infer<typeof ScheduleDtoSchema>;

/** A read-only row for the jobs the system runs by itself (repository hygiene, the BA's floor report). */
export const SystemScheduleDtoSchema = z.object({
  id: z.string(),
  kind: z.enum(['hygiene', 'floor_report']),
  name: z.string(),
  description: z.string(),
  /** "Every 24 h", "Daily at 08:00 (Africa/Johannesburg)". */
  when: z.string(),
  lastRunAt: IsoTime.nullable(),
  nextRunAt: IsoTime.nullable(),
  /** Where it is configured (an app path). */
  configureAt: z.string(),
});
export type SystemScheduleDto = z.infer<typeof SystemScheduleDtoSchema>;

export const SchedulesQuerySchema = z.object({ projectId: z.uuid().optional() });
export const SchedulesResponseSchema = z.object({
  schedules: z.array(ScheduleDtoSchema),
  system: z.array(SystemScheduleDtoSchema).default([]),
});

/**
 * `POST /api/schedules`: `{name, trigger, action}`. The old shape (`projectId`, `kind`, `cron`, `timezone`, `cardTemplate`)
 * is still accepted and means a cron trigger with a `create_card` (or, for `kind: "regression"`, a `regression_run`)
 * action. Creating a feed schedule is refused (400 `use_interests`). Invalid cron expressions or zones are a 400.
 */
export const CreateScheduleRequestSchema = z.object({
  name: z.string().min(1).max(120),
  enabled: z.boolean().default(true),
  trigger: ScheduleTriggerSchema.optional(),
  action: ScheduleActionSchema.optional(),
  /** Legacy shape. */
  projectId: z.uuid().optional(),
  kind: ScheduleKind.optional(),
  cron: z.string().min(1).max(100).optional(),
  timezone: z.string().min(1).max(60).optional(),
  cardTemplate: CardTemplateSchema.optional(),
});
export type CreateScheduleRequest = z.infer<typeof CreateScheduleRequestSchema>;

export const PatchScheduleRequestSchema = z
  .object({
    name: z.string().min(1).max(120),
    cron: z.string().min(1).max(100),
    timezone: z.string().min(1).max(60),
    cardTemplate: CardTemplateSchema,
    enabled: z.boolean(),
    trigger: ScheduleTriggerSchema,
    action: ScheduleActionSchema,
  })
  .partial();
export type PatchScheduleRequest = z.infer<typeof PatchScheduleRequestSchema>;

/** The create response: the schedule, and for a webhook its signing secret (shown this once). */
export const CreateScheduleResponseSchema = ScheduleDtoSchema.extend({
  webhookSecret: z.string().optional(),
  /** Incoming webhook: the URL with the secret in it, shown this once (also after a rotate). */
  hookUrlWithSecret: z.string().optional(),
});
export type CreateScheduleResponse = z.infer<typeof CreateScheduleResponseSchema>;

/** `POST /api/schedules/:id/run` and `POST /api/projects/:id/feed/run`: the card the run emitted (when it emitted one). */
export const RunScheduleResponseSchema = z.object({
  cardId: z.uuid().nullable().optional(),
  ref: z.string().nullable().optional(),
  runId: z.uuid().optional(),
  summary: z.string().optional(),
  status: z.enum(['ok', 'failed', 'pending']).optional(),
});
export type RunScheduleResponse = z.infer<typeof RunScheduleResponseSchema>;

/** `POST /api/projects/:id/feed/run`: run the project's feed now (from a schedule's template, else a default one). */
export const RunFeedRequestSchema = z.object({ scheduleId: z.uuid().optional() });
export type RunFeedRequest = z.infer<typeof RunFeedRequestSchema>;

export const ScheduleRunDtoSchema = z.object({
  id: z.uuid(),
  scheduleId: z.uuid(),
  trigger: ScheduleRunTrigger,
  label: z.string().nullable(),
  status: z.enum(['ok', 'failed', 'pending']),
  summary: z.string(),
  error: z.string().nullable(),
  result: ScheduleRunResultSchema.nullable(),
  /** Deliveries only: what is sent where, and the tries so far. */
  delivery: z.object({ kind: z.enum(['webhook', 'email']), target: z.string() }).nullable(),
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: IsoTime.nullable(),
  startedAt: IsoTime,
  finishedAt: IsoTime.nullable(),
  attemptLog: z.array(
    z.object({
      attempt: z.number().int().positive(),
      at: IsoTime,
      ok: z.boolean(),
      httpStatus: z.number().int().nullable(),
      error: z.string().nullable(),
      durationMs: z.number().int().nullable(),
    }),
  ),
});
export type ScheduleRunDto = z.infer<typeof ScheduleRunDtoSchema>;
export const ScheduleRunsResponseSchema = z.object({ runs: z.array(ScheduleRunDtoSchema) });

/** `POST /api/schedules/:id/test`: one signed test delivery of a webhook (or e-mail) schedule, not retried. */
export const ScheduleTestResponseSchema = z.object({
  ok: z.boolean(),
  httpStatus: z.number().int().nullable(),
  error: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  runId: z.uuid(),
});
export type ScheduleTestResponse = z.infer<typeof ScheduleTestResponseSchema>;

/** `POST /api/schedules/:id/rotate-secret`. */
export const RotateSecretResponseSchema = z.object({
  webhookSecret: z.string(),
  /** Incoming webhook: the URL with the new secret in it. */
  hookUrlWithSecret: z.string().optional(),
});
