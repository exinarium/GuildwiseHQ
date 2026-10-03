import {
  type AgentStats,
  countsAgainstBuilder,
  HR_WINDOW_DAYS,
  type ReworkReason,
  type StatValue,
  type WorkQuality,
} from '@aom/shared';
import { type Queryable, type Row, rows } from '../db/sql.ts';

/** Agent columns the stats need. */
export interface StatsAgent {
  id: string;
  roleKey: string;
  hiredAt: Date;
  retired: boolean;
}

export const windowStart = (now: Date, days = HR_WINDOW_DAYS): Date =>
  new Date(now.getTime() - days * 86_400_000);

const round = (n: number, digits = 4): number => Math.round(n * 10 ** digits) / 10 ** digits;
const ratio = (num: number, den: number): number | null => (den > 0 ? round(num / den) : null);
const mean = (xs: Array<number | null>): number | null => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? round(v.reduce((a, b) => a + b, 0) / v.length) : null;
};

export interface AgentTrack {
  stats: AgentStats;
  quality: WorkQuality;
  /** Raw counts the recommendation rules reuse. */
  raw: RawCounts;
}

export interface RawCounts {
  touched: number;
  done: number;
  blocked: number;
  submitted: number;
  reworked: number;
  buggy: number;
  small: number;
  large: number;
  reworkedLarge: number;
  buggyLarge: number;
  tokensOfDone: number;
  shiftMs: number;
  availableMs: number;
}

const EMPTY_QUALITY: WorkQuality = {
  reviewScoreAvg: null,
  reviewCount: 0,
  reworkByReason: [],
  reworkRoundsPerCard: { avg: null, max: 0, cardsWithThreeOrMore: 0 },
  bugsEscaped: 0,
  criteriaMissed: 0,
  testCoverage: { cardsWithTests: 0, cardsMeasured: 0, rate: null },
};

/**
 * Stats and work quality of `agents` over the rolling window ending at `now`, from the track-record projections
 * (`agent_card_stats`, `agent_review_log`, `agent_stats_daily`). Team values are the mean over the agents of the same
 * role in `agents` (callers pass the set that defines the team).
 */
export async function computeTrack(
  db: Queryable,
  agents: StatsAgent[],
  now: Date,
  windowDays = HR_WINDOW_DAYS,
): Promise<Map<string, AgentTrack>> {
  const out = new Map<string, AgentTrack>();
  if (agents.length === 0) return out;
  const from = windowStart(now, windowDays);
  const ids = agents.map((a) => a.id);

  const cards = new Map<string, Row>(
    (
      await rows(
        db,
        `SELECT agent_id,
                count(*)::int AS touched,
                count(*) FILTER (WHERE done_at >= $2)::int AS done,
                count(*) FILTER (WHERE questions > 0)::int AS blocked,
                count(*) FILTER (WHERE submitted)::int AS submitted,
                count(*) FILTER (WHERE submitted AND rework_rounds > 0)::int AS reworked,
                count(*) FILTER (WHERE submitted AND bugs > 0)::int AS buggy,
                count(*) FILTER (WHERE submitted AND risk_tier = 'large')::int AS large,
                count(*) FILTER (WHERE submitted AND risk_tier IS DISTINCT FROM 'large')::int AS small,
                count(*) FILTER (WHERE submitted AND risk_tier = 'large' AND rework_rounds > 0)::int AS reworked_large,
                count(*) FILTER (WHERE submitted AND risk_tier = 'large' AND bugs > 0)::int AS buggy_large,
                COALESCE(sum(tokens) FILTER (WHERE done_at >= $2), 0)::bigint AS tokens_done,
                COALESCE(sum(bugs), 0)::int AS bugs,
                COALESCE(sum(criteria_missed), 0)::int AS criteria_missed,
                COALESCE(max(rework_rounds) FILTER (WHERE submitted), 0)::int AS max_rounds,
                COALESCE(sum(rework_rounds) FILTER (WHERE submitted), 0)::int AS sum_rounds,
                count(*) FILTER (WHERE submitted AND rework_rounds >= 3)::int AS three_plus,
                count(*) FILTER (WHERE submitted AND test_files IS NOT NULL)::int AS measured,
                count(*) FILTER (WHERE submitted AND test_files > 0)::int AS with_tests
           FROM agent_card_stats WHERE agent_id = ANY($1::uuid[]) AND last_at >= $2 GROUP BY agent_id`,
        [ids, from],
      )
    ).map((r) => [r.agent_id as string, r]),
  );
  const daily = new Map<string, Row[]>();
  for (const r of await rows(
    db,
    `SELECT agent_id, day::text AS day, shift_ms, cards_done FROM agent_stats_daily
      WHERE agent_id = ANY($1::uuid[]) AND day >= $2::date`,
    [ids, from],
  )) {
    daily.set(r.agent_id, [...(daily.get(r.agent_id) ?? []), r]);
  }
  const reviews = new Map<string, Row>(
    (
      await rows(
        db,
        `SELECT builder_agent_id AS agent_id, count(*)::int AS n, avg(score)::float AS avg_score
           FROM agent_review_log WHERE builder_agent_id = ANY($1::uuid[]) AND at >= $2 GROUP BY builder_agent_id`,
        [ids, from],
      )
    ).map((r) => [r.agent_id as string, r]),
  );
  const reasons = new Map<string, Array<{ reason: ReworkReason; count: number }>>();
  for (const r of await rows(
    db,
    `SELECT builder_agent_id AS agent_id, reason, count(*)::int AS n
       FROM agent_review_log, unnest(reasons) AS reason
      WHERE builder_agent_id = ANY($1::uuid[]) AND at >= $2 AND verdict = 'changes'
      GROUP BY builder_agent_id, reason ORDER BY n DESC, reason`,
    [ids, from],
  )) {
    reasons.set(r.agent_id, [
      ...(reasons.get(r.agent_id) ?? []),
      { reason: r.reason as ReworkReason, count: r.n },
    ]);
  }

  const days14: string[] = [];
  for (let i = 13; i >= 0; i--)
    days14.push(new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10));

  const per = new Map<string, { raw: RawCounts; quality: WorkQuality; doneByDay: number[] }>();
  for (const a of agents) {
    const c = cards.get(a.id);
    const num = (k: string) => Number(c?.[k] ?? 0);
    const rowsDaily = daily.get(a.id) ?? [];
    const shiftMs = rowsDaily.reduce((s, r) => s + Number(r.shift_ms), 0);
    const since = Math.max(from.getTime(), a.hiredAt.getTime());
    const availableMs = Math.max(now.getTime() - since, 3_600_000);
    const raw: RawCounts = {
      touched: num('touched'),
      done: num('done'),
      blocked: num('blocked'),
      submitted: num('submitted'),
      reworked: num('reworked'),
      buggy: num('buggy'),
      small: num('small'),
      large: num('large'),
      reworkedLarge: num('reworked_large'),
      buggyLarge: num('buggy_large'),
      tokensOfDone: num('tokens_done'),
      shiftMs,
      availableMs,
    };
    const rv = reviews.get(a.id);
    const quality: WorkQuality = c
      ? {
          reviewScoreAvg: rv ? round(Number(rv.avg_score), 2) : null,
          reviewCount: Number(rv?.n ?? 0),
          reworkByReason: (reasons.get(a.id) ?? []).map((r) => ({
            reason: r.reason,
            count: r.count,
            countsAgainstBuilder: countsAgainstBuilder(r.reason),
          })),
          reworkRoundsPerCard: {
            avg: ratio(num('sum_rounds'), raw.submitted),
            max: num('max_rounds'),
            cardsWithThreeOrMore: num('three_plus'),
          },
          bugsEscaped: num('bugs'),
          criteriaMissed: num('criteria_missed'),
          testCoverage: {
            cardsWithTests: num('with_tests'),
            cardsMeasured: num('measured'),
            rate: ratio(num('with_tests'), num('measured')),
          },
        }
      : {
          ...EMPTY_QUALITY,
          reviewScoreAvg: rv ? round(Number(rv.avg_score), 2) : null,
          reviewCount: Number(rv?.n ?? 0),
          reworkByReason: (reasons.get(a.id) ?? []).map((r) => ({
            reason: r.reason,
            count: r.count,
            countsAgainstBuilder: countsAgainstBuilder(r.reason),
          })),
        };
    const byDay = new Map(rowsDaily.map((r) => [r.day as string, Number(r.cards_done)]));
    per.set(a.id, { raw, quality, doneByDay: days14.map((d) => byDay.get(d) ?? 0) });
  }

  // Own values first; the team mean is taken over the active agents of the same role.
  const own = new Map<
    string,
    Record<'done' | 'blocked' | 'rework' | 'bugs' | 'util' | 'tokens', number | null>
  >();
  for (const a of agents) {
    const { raw } = per.get(a.id) as { raw: RawCounts };
    own.set(a.id, {
      done: raw.done,
      blocked: ratio(raw.blocked, raw.touched),
      rework: ratio(raw.reworked, raw.submitted),
      bugs: ratio(raw.buggy, raw.submitted),
      util: round(Math.min(1, raw.shiftMs / raw.availableMs)),
      tokens: raw.done > 0 ? Math.round(raw.tokensOfDone / raw.done) : null,
    });
  }
  const teamOf = (a: StatsAgent, key: 'done' | 'blocked' | 'rework' | 'bugs' | 'util' | 'tokens') =>
    mean(
      agents
        .filter((o) => o.roleKey === a.roleKey && !o.retired)
        .map((o) => (own.get(o.id) as Record<string, number | null>)[key] ?? null),
    );
  const sv = (a: StatsAgent, key: 'done' | 'blocked' | 'rework' | 'bugs' | 'util' | 'tokens'): StatValue => ({
    value: (own.get(a.id) as Record<string, number | null>)[key] ?? null,
    team: teamOf(a, key),
  });
  for (const a of agents) {
    const p = per.get(a.id) as { raw: RawCounts; quality: WorkQuality; doneByDay: number[] };
    out.set(a.id, {
      raw: p.raw,
      quality: p.quality,
      stats: {
        agentId: a.id,
        windowDays,
        from: from.toISOString(),
        to: now.toISOString(),
        cardsTouched: p.raw.touched,
        cardsDone: sv(a, 'done'),
        blockedRate: sv(a, 'blocked'),
        reworkRate: sv(a, 'rework'),
        bugsEscaped: sv(a, 'bugs'),
        utilisation: sv(a, 'util'),
        tokensPerCard: sv(a, 'tokens'),
        doneByDay: p.doneByDay,
      },
    });
  }
  return out;
}
