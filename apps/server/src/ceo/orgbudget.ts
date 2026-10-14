import type { Ctx } from '../context.ts';
import { inCurrency, monthOf, orgCostCtx } from '../costs/index.ts';
import { exec, one } from '../db/sql.ts';
import { notifyOwner } from './notify.ts';
import type { CeoState } from './state.ts';

export interface OrgBudgetState {
  /** Micro-units of the organization's currency; 0: no organization budget. */
  budget: number;
  spent: number;
  percent: number | null;
  month: string;
}

/** The optional organization-wide monthly budget (CEO settings) against this month's total spend. */
export async function orgBudgetState(ctx: Ctx, ceo: CeoState, now: Date): Promise<OrgBudgetState> {
  const budget = ceo.settings.orgBudgetMonthlyMicros;
  const c = await orgCostCtx(ctx.pool, ceo.orgId);
  const m = monthOf(c, now);
  if (!budget) return { budget: 0, spent: 0, percent: null, month: m.key };
  const r = await one(
    ctx.pool,
    `SELECT COALESCE(sum(cost_usd_micros),0) AS usd FROM shift_costs WHERE org_id=$1 AND ended_at >= $2 AND ended_at < $3`,
    [ceo.orgId, m.start, m.next],
  );
  const spent = inCurrency(r?.usd, c);
  return { budget, spent, percent: Math.round((spent / budget) * 100), month: m.key };
}

/**
 * 80% of the organization budget: the owner is told once a month; 100%: told again (urgent) and the CEO goes into minimal
 * mode (`minimal`: only the daily report and the chat). Returns whether minimal mode applies now.
 */
export async function checkOrgBudget(
  ctx: Ctx,
  ceo: CeoState,
  now: Date,
): Promise<{ minimal: boolean; state: OrgBudgetState }> {
  const state = await orgBudgetState(ctx, ceo, now);
  if (!state.budget || state.percent === null) return { minimal: false, state };
  const once = async (flag: string, fn: () => Promise<unknown>) => {
    const done = await one(ctx.pool, 'SELECT 1 FROM ceo_flags WHERE org_id=$1 AND flag=$2', [
      ceo.orgId,
      flag,
    ]);
    if (done) return;
    await exec(
      ctx.pool,
      `INSERT INTO ceo_flags (org_id, flag, value, at) VALUES ($1,$2,'1',$3) ON CONFLICT DO NOTHING`,
      [ceo.orgId, flag, now],
    );
    await fn();
  };
  if (state.percent >= 80)
    await once(`orgbudget80:${state.month}`, () =>
      notifyOwner(ctx, ceo.orgId, {
        kind: 'needs_you',
        title: `The organization used ${state.percent}% of its monthly budget`,
        text: `Spending this month is at ${state.percent}% of the budget you set for the organization. At 100% the CEO only writes the daily report and answers in chat until next month, or until you raise the budget on the CEO page.`,
        subject: `orgbudget80:${state.month}`,
      }),
    );
  if (state.percent >= 100)
    await once(`orgbudget100:${state.month}`, () =>
      notifyOwner(ctx, ceo.orgId, {
        kind: 'urgent',
        title: 'The organization budget is used up: the CEO is in minimal mode',
        text: 'The monthly organization budget is used up. The CEO now only writes the daily report and answers in chat. Project budgets and agents are not affected by this setting. Raise the budget on the CEO page to let it act again.',
        subject: `orgbudget100:${state.month}`,
      }),
    );
  return { minimal: state.percent >= 100, state };
}
