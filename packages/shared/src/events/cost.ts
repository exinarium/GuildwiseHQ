import { z } from 'zod';
import { defineEvent, Id } from './define.ts';

const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, 'a three-letter currency code such as USD or EUR');

/**
 * Cost tracking and budgets. Spend itself is not an event: it is derived from `ShiftEnded` (usage, model) when the
 * projector writes `shift_costs`. These events carry the settings and the threshold history.
 */
export const costEvents = [
  /** The Owner or an Admin set the organization's display currency and the USD exchange rate. */
  defineEvent(
    'OrgCostSettingsChanged',
    z.object({ orgId: Id, currency: CurrencyCode, usdRate: z.number().positive().max(1_000_000), by: Id }),
  ),
  /**
   * An Owner or Admin set (or removed, with null) a project's monthly budget in micro-units of the organization's
   * currency. `clearWarned` / `clearPaused` are computed by the command from the month's spend so a raised budget
   * lifts the pause and re-arms the warning, and a replay needs no spend to reproduce it.
   */
  defineEvent(
    'ProjectBudgetSet',
    z.object({
      projectId: Id,
      monthlyMicros: z.number().int().positive().nullable(),
      by: Id,
      clearWarned: z.boolean().default(false),
      clearPaused: z.boolean().default(false),
    }),
  ),
  /** The month's spend reached the 80% or 100% threshold (once per month and level). */
  defineEvent(
    'ProjectBudgetThresholdReached',
    z.object({
      projectId: Id,
      /** `YYYY-MM` in the organization's time zone. */
      month: z.string().regex(/^\d{4}-\d{2}$/),
      level: z.enum(['warning', 'paused']),
      spendMicros: z.number().int().nonnegative(),
      budgetMicros: z.number().int().positive(),
      deskItemId: Id.optional(),
    }),
  ),
  /** "Override for this month": dispatching resumes although the budget is used up; the next month starts fresh. */
  defineEvent(
    'ProjectBudgetOverridden',
    z.object({ projectId: Id, month: z.string().regex(/^\d{4}-\d{2}$/), by: Id }),
  ),
] as const;
