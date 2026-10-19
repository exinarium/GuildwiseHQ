import {
  bootstrapRatio,
  GRAPH_EVALUATION_WEEKS,
  type GraphContextReport,
  type Guards,
  graphClaim,
  median,
  type Sample,
  sha256Hex,
  summarize,
} from '@aom/shared';
import { type Queryable, rows } from '../db/sql.ts';

/**
 * The measured effect of the code graph (docs/design/project-graphs.md section 11), per organization: for each arm, the
 * billed input tokens per accepted card (median and quartiles), the ratio of the arms with a bootstrap interval stratified by
 * card type and size, and the quality guards side by side. The "X% fewer tokens" statement is only offered when the claim
 * rule of the design holds; until then the numbers are shown as they are.
 */
export async function graphContextReport(
  db: Queryable,
  orgId: string,
  projectIds: string[] | null,
  now: Date,
): Promise<GraphContextReport> {
  const cards = await rows<{
    card_id: string;
    arm: 'on' | 'off';
    card_type: string;
    risk_tier: string | null;
    tokens: string;
    discovery_bytes: string;
    discovery_calls: string;
    graph_calls: string;
    rework: number;
    days: string | number | null;
    cost_micros: string;
    changes: string;
    failures: string;
  }>(
    db,
    `WITH arms AS (
       SELECT DISTINCT ON (m.card_id) m.card_id, m.graph_arm AS arm
         FROM shift_context_metrics m WHERE m.org_id = $1 AND ($2::uuid[] IS NULL OR m.project_id = ANY($2::uuid[]))
        ORDER BY m.card_id, m.measured_at, m.shift_id
     ), sums AS (
       SELECT m.card_id, sum(m.billed_input_tokens) AS tokens, sum(m.discovery_bytes) AS discovery_bytes,
              sum(m.discovery_calls) AS discovery_calls, sum(m.graph_calls) AS graph_calls
         FROM shift_context_metrics m WHERE m.org_id = $1 GROUP BY m.card_id
     )
     SELECT c.id AS card_id, a.arm, c.card_type, c.risk_tier, s.tokens, s.discovery_bytes, s.discovery_calls, s.graph_calls,
            c.rework_round AS rework,
            extract(epoch FROM (c.finalized_at - c.created_at)) / 86400.0 AS days,
            COALESCE((SELECT sum(sc.cost_usd_micros) FROM shift_costs sc WHERE sc.card_id = c.id), 0) AS cost_micros,
            (SELECT count(*) FROM card_handoffs h WHERE h.card_id = c.id AND h.outcome = 'changes') AS changes,
            (SELECT count(*) FROM card_handoffs h WHERE h.card_id = c.id AND h.outcome = 'fail') AS failures
       FROM cards c JOIN arms a ON a.card_id = c.id JOIN sums s ON s.card_id = c.id
      WHERE c.org_id = $1 AND c.status = 'done' AND c.card_type NOT IN ('regression','feed')`,
    [orgId, projectIds],
  );
  const sample = (r: (typeof cards)[number]): Sample => ({
    value: Number(r.tokens),
    stratum: `${r.card_type}/${r.risk_tier ?? 'unknown'}`,
  });
  const of = (arm: 'on' | 'off') => cards.filter((c) => c.arm === arm);
  const guards = (xs: typeof cards): Guards | null =>
    xs.length === 0
      ? null
      : {
          reworkRounds: xs.reduce((a, c) => a + c.rework, 0) / xs.length,
          changesRequested: xs.reduce((a, c) => a + Number(c.changes), 0) / xs.length,
          testerFailures: xs.reduce((a, c) => a + Number(c.failures), 0) / xs.length,
          daysToDone: xs.reduce((a, c) => a + Number(c.days ?? 0), 0) / xs.length,
          costPerCardUsd: xs.reduce((a, c) => a + Number(c.cost_micros), 0) / xs.length / 1_000_000,
        };
  const on = of('on');
  const off = of('off');
  const sOn = summarize(on.map(sample));
  const sOff = summarize(off.map(sample));
  // the interval is reproducible: the seed is the organization, not the clock
  const seed = Number.parseInt(sha256Hex(orgId).slice(0, 8), 16);
  const interval = bootstrapRatio(on.map(sample), off.map(sample), 2000, seed);
  const gOn = guards(on);
  const gOff = guards(off);
  const dis = (xs: typeof cards) => ({
    medianBytes: xs.length ? Math.round(median(xs.map((c) => Number(c.discovery_bytes)))) : null,
    medianCalls: xs.length ? Math.round(median(xs.map((c) => Number(c.discovery_calls)))) : null,
    medianGraphCalls: xs.length ? Math.round(median(xs.map((c) => Number(c.graph_calls)))) : null,
  });
  // the window: four weeks after the first index of a project of this organization that has measured shifts
  const first = (
    await rows<{ at: Date | null }>(
      db,
      `SELECT min(g.indexed_at) AS at FROM project_graphs g WHERE g.org_id = $1 AND g.indexed_at IS NOT NULL
          AND ($2::uuid[] IS NULL OR g.project_id = ANY($2::uuid[]))`,
      [orgId, projectIds],
    )
  )[0]?.at;
  const windowEnd = first ? new Date(first.getTime() + GRAPH_EVALUATION_WEEKS * 7 * 24 * 3600_000) : null;
  return {
    evaluating: !!windowEnd && now.getTime() < windowEnd.getTime(),
    windowEndsAt: windowEnd ? windowEnd.toISOString() : null,
    on: sOn,
    off: sOff,
    interval,
    guards: { on: gOn, off: gOff },
    discovery: { on: dis(on), off: dis(off) },
    claim: graphClaim(sOn, sOff, interval, gOn, gOff),
  };
}
