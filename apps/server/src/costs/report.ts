import {
  type BudgetDto,
  COST_CSV_COLUMNS,
  type CostSettings,
  type CostsQuery,
  type CostsReport,
  DEFAULT_MODEL_PRICES,
  modelFamily,
  nextDay,
  type SpendTotals,
  zonedDayStart,
} from '@aom/shared';
import { type Queryable, rows } from '../db/sql.ts';
import { budgetDto, inCurrency, monthOf, monthSpendByProject, type OrgCostCtx, orgCostCtx } from './index.ts';

const zero = (): SpendTotals => ({
  costMicros: 0,
  shifts: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

/** The aggregate columns every breakdown selects (sums of bigints arrive as strings). */
const AGG = `count(*)::int AS shifts, COALESCE(sum(sc.cost_usd_micros),0) AS usd,
  COALESCE(sum(sc.tokens_input),0) AS t_in, COALESCE(sum(sc.tokens_output),0) AS t_out,
  COALESCE(sum(sc.tokens_cache_read),0) AS t_cr, COALESCE(sum(sc.tokens_cache_write),0) AS t_cw`;

const totalsOf = (r: Record<string, any> | undefined, c: OrgCostCtx): SpendTotals =>
  r
    ? {
        costMicros: inCurrency(r.usd, c),
        shifts: Number(r.shifts),
        inputTokens: Number(r.t_in),
        outputTokens: Number(r.t_out),
        cacheReadTokens: Number(r.t_cr),
        cacheWriteTokens: Number(r.t_cw),
      }
    : zero();

/** The local date range of a request: default the current month so far; `to` is inclusive. */
export function rangeOf(c: OrgCostCtx, q: CostsQuery, now: Date) {
  const m = monthOf(c, now);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: c.timezone }).format(now);
  const from = q.from ?? `${m.key}-01`;
  const to = q.to ?? today;
  return { from, to, start: zonedDayStart(from, c.timezone), end: zonedDayStart(nextDay(to), c.timezone) };
}

export async function costSettings(db: Queryable, orgId: string, canEdit: boolean): Promise<CostSettings> {
  const c = await orgCostCtx(db, orgId);
  return { currency: c.currency, usdRate: c.usdRate, timezone: c.timezone, canEdit };
}

/** The org-level cost breakdown for the Costs page (Owner and Admin). */
export async function costsReport(
  db: Queryable,
  orgId: string,
  q: CostsQuery,
  now: Date,
): Promise<CostsReport> {
  const c = await orgCostCtx(db, orgId);
  const { from, to, start, end } = rangeOf(c, q, now);
  const where = `sc.org_id = $1 AND sc.ended_at >= $2 AND sc.ended_at < $3 AND ($4::uuid IS NULL OR sc.project_id = $4)`;
  const args = [orgId, start, end, q.projectId ?? null];

  const total = (await rows(db, `SELECT ${AGG} FROM shift_costs sc WHERE ${where}`, args))[0];
  const overhead = (
    await rows(db, `SELECT ${AGG} FROM shift_costs sc WHERE ${where} AND sc.project_id IS NULL`, args)
  )[0];
  const byProject = await rows(
    db,
    `SELECT sc.project_id, p.key, p.name, p.kind, p.budget_micros, p.budget_override_month,
            (SELECT i.id FROM interests i WHERE i.project_id = p.id LIMIT 1) AS interest_id,
            (SELECT i.name FROM interests i WHERE i.project_id = p.id LIMIT 1) AS interest_name, ${AGG}
       FROM shift_costs sc JOIN projects p ON p.id = sc.project_id
      WHERE ${where} GROUP BY sc.project_id, p.key, p.name, p.kind, p.budget_micros, p.budget_override_month, p.id
      ORDER BY sum(sc.cost_usd_micros) DESC, p.key`,
    args,
  );
  const monthSpend = await monthSpendByProject(db, c, now);
  const now_ = now;
  const byAgent = await rows(
    db,
    `SELECT sc.agent_id, a.name, a.role_key, ${AGG}
       FROM shift_costs sc JOIN agents a ON a.id = sc.agent_id
      WHERE ${where} GROUP BY sc.agent_id, a.name, a.role_key ORDER BY sum(sc.cost_usd_micros) DESC, a.name`,
    args,
  );
  const byModel = await rows(
    db,
    `SELECT sc.model, ${AGG} FROM shift_costs sc WHERE ${where} GROUP BY sc.model
      ORDER BY sum(sc.cost_usd_micros) DESC, sc.model`,
    args,
  );
  const byDay = await rows(
    db,
    `SELECT to_char(sc.ended_at AT TIME ZONE $5, 'YYYY-MM-DD') AS day, ${AGG}
       FROM shift_costs sc WHERE ${where} GROUP BY 1 ORDER BY 1`,
    [...args, c.timezone],
  );
  return {
    currency: c.currency,
    timezone: c.timezone,
    from,
    to,
    totals: totalsOf(total, c),
    overhead: totalsOf(overhead, c),
    byProject: byProject.map((r) => {
      const budget: BudgetDto | null =
        r.budget_micros === null
          ? null
          : budgetDto(r, monthSpend.get(r.project_id) ?? 0, c, now_, { canEdit: true, showAmounts: true });
      return {
        ...totalsOf(r, c),
        projectId: r.project_id,
        key: r.key,
        name: r.interest_name ?? r.name,
        interestId: r.interest_id ?? null,
        budget,
      };
    }),
    byAgent: byAgent.map((r) => ({
      ...totalsOf(r, c),
      agentId: r.agent_id,
      name: r.name,
      roleKey: r.role_key,
    })),
    byModel: byModel.map((r) => ({ ...totalsOf(r, c), model: r.model, family: modelFamily(r.model) })),
    byDay: byDay.map((r) => ({ ...totalsOf(r, c), date: r.day })),
    prices: DEFAULT_MODEL_PRICES.map((p) => ({ ...p })),
    settings: { currency: c.currency, usdRate: c.usdRate, timezone: c.timezone, canEdit: true },
  };
}

/** A CSV field: quoted when needed, and a leading `= + - @` is defused so a spreadsheet never runs a name as a formula. */
export function csvField(v: string | number): string {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The export: one row per day, project, agent and model in the range. Cost is in whole currency units. */
export async function costsCsv(
  db: Queryable,
  orgId: string,
  q: CostsQuery,
  now: Date,
): Promise<{ csv: string; from: string; to: string }> {
  const c = await orgCostCtx(db, orgId);
  const { from, to, start, end } = rangeOf(c, q, now);
  const r = await rows(
    db,
    `SELECT to_char(sc.ended_at AT TIME ZONE $5, 'YYYY-MM-DD') AS day,
            COALESCE((SELECT i.name FROM interests i WHERE i.project_id = p.id LIMIT 1), p.key, 'overhead') AS project,
            a.name AS agent, sc.model, ${AGG}
       FROM shift_costs sc LEFT JOIN projects p ON p.id = sc.project_id JOIN agents a ON a.id = sc.agent_id
      WHERE sc.org_id = $1 AND sc.ended_at >= $2 AND sc.ended_at < $3 AND ($4::uuid IS NULL OR sc.project_id = $4)
      GROUP BY 1, p.id, p.key, a.id, a.name, sc.model ORDER BY 1, 2, 3, 4`,
    [orgId, start, end, q.projectId ?? null, c.timezone],
  );
  const lines = [COST_CSV_COLUMNS.join(',')];
  for (const x of r)
    lines.push(
      [
        x.day,
        x.project,
        x.agent,
        x.model,
        x.shifts,
        x.t_in,
        x.t_out,
        x.t_cr,
        x.t_cw,
        (inCurrency(x.usd, c) / 1_000_000).toFixed(4),
      ]
        .map(csvField)
        .join(','),
    );
  return { csv: `${lines.join('\n')}\n`, from, to };
}
