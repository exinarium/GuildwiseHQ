import {
  DEFAULT_HOURLY_VALUE_USD,
  DEFAULT_HOURS_PER_CARD,
  type NextAction,
  type ValuePeriod,
  type ValueQuery,
  type ValueReport,
  type ValueSettings,
  zonedDayStart,
} from '@aom/shared';
import { one, type Queryable, rows } from '../db/sql.ts';
import { inCurrency, monthOf, type OrgCostCtx, orgCostCtx } from './index.ts';

/**
 * The value report (backlog #37): what the agents finished in a month, what that work would have taken a person
 * (an estimate by card type, adjustable per organization) and what it cost in usage. All of it is derived from
 * projections (cards, shifts, shift_costs), so a rebuild gives the same figures. Money is in micro-units of the
 * organization's currency.
 */

const round1 = (n: number) => Math.round(n * 10) / 10;

/** The stored settings with the defaults filled in; `hourlyValueEffective` is in the organization's currency. */
export async function valueSettingsOf(
  db: Queryable,
  c: OrgCostCtx,
): Promise<ValueSettings & { hourlyValueEffective: number }> {
  const o = await one(db, 'SELECT value_settings FROM organizations WHERE id=$1', [c.orgId]);
  const s = (o?.value_settings ?? {}) as Partial<ValueSettings>;
  const hourlyValue = typeof s.hourlyValue === 'number' ? s.hourlyValue : null;
  return {
    hoursByType: { ...DEFAULT_HOURS_PER_CARD, ...(s.hoursByType ?? {}) },
    hourlyValue,
    hourlyValueEffective: hourlyValue ?? round1(DEFAULT_HOURLY_VALUE_USD * c.usdRate),
  };
}

/** `YYYY-MM` shifted by `delta` months. */
export function shiftMonth(key: string, delta: number): string {
  const [y, m] = key.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

interface PeriodData {
  period: ValuePeriod;
  byType: Map<string, { cards: number; hours: number }>;
  byProject: Map<string, { key: string; name: string; cards: number; hours: number; usageMicros: number }>;
}

async function periodOf(
  db: Queryable,
  c: OrgCostCtx,
  month: string,
  settings: ValueSettings & { hourlyValueEffective: number },
  projectIds: string[] | null,
): Promise<PeriodData> {
  const start = zonedDayStart(`${month}-01`, c.timezone);
  const end = zonedDayStart(`${shiftMonth(month, 1)}-01`, c.timezone);
  const args = [c.orgId, start, end, projectIds];
  const cards = await rows(
    db,
    `SELECT c.project_id, p.key, p.name, c.card_type, c.rework_round,
            extract(epoch FROM (c.finalized_at - c.created_at)) / 86400.0 AS days
       FROM cards c JOIN projects p ON p.id = c.project_id
      WHERE c.org_id = $1 AND p.kind = 'project' AND c.status = 'done' AND c.card_type NOT IN ('regression','feed')
        AND c.finalized_at >= $2 AND c.finalized_at < $3 AND ($4::uuid[] IS NULL OR c.project_id = ANY($4::uuid[]))`,
    args,
  );
  const usage = await rows(
    db,
    `SELECT project_id, sum(cost_usd_micros) AS usd FROM shift_costs
      WHERE org_id = $1 AND ended_at >= $2 AND ended_at < $3
        AND ($4::uuid[] IS NULL OR project_id = ANY($4::uuid[])) GROUP BY project_id`,
    args,
  );
  const worked = await one(
    db,
    `SELECT COALESCE(sum(s.duration_ms), 0)::float8 AS ms FROM shifts s JOIN cards c ON c.id = s.card_id
      WHERE c.org_id = $1 AND s.status = 'ended' AND s.ended_at >= $2 AND s.ended_at < $3
        AND ($4::uuid[] IS NULL OR c.project_id = ANY($4::uuid[]))`,
    args,
  );

  const byType = new Map<string, { cards: number; hours: number }>();
  const byProject: PeriodData['byProject'] = new Map();
  let hours = 0;
  let rework = 0;
  let days = 0;
  for (const r of cards) {
    const h = settings.hoursByType[r.card_type] ?? 0;
    hours += h;
    rework += Number(r.rework_round);
    days += Number(r.days);
    const t = byType.get(r.card_type) ?? { cards: 0, hours: 0 };
    byType.set(r.card_type, { cards: t.cards + 1, hours: t.hours + h });
    const p = byProject.get(r.project_id) ?? {
      key: r.key,
      name: r.name,
      cards: 0,
      hours: 0,
      usageMicros: 0,
    };
    byProject.set(r.project_id, { ...p, cards: p.cards + 1, hours: p.hours + h });
  }
  let usageMicros = 0;
  for (const u of usage) {
    const m = inCurrency(u.usd, c);
    usageMicros += m;
    const p = u.project_id ? byProject.get(u.project_id) : undefined;
    if (p) p.usageMicros += m;
    else if (u.project_id) {
      const pr = await one(db, 'SELECT key, name FROM projects WHERE id=$1', [u.project_id]);
      if (pr) byProject.set(u.project_id, { key: pr.key, name: pr.name, cards: 0, hours: 0, usageMicros: m });
    }
  }
  const valueMicros = Math.round(hours * settings.hourlyValueEffective * 1_000_000);
  return {
    period: {
      month,
      cards: cards.length,
      hours: round1(hours),
      usageMicros,
      valueMicros,
      returnX: usageMicros > 0 ? round1(valueMicros / usageMicros) : null,
      agentHours: round1(Number(worked?.ms ?? 0) / 3_600_000),
      reworkRounds: rework,
      avgDaysToDone: cards.length ? round1(days / cards.length) : null,
    },
    byType,
    byProject,
  };
}

/** Stuck cards, agents that fail often and idle projects, now. `projectIds` null = the whole organization. */
export async function nextBestActions(
  db: Queryable,
  orgId: string,
  projectIds: string[] | null,
  now: Date,
): Promise<NextAction[]> {
  const out: NextAction[] = [];
  const stuck = await rows(
    db,
    `SELECT c.ref, c.title, c.status, extract(epoch FROM ($3::timestamptz - c.updated_at)) / 86400.0 AS days
       FROM cards c JOIN projects p ON p.id = c.project_id
      WHERE c.org_id = $1 AND p.kind = 'project' AND c.status IN ('queued','claimed','blocked','waiting')
        AND c.updated_at < $3::timestamptz - interval '3 days' AND ($2::uuid[] IS NULL OR c.project_id = ANY($2::uuid[]))
      ORDER BY c.updated_at LIMIT 5`,
    [orgId, projectIds, now],
  );
  for (const r of stuck)
    out.push({
      kind: 'stuck_card',
      title: `${r.ref} ${r.title}`,
      detail: `${r.status}, no movement for ${Math.floor(Number(r.days))} days`,
      ref: r.ref,
    });

  const failing = await rows(
    db,
    `SELECT a.id, a.name, count(*)::int AS total,
            count(*) FILTER (WHERE s.outcome IN ('crashed','timeout','no_report','lost','rejected'))::int AS failed
       FROM shifts s JOIN agents a ON a.id = s.agent_id LEFT JOIN cards c ON c.id = s.card_id
      WHERE s.org_id = $1 AND s.status = 'ended' AND s.ended_at >= $3::timestamptz - interval '14 days'
        AND ($2::uuid[] IS NULL OR c.project_id = ANY($2::uuid[]))
      GROUP BY a.id, a.name
     HAVING count(*) FILTER (WHERE s.outcome IN ('crashed','timeout','no_report','lost','rejected')) >= 3
        AND count(*) FILTER (WHERE s.outcome IN ('crashed','timeout','no_report','lost','rejected')) * 10 >= count(*) * 3
      ORDER BY 4 DESC, a.name LIMIT 5`,
    [orgId, projectIds, now],
  );
  for (const r of failing)
    out.push({
      kind: 'failing_agent',
      title: r.name,
      detail: `${r.failed} of ${r.total} shifts failed in the last 14 days`,
      ref: r.id,
    });

  const idle = await rows(
    db,
    `SELECT p.key, p.name FROM projects p
      WHERE p.org_id = $1 AND p.kind = 'project' AND p.status = 'active' AND ($2::uuid[] IS NULL OR p.id = ANY($2::uuid[]))
        AND p.created_at < $3::timestamptz - interval '14 days'
        AND NOT EXISTS (SELECT 1 FROM cards c WHERE c.project_id = p.id
                         AND (c.created_at >= $3::timestamptz - interval '14 days'
                              OR c.updated_at >= $3::timestamptz - interval '14 days'))
      ORDER BY p.key LIMIT 5`,
    [orgId, projectIds, now],
  );
  for (const r of idle)
    out.push({
      kind: 'idle_project',
      title: `${r.key} ${r.name}`,
      detail: 'No card activity for 14 days',
      ref: r.key,
    });
  return out;
}

/** The report for one month (default the current one), the month before it, and the actions to take next. */
export async function valueReport(
  db: Queryable,
  orgId: string,
  q: ValueQuery & { projectIds?: string[] | null },
  now: Date,
  canEdit: boolean,
): Promise<ValueReport> {
  const c = await orgCostCtx(db, orgId);
  const settings = await valueSettingsOf(db, c);
  const month = q.month ?? monthOf(c, now).key;
  const projectIds = q.projectId ? [q.projectId] : (q.projectIds ?? null);
  const cur = await periodOf(db, c, month, settings, projectIds);
  const prev = await periodOf(db, c, shiftMonth(month, -1), settings, projectIds);
  return {
    currency: c.currency,
    timezone: c.timezone,
    current: cur.period,
    previous: prev.period,
    byType: [...cur.byType].map(([cardType, v]) => ({ cardType, cards: v.cards, hours: round1(v.hours) })),
    byProject: [...cur.byProject]
      .map(([projectId, v]) => ({ projectId, ...v, hours: round1(v.hours) }))
      .sort((a, b) => b.hours - a.hours || a.key.localeCompare(b.key)),
    nextActions: await nextBestActions(db, orgId, projectIds, now),
    settings: { ...settings, canEdit },
  };
}

/** The CSV export: one row per project for the month, plus the totals. Cost and value in whole currency units. */
export async function valueCsv(
  db: Queryable,
  orgId: string,
  q: ValueQuery,
  now: Date,
  csvField: (v: string | number) => string,
): Promise<{ csv: string; month: string }> {
  const r = await valueReport(db, orgId, q, now, false);
  const units = (m: number) => (m / 1_000_000).toFixed(2);
  const head = ['month', 'project', 'cards_done', 'est_human_hours', `usage_${r.currency}`, 'return_x'];
  const lines = [head.join(',')];
  for (const p of r.byProject)
    lines.push(
      [
        r.current.month,
        p.key,
        p.cards,
        p.hours,
        units(p.usageMicros),
        p.usageMicros > 0
          ? round1((p.hours * r.settings.hourlyValueEffective * 1_000_000) / p.usageMicros)
          : '',
      ]
        .map(csvField)
        .join(','),
    );
  lines.push(
    [
      r.current.month,
      'TOTAL',
      r.current.cards,
      r.current.hours,
      units(r.current.usageMicros),
      r.current.returnX ?? '',
    ]
      .map(csvField)
      .join(','),
  );
  return { csv: `${lines.join('\n')}\n`, month: r.current.month };
}
