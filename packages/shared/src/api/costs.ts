import { z } from 'zod';
import { IsoTime } from './common.ts';

/** What was used and what it cost. Money is in micro-units of the organization's currency (see `costs/index.ts`). */
export const SpendTotalsSchema = z.object({
  costMicros: z.number().int().nonnegative(),
  shifts: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
});
export type SpendTotals = z.infer<typeof SpendTotalsSchema>;

export const BudgetStateSchema = z.enum(['none', 'ok', 'warning', 'paused', 'overridden']);

/** A project's monthly budget and where this month stands. Amounts are null for a guest (the state still shows). */
export const BudgetDtoSchema = z.object({
  state: BudgetStateSchema,
  /** `YYYY-MM` in the organization's time zone. */
  month: z.string(),
  monthlyMicros: z.number().int().nullable(),
  spentMicros: z.number().int().nullable(),
  percent: z.number().nullable(),
  /** The budget starts again at this instant (the 1st, organization time zone). */
  resetsAt: IsoTime,
  currency: z.string(),
  /** Owner or Admin of the project's organization: may set the budget or override a pause. */
  canEdit: z.boolean(),
});
export type BudgetDto = z.infer<typeof BudgetDtoSchema>;

/** `PUT /api/projects/:id/budget`: the monthly budget in whole currency units with cents, or null to remove it. */
export const SetBudgetRequestSchema = z.object({
  monthly: z.number().positive().max(1_000_000_000).nullable(),
});
export type SetBudgetRequest = z.infer<typeof SetBudgetRequestSchema>;

/** `PUT /api/costs/settings`. */
export const CostSettingsSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  /** Units of `currency` per 1 USD (costs are recorded at USD list prices). */
  usdRate: z.number().positive().max(1_000_000),
  /** The organization's time zone (its Owner's reporting time zone): the month and the day buckets follow it. */
  timezone: z.string(),
  canEdit: z.boolean(),
});
export type CostSettings = z.infer<typeof CostSettingsSchema>;
export const UpdateCostSettingsRequestSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/, 'a three-letter currency code such as USD or EUR'),
  usdRate: z.number().positive().max(1_000_000),
});
export type UpdateCostSettingsRequest = z.infer<typeof UpdateCostSettingsRequestSchema>;

/** One price of the table the costs are computed with, per million tokens in USD. */
export const ModelPriceDtoSchema = z.object({
  match: z.string(),
  label: z.string(),
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
});

export const CostsQuerySchema = z.object({
  /** Local dates in the organization's time zone, inclusive; default the current month. */
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  projectId: z.uuid().optional(),
});
export type CostsQuery = z.infer<typeof CostsQuerySchema>;

export const CostsReportSchema = z.object({
  currency: z.string(),
  timezone: z.string(),
  from: z.string(),
  to: z.string(),
  totals: SpendTotalsSchema,
  /** Spend with no project: chats without a card, BA work outside a project. */
  overhead: SpendTotalsSchema,
  byProject: z.array(
    SpendTotalsSchema.extend({
      projectId: z.uuid(),
      key: z.string(),
      name: z.string(),
      /** The interest this hidden backing project belongs to. */
      interestId: z.uuid().nullable(),
      budget: BudgetDtoSchema.nullable(),
    }),
  ),
  byAgent: z.array(SpendTotalsSchema.extend({ agentId: z.uuid(), name: z.string(), roleKey: z.string() })),
  byModel: z.array(SpendTotalsSchema.extend({ model: z.string(), family: z.string() })),
  byDay: z.array(SpendTotalsSchema.extend({ date: z.string() })),
  prices: z.array(ModelPriceDtoSchema),
  settings: CostSettingsSchema,
});
export type CostsReport = z.infer<typeof CostsReportSchema>;

/** A spend line for one agent, phase, card or interest (`spend` on their DTOs): this month and all time. */
export const SpendBriefSchema = z.object({
  monthMicros: z.number().int().nonnegative(),
  totalMicros: z.number().int().nonnegative(),
  currency: z.string(),
});
export type SpendBrief = z.infer<typeof SpendBriefSchema>;
