import { COST_CAUSES, type CostByCause, type CostCause } from '@aom/shared';
import { type Queryable, rows } from '../db/sql.ts';
import { inCurrency, type OrgCostCtx } from './index.ts';

/**
 * What a shift was spent on (Lean Team v3 measurement): one cause per shift, from facts the projections already hold.
 *  - rejected: the runner turned the shift away (usually free, but counted);
 *  - answering: a question shift (an agent answering a colleague);
 *  - asking: a card shift that ended by raising a question;
 *  - reviewing / re_review_after_conflict: a reviewer's shift; the second kind when the card had a rebase conflict before
 *    the shift started (the conflict reset the review, so the review is done again);
 *  - working: everything else a card shift does (design, build, test, finalize).
 * Shifts of no card and no question (BA, DevOps, CEO, chat) count as `other`.
 */
export const CAUSE_SQL = `CASE
  WHEN s.outcome = 'rejected' THEN 'rejected'
  WHEN s.kind = 'question' THEN 'answering'
  WHEN s.kind = 'card' AND s.report_outcome = 'question' THEN 'asking'
  WHEN s.kind = 'card' AND ag.role_key IN ('reviewer','pre_reviewer') THEN
    CASE WHEN EXISTS (SELECT 1 FROM events ev WHERE ev.type = 'RebaseConflict' AND ev.stream_id = 'card-' || s.card_id::text
                        AND ev.created_at < s.started_at) THEN 're_review_after_conflict' ELSE 'reviewing' END
  WHEN s.kind = 'card' THEN 'working'
  ELSE 'other' END`;

const zero = () => ({ costMicros: 0, shifts: 0 });
const emptyCauses = (): Record<CostCause, { costMicros: number; shifts: number }> =>
  Object.fromEntries(COST_CAUSES.map((c) => [c, zero()])) as Record<
    CostCause,
    { costMicros: number; shifts: number }
  >;

/**
 * Cost by cause for one card (all time), or for an organization by local day. Money in micro-units of the organization's
 * currency. `byDay` groups by the organization's local date.
 */
export async function costByCause(
  db: Queryable,
  c: OrgCostCtx,
  q: { cardId?: string; from?: Date; to?: Date; byDay?: boolean },
): Promise<CostByCause> {
  const dayExpr = `to_char(sc.ended_at AT TIME ZONE $4::text, 'YYYY-MM-DD')`;
  const r = await rows(
    db,
    `SELECT ${CAUSE_SQL} AS cause, ${q.byDay ? `${dayExpr} AS day,` : ''}
            count(*)::int AS shifts, COALESCE(sum(sc.cost_usd_micros),0) AS usd
       FROM shift_costs sc JOIN shifts s ON s.id = sc.shift_id JOIN agents ag ON ag.id = s.agent_id
      WHERE sc.org_id = $1 AND ($2::uuid IS NULL OR sc.card_id = $2) AND $4::text IS NOT NULL
        AND ($3::timestamptz IS NULL OR sc.ended_at >= $3) AND ($5::timestamptz IS NULL OR sc.ended_at < $5)
      GROUP BY 1${q.byDay ? ', 2' : ''} ORDER BY 1`,
    [c.orgId, q.cardId ?? null, q.from ?? null, c.timezone, q.to ?? null],
  );
  const total = emptyCauses();
  const days = new Map<string, Record<CostCause, { costMicros: number; shifts: number }>>();
  for (const row of r) {
    const cause = row.cause as CostCause;
    const cost = inCurrency(row.usd, c);
    total[cause].costMicros += cost;
    total[cause].shifts += Number(row.shifts);
    if (q.byDay) {
      const d = days.get(row.day) ?? emptyCauses();
      d[cause].costMicros += cost;
      d[cause].shifts += Number(row.shifts);
      days.set(row.day, d);
    }
  }
  return {
    currency: c.currency,
    total,
    totalMicros: Object.values(total).reduce((n, x) => n + x.costMicros, 0),
    ...(q.byDay
      ? {
          days: [...days.entries()]
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([day, causes]) => ({ day, causes })),
        }
      : {}),
  };
}
