import { z } from 'zod';
import type { CardType } from '../cards/types.ts';

/**
 * Value report (backlog #37). The human time a card would have taken is an estimate by card type, adjustable per
 * organization. These are the defaults, in hours; `feed` and `regression` cards are not counted as work.
 */
export const DEFAULT_HOURS_PER_CARD: Record<CardType, number> = {
  feature: 8,
  bug: 3,
  support: 1,
  refactor: 5,
  docs: 2,
  research: 4,
  feed: 0,
  regression: 0,
  enquiry: 0.5,
  follow_up: 0.25,
  document_request: 0.25,
  reminder: 0.1,
  report: 2,
  quote: 1,
};
/** The card types the Costs page lets an organization estimate (feed and regression cards are not counted). */
export const VALUE_CARD_TYPES = ['feature', 'bug', 'support', 'refactor', 'docs', 'research'] as const;
/** The value of one human hour, in USD, until the organization sets its own. */
export const DEFAULT_HOURLY_VALUE_USD = 40;

export const ValueSettingsSchema = z.object({
  hoursByType: z.record(z.string(), z.number().min(0).max(1000)),
  /** Whole currency units per human hour; null = `DEFAULT_HOURLY_VALUE_USD` converted to the organization's currency. */
  hourlyValue: z.number().min(0).max(1_000_000).nullable(),
});
export type ValueSettings = z.infer<typeof ValueSettingsSchema>;

export const UpdateValueSettingsRequestSchema = z.object({
  hoursByType: z.record(z.string(), z.number().min(0).max(1000)),
  hourlyValue: z.number().min(0).max(1_000_000).nullable(),
});
export type UpdateValueSettingsRequest = z.infer<typeof UpdateValueSettingsRequestSchema>;

export const ValueQuerySchema = z.object({
  /** `YYYY-MM` in the organization's time zone; default the current month. */
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
  projectId: z.uuid().optional(),
});
export type ValueQuery = z.infer<typeof ValueQuerySchema>;

export const ValuePeriodSchema = z.object({
  month: z.string(),
  cards: z.number().int().nonnegative(),
  /** Estimated human hours the finished cards would have taken. */
  hours: z.number().nonnegative(),
  /** What the shifts cost, in micro-units of the organization's currency. */
  usageMicros: z.number().int().nonnegative(),
  /** hours x hourly value, in micro-units. */
  valueMicros: z.number().int().nonnegative(),
  /** value / usage, or null when nothing was spent. */
  returnX: z.number().nullable(),
  /** Hours the agents actually worked (shift time on cards). */
  agentHours: z.number().nonnegative(),
  reworkRounds: z.number().int().nonnegative(),
  /** Average days from creation to done, or null without cards. */
  avgDaysToDone: z.number().nullable(),
});
export type ValuePeriod = z.infer<typeof ValuePeriodSchema>;

export const NextActionSchema = z.object({
  kind: z.enum(['stuck_card', 'failing_agent', 'idle_project']),
  title: z.string(),
  detail: z.string(),
  /** The card ref, project key or agent id this is about, for a link. */
  ref: z.string().nullable(),
});
export type NextAction = z.infer<typeof NextActionSchema>;

export const ValueReportSchema = z.object({
  currency: z.string(),
  timezone: z.string(),
  current: ValuePeriodSchema,
  previous: ValuePeriodSchema,
  byType: z.array(z.object({ cardType: z.string(), cards: z.number().int(), hours: z.number() })),
  byProject: z.array(
    z.object({
      projectId: z.uuid(),
      key: z.string(),
      name: z.string(),
      cards: z.number().int(),
      hours: z.number(),
      usageMicros: z.number().int(),
    }),
  ),
  nextActions: z.array(NextActionSchema),
  settings: ValueSettingsSchema.extend({ canEdit: z.boolean(), hourlyValueEffective: z.number() }),
});
export type ValueReport = z.infer<typeof ValueReportSchema>;
