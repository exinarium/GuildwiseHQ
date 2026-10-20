import {
  type BudgetDto,
  budgetStatus,
  DEFAULT_CURRENCY,
  type FloorDigest,
  isOrgManager,
  monthKeyOf,
  monthStartOf,
  nextMonthStartOf,
  type OrgRole,
  type SpendBrief,
} from '@aom/shared';
import { reportingOf } from '../ceo/prefs.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';

/** How an organization shows money and cuts months: its currency, the USD rate and its time zone (the Owner's). */
export interface OrgCostCtx {
  orgId: string;
  currency: string;
  usdRate: number;
  timezone: string;
}

export async function orgCostCtx(db: Queryable, orgId: string): Promise<OrgCostCtx> {
  const o = await one(db, 'SELECT currency, usd_rate FROM organizations WHERE id=$1', [orgId]);
  const r = await reportingOf(db, orgId);
  return {
    orgId,
    currency: o?.currency ?? DEFAULT_CURRENCY,
    usdRate: Number(o?.usd_rate ?? 1),
    timezone: r.timezone ?? 'UTC',
  };
}

/** USD micros (a bigint column arrives as a string) to micro-units of the organization's currency. */
export const inCurrency = (usdMicros: number | string | null | undefined, c: { usdRate: number }): number =>
  Math.round(Number(usdMicros ?? 0) * c.usdRate);

/** The organization's current month: key, first instant, the instant it resets. */
export function monthOf(c: OrgCostCtx, now: Date) {
  return {
    key: monthKeyOf(now, c.timezone),
    start: monthStartOf(now, c.timezone),
    next: nextMonthStartOf(now, c.timezone),
  };
}

/** This month's spend per project of one organization, in micro-units of its currency. */
export async function monthSpendByProject(
  db: Queryable,
  c: OrgCostCtx,
  now: Date,
  projectIds?: string[],
): Promise<Map<string, number>> {
  const m = monthOf(c, now);
  const r = await rows(
    db,
    `SELECT project_id, sum(cost_usd_micros) AS usd FROM shift_costs
      WHERE org_id = $1 AND project_id IS NOT NULL AND ended_at >= $2 AND ended_at < $3
        AND ($4::uuid[] IS NULL OR project_id = ANY($4::uuid[]))
      GROUP BY project_id`,
    [c.orgId, m.start, m.next, projectIds ?? null],
  );
  return new Map(r.map((x) => [x.project_id as string, inCurrency(x.usd, c)]));
}

/** The budget block of a project row (`p.*`): state, amounts (hidden when `showAmounts` is false) and the reset time. */
export function budgetDto(
  p: Row,
  spend: number,
  c: OrgCostCtx,
  now: Date,
  opts: { canEdit: boolean; showAmounts: boolean },
): BudgetDto {
  const m = monthOf(c, now);
  const budget = p.budget_micros === null || p.budget_micros === undefined ? null : Number(p.budget_micros);
  const { state, percent } = budgetStatus(budget, spend, p.budget_override_month === m.key);
  return {
    state,
    month: m.key,
    monthlyMicros: opts.showAmounts ? budget : null,
    spentMicros: opts.showAmounts ? spend : null,
    percent: opts.showAmounts ? percent : null,
    resetsAt: m.next.toISOString(),
    currency: c.currency,
    canEdit: opts.canEdit,
  };
}

/** Org roles that see amounts: every member of the project's own organization; a guest sees the state only. */
export const seesAmounts = (role: OrgRole | null): boolean => role !== null;
export const canEditBudget = (role: OrgRole | null): boolean => isOrgManager({ orgRole: role });

/** Spend of one agent, card, phase or interest (all-time and this month), in the organization's currency. */
export async function spendBriefs(
  db: Queryable,
  c: OrgCostCtx,
  now: Date,
  by: 'agent' | 'card' | 'phase' | 'project',
  ids: string[],
): Promise<Map<string, SpendBrief>> {
  const out = new Map<string, SpendBrief>();
  if (ids.length === 0) return out;
  const m = monthOf(c, now);
  const col =
    by === 'agent'
      ? 'sc.agent_id'
      : by === 'card'
        ? 'sc.card_id'
        : by === 'project'
          ? 'sc.project_id'
          : 'COALESCE(sc.phase_id, c.phase_id)';
  const r = await rows(
    db,
    `SELECT ${col} AS id, sum(sc.cost_usd_micros) AS total,
            sum(sc.cost_usd_micros) FILTER (WHERE sc.ended_at >= $2 AND sc.ended_at < $3) AS month
       FROM shift_costs sc LEFT JOIN cards c ON c.id = sc.card_id
      WHERE sc.org_id = $4 AND ${col} = ANY($1::uuid[])
      GROUP BY 1`,
    [ids, m.start, m.next, c.orgId],
  );
  for (const x of r)
    out.set(x.id as string, {
      monthMicros: inCurrency(x.month, c),
      totalMicros: inCurrency(x.total, c),
      currency: c.currency,
    });
  for (const id of ids)
    if (!out.has(id)) out.set(id, { monthMicros: 0, totalMicros: 0, currency: c.currency });
  return out;
}

/**
 * SQL for "this project's dispatching is paused by its budget" (a boolean expression over the projects alias `p`).
 * `now` is a SQL parameter holding the server clock. The month is cut in the organization's time zone (its Owner's);
 * the spend is the month's `shift_costs` at the organization's rate. A project with no budget, or overridden for this
 * month, is never paused. Stateless on purpose: raising the budget, an override and the reset on the 1st all take
 * effect at once, with no event to wait for, and the dispatcher, the claim and the schedulers share this one rule.
 */
export const budgetPausedSql = (
  p: string,
  now: string,
): string => `(${p}.budget_micros IS NOT NULL AND EXISTS (
  SELECT 1 FROM organizations bo
    LEFT JOIN users bu ON bu.id = bo.owner_user_id
    CROSS JOIN LATERAL (SELECT COALESCE(bu.timezone, 'UTC') AS tz) bz
    CROSS JOIN LATERAL (SELECT date_trunc('month', ${now}::timestamptz AT TIME ZONE bz.tz) AS ml) bl
   WHERE bo.id = ${p}.org_id
     AND ${p}.budget_override_month IS DISTINCT FROM to_char(bl.ml, 'YYYY-MM')
     AND COALESCE((SELECT sum(sc.cost_usd_micros) FROM shift_costs sc
                    WHERE sc.project_id = ${p}.id
                      AND sc.ended_at >= (bl.ml AT TIME ZONE bz.tz)
                      AND sc.ended_at < ((bl.ml + interval '1 month') AT TIME ZONE bz.tz)), 0) * bo.usd_rate
         >= ${p}.budget_micros))`;

/** Is the project paused by its budget right now? (the schedulers and manual runs ask this) */
export async function isBudgetPaused(db: Queryable, projectId: string, now: Date): Promise<boolean> {
  const r = await one(db, `SELECT ${budgetPausedSql('p', '$2')} AS paused FROM projects p WHERE p.id = $1`, [
    projectId,
    now,
  ]);
  return r?.paused === true;
}

/** The spend section of the floor report: since the last report, this month, the top projects and any near a budget. */
export async function spendDigest(
  db: Queryable,
  orgId: string,
  now: Date,
  since: Date,
): Promise<FloorDigest['spend']> {
  const c = await orgCostCtx(db, orgId);
  const m = monthOf(c, now);
  const sinceRow = await one(
    db,
    `SELECT COALESCE(sum(cost_usd_micros),0) AS usd FROM shift_costs WHERE org_id=$1 AND ended_at > $2`,
    [orgId, since],
  );
  const overhead = await one(
    db,
    `SELECT COALESCE(sum(cost_usd_micros),0) AS usd FROM shift_costs
      WHERE org_id=$1 AND project_id IS NULL AND ended_at >= $2 AND ended_at < $3`,
    [orgId, m.start, m.next],
  );
  const perProject = await monthSpendByProject(db, c, now);
  const projects = await rows(
    db,
    `SELECT id, key, name, budget_micros, budget_override_month FROM projects
      WHERE org_id=$1 AND status='active' AND (budget_micros IS NOT NULL OR id = ANY($2::uuid[]))`,
    [orgId, [...perProject.keys()]],
  );
  const list = projects
    .map((p) => {
      const spend = perProject.get(p.id) ?? 0;
      const budget = p.budget_micros === null ? null : Number(p.budget_micros);
      const st = budgetStatus(budget, spend, p.budget_override_month === m.key);
      return {
        key: p.key as string,
        name: p.name as string,
        monthMicros: spend,
        budgetMicros: budget,
        percent: st.percent,
        state: st.state,
      };
    })
    .filter((p) => p.monthMicros > 0 || p.budgetMicros !== null)
    .sort((a, b) => b.monthMicros - a.monthMicros);
  const total = [...perProject.values()].reduce((a, b) => a + b, 0);
  const overheadMicros = inCurrency(overhead?.usd, c);
  return {
    currency: c.currency,
    sinceMicros: inCurrency(sinceRow?.usd, c),
    monthMicros: total + overheadMicros,
    overheadMonthMicros: overheadMicros,
    projects: list.slice(0, 12),
  };
}
