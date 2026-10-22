import { parseDiscoveryConfig, type SessionCost } from '@aom/shared';
import { budgetPausedSql } from '../costs/index.ts';
import { one, type Queryable, type Row } from '../db/sql.ts';
import { projectPausedSql } from '../dispatcher/project-hold.ts';
import { conflict } from '../errors.ts';

/**
 * What a session has cost so far: its turns' rows in `shift_costs` (kind `session`, keyed by the turn id; written by the
 * `SessionTurnCompleted` projector, so the figure is replay-safe and the same money the org cost pages and project
 * budgets count).
 */
export async function sessionCost(db: Queryable, t: Row): Promise<SessionCost> {
  const r = await one(
    db,
    `SELECT COALESCE(sum(sc.cost_usd_micros),0)::bigint AS micros, count(*)::int AS turns
       FROM shift_costs sc JOIN session_turns st ON st.id = sc.shift_id WHERE st.thread_id = $1`,
    [t.id],
  );
  const costMicros = Number(r?.micros ?? 0);
  const cfg = parseDiscoveryConfigOf(t);
  return {
    costMicros,
    costUsd: costMicros / 1_000_000,
    turns: r?.turns ?? 0,
    budgetUsd: cfg.budgetUsd,
    exceeded: cfg.budgetUsd !== null && costMicros >= cfg.budgetUsd * 1_000_000,
  };
}

const parseDiscoveryConfigOf = (t: Row) => parseDiscoveryConfig(t.session_config);

/**
 * A new turn of this session may not start: the session's own budget (`budgetUsd` in its config) is used up, or its
 * project is paused (by hand, or because its monthly budget is used up). The error is meant to be shown as it is.
 */
export async function assertSessionMayQueue(db: Queryable, t: Row, now: Date): Promise<void> {
  const cfg = t.session_config as { budgetUsd?: number | null } | null;
  if (cfg?.budgetUsd) {
    const c = await sessionCost(db, t);
    if (c.exceeded)
      throw conflict(
        'session_budget_exceeded',
        `This session has used its budget of $${cfg.budgetUsd.toFixed(2)} (spent $${c.costUsd.toFixed(2)}). Raise the budget to continue.`,
        { budgetUsd: cfg.budgetUsd, costUsd: c.costUsd },
      );
  }
  if (t.project_id) {
    const p = await one(
      db,
      `SELECT ${projectPausedSql('p')} AS paused, ${budgetPausedSql('p', '$2')} AS budget_paused FROM projects p WHERE p.id=$1`,
      [t.project_id, now],
    );
    if (p?.paused)
      throw conflict('project_paused', 'The project of this session is paused: resume it to continue.');
    if (p?.budget_paused)
      throw conflict(
        'project_budget_paused',
        'The project of this session has used up its monthly budget: raise it or override it for this month to continue.',
      );
  }
}
