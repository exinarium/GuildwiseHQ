import { CODE_BOARD_COLUMNS, columnFor, getStage, type MetricsResponse } from '@aom/shared';
import { loadVisibleProject } from '../authz/scope.ts';
import { loadWorkflowById } from '../catalogue/loader.ts';
import type { Ctx } from '../context.ts';
import { one, rows } from '../db/sql.ts';

const DAY_MS = 86_400_000;
const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * Manager dashboard metrics (docs/SPEC.md "Manager dashboard") for the projects the user belongs to (or one project),
 * over `[from, to)`: throughput per day, time blocked on the manager, bounce rate per builder, bugs escaped, duration
 * per card and per agent, and the queue depth per board column right now. Computed from the projections of the events
 * (cards, card_transitions, test_runs, shifts, agent_card_stats), so a rebuild gives the same numbers.
 */
export async function metrics(
  ctx: Ctx,
  userId: string,
  q: { projectId?: string | undefined; from?: string | undefined; to?: string | undefined },
): Promise<MetricsResponse> {
  const now = ctx.clock.now();
  const to = q.to ? new Date(q.to) : now;
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * DAY_MS);
  if (q.projectId) await loadVisibleProject(ctx.pool, userId, q.projectId);
  const projectIds = (
    await rows<{ project_id: string }>(
      ctx.pool,
      `SELECT project_id FROM project_members WHERE user_id=$1 AND status='active'
         AND ($2::uuid IS NULL OR project_id = $2)`,
      [userId, q.projectId ?? null],
    )
  ).map((r) => r.project_id);

  // Throughput: finalized cards per UTC day, every day of the range present.
  const days: string[] = [];
  for (
    let t = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
    t < to.getTime();
    t += DAY_MS
  )
    days.push(new Date(t).toISOString().slice(0, 10));
  const fin = new Map(
    (
      await rows<{ day: string; n: number }>(
        ctx.pool,
        `SELECT (finalized_at AT TIME ZONE 'UTC')::date::text AS day, count(*)::int AS n FROM cards
          WHERE project_id = ANY($1::uuid[]) AND status='done' AND card_type <> 'regression'
            AND finalized_at >= $2 AND finalized_at < $3 GROUP BY 1`,
        [projectIds, from, to],
      )
    ).map((r) => [r.day, r.n]),
  );

  // Time blocked on the manager: every interval a card sat in status 'blocked', clipped to the range. An interval
  // that only waited on questions the escalation chain handled (answered by a senior or the BA, or still with an
  // agent) is not the manager's: it counts only when a desk-level item (answered by the manager, open on the desk, an
  // approval or an alert) blocked the card in that interval.
  const blocked = await one<{ ms: string | null; cards: number }>(
    ctx.pool,
    `WITH t AS (
       SELECT tr.card_id, tr.to_status, tr.at, LEAD(tr.at) OVER (PARTITION BY tr.card_id ORDER BY tr.id) AS next_at
         FROM card_transitions tr JOIN cards c ON c.id = tr.card_id WHERE c.project_id = ANY($1::uuid[])),
     b AS (
       SELECT t.*,
              EXISTS (SELECT 1 FROM desk_items d
                       WHERE d.status <> 'superseded' AND (d.card_id = t.card_id OR t.card_id = ANY(d.affected_card_ids))
                         AND d.created_at < COALESCE(t.next_at, $3::timestamptz) AND COALESCE(d.answered_at, 'infinity') >= t.at
                         AND d.answered_by_agent_id IS NULL AND NOT (d.status = 'open' AND d.routed_to = 'agent')) AS on_desk,
              EXISTS (SELECT 1 FROM desk_items d
                       WHERE d.status <> 'superseded' AND (d.card_id = t.card_id OR t.card_id = ANY(d.affected_card_ids))
                         AND d.created_at < COALESCE(t.next_at, $3::timestamptz) AND COALESCE(d.answered_at, 'infinity') >= t.at
                         AND (d.answered_by_agent_id IS NOT NULL OR (d.status = 'open' AND d.routed_to = 'agent'))) AS in_chain
         FROM t WHERE to_status='blocked')
     SELECT COALESCE(sum(extract(epoch FROM (LEAST(COALESCE(next_at, $3::timestamptz), $3::timestamptz)
                                              - GREATEST(at, $2::timestamptz))) * 1000), 0)::bigint AS ms,
            count(DISTINCT card_id)::int AS cards
       FROM b WHERE at < $3 AND COALESCE(next_at, $3::timestamptz) > $2 AND (on_desk OR NOT in_chain)`,
    [projectIds, from, to],
  );
  const blockedMs = Number(blocked?.ms ?? 0);
  const blockedCards = Number(blocked?.cards ?? 0);

  // Bounce rate per builder: cards it submitted that came back from review or failed test.
  const bounce = await rows(
    ctx.pool,
    `SELECT s.agent_id, a.name, count(*) FILTER (WHERE s.submitted)::int AS submitted,
            COALESCE(sum(s.rework_rounds + s.spec_unclear_rounds), 0)::int AS review_bounces,
            COALESCE(sum(s.bugs), 0)::int AS test_failures,
            count(*) FILTER (WHERE s.submitted AND (s.rework_rounds + s.spec_unclear_rounds > 0 OR s.bugs > 0))::int AS bad
       FROM agent_card_stats s JOIN agents a ON a.id = s.agent_id
      WHERE s.project_id = ANY($1::uuid[]) AND s.submitted AND s.last_at >= $2 AND s.last_at < $3
      GROUP BY s.agent_id, a.name ORDER BY a.name`,
    [projectIds, from, to],
  );

  // Bugs escaped past test: every failed test run (feature test, full suite or regression).
  const bugs = await rows<{ day: string; n: number }>(
    ctx.pool,
    `SELECT (r.created_at AT TIME ZONE 'UTC')::date::text AS day, count(*)::int AS n
       FROM test_runs r JOIN cards c ON c.id = r.card_id
      WHERE c.project_id = ANY($1::uuid[]) AND r.result='failed' AND r.created_at >= $2 AND r.created_at < $3 GROUP BY 1`,
    [projectIds, from, to],
  );
  const bugByDay = new Map(bugs.map((b) => [b.day, b.n]));

  // Duration per card (created to finalized) and per agent (shift time).
  const dur = await one<{ n: number; avg: number | null; median: number | null }>(
    ctx.pool,
    `SELECT count(*)::int AS n,
            avg(extract(epoch FROM (finalized_at - created_at)) * 1000)::float AS avg,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (finalized_at - created_at)) * 1000)::float AS median
       FROM cards WHERE project_id = ANY($1::uuid[]) AND status='done' AND card_type <> 'regression'
        AND finalized_at >= $2 AND finalized_at < $3`,
    [projectIds, from, to],
  );
  const perAgent = await rows(
    ctx.pool,
    `SELECT s.agent_id, a.name, count(*)::int AS shifts, COALESCE(sum(s.duration_ms), 0)::bigint AS total
       FROM shifts s JOIN agents a ON a.id = s.agent_id JOIN cards c ON c.id = s.card_id
      WHERE c.project_id = ANY($1::uuid[]) AND s.status='ended' AND s.ended_at >= $2 AND s.ended_at < $3
      GROUP BY s.agent_id, a.name ORDER BY a.name`,
    [projectIds, from, to],
  );

  // Queue depth per board column, now.
  const open = await rows(
    ctx.pool,
    `SELECT status, stage, rework_round, card_type, workflow_version_id FROM cards
      WHERE project_id = ANY($1::uuid[]) AND status NOT IN ('done','cancelled')`,
    [projectIds],
  );
  const depth = new Map<string, number>();
  for (const c of open) {
    const wf = await loadWorkflowById(ctx.pool, c.workflow_version_id);
    const stage = wf ? getStage(wf.definition, c.stage) : undefined;
    const column = stage
      ? columnFor(
          { status: c.status, stage: c.stage, reworkRound: c.rework_round, cardType: c.card_type },
          stage,
        )
      : 'Other';
    depth.set(column, (depth.get(column) ?? 0) + 1);
  }
  const order: string[] = [...CODE_BOARD_COLUMNS];
  const queueDepth = [...depth.entries()]
    .map(([column, count]) => ({ column, count }))
    .sort(
      (a, b) =>
        (order.indexOf(a.column) < 0 ? 99 : order.indexOf(a.column)) -
          (order.indexOf(b.column) < 0 ? 99 : order.indexOf(b.column)) || a.column.localeCompare(b.column),
    );

  return {
    projectId: q.projectId ?? null,
    from: from.toISOString(),
    to: to.toISOString(),
    throughput: days.map((day) => ({ day, count: fin.get(day) ?? 0 })),
    timeBlockedOnManager: {
      totalMs: blockedMs,
      cards: blockedCards,
      avgMsPerCard: blockedCards ? Math.round(blockedMs / blockedCards) : null,
    },
    bounceRate: bounce.map((b) => ({
      agentId: b.agent_id,
      name: b.name,
      submitted: b.submitted,
      reviewBounces: b.review_bounces,
      testFailures: b.test_failures,
      rate: b.submitted > 0 ? round(b.bad / b.submitted) : null,
    })),
    bugsEscaped: {
      total: bugs.reduce((s, b) => s + b.n, 0),
      byDay: days.map((day) => ({ day, count: bugByDay.get(day) ?? 0 })),
    },
    duration: {
      cards: Number(dur?.n ?? 0),
      avgMsPerCard: dur?.avg == null ? null : Math.round(dur.avg),
      medianMsPerCard: dur?.median == null ? null : Math.round(dur.median),
      perAgent: perAgent.map((p) => ({
        agentId: p.agent_id,
        name: p.name,
        shifts: p.shifts,
        totalMs: Number(p.total),
        avgMsPerShift: p.shifts ? Math.round(Number(p.total) / p.shifts) : null,
      })),
    },
    queueDepth,
  };
}
