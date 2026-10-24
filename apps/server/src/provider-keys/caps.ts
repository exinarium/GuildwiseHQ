import {
  BUDGET,
  type BudgetState,
  budgetStatus,
  choiceKeyUse,
  formatMoney,
  type KeyUseReport,
  type ModelChoice,
  PROVIDER_KEY_LABEL,
  providerOfChoice,
} from '@aom/shared';
import { monthOf, orgCostCtx } from '../costs/index.ts';
import { one, type Queryable } from '../db/sql.ts';
import { conflict } from '../errors.ts';

/**
 * Monthly spend caps of the organization's provider keys (docs/ARCHITECTURE.md section 38.5), shaped like the project budgets of
 * `commands/budgets.ts`. The spend is the calendar month's `shift_costs` whose `key_source` is `org` and whose `key_provider` is the
 * provider (shift, session and delegate rows alike); a run on a workstation's own key is not counted and not stopped. Turns and
 * shifts with no price are counted as unknown: they are in the spend as zero, and the page says how many there were.
 */
export interface ProviderCapState {
  provider: string;
  /** USD micros, or null (no cap). */
  capMicros: number | null;
  spendMicros: number;
  unknownCostTurns: number;
  percent: number | null;
  state: BudgetState;
  month: string;
  /** First instant of the next month. */
  resetsAt: Date;
  overridden: boolean;
}

export async function providerCapState(
  db: Queryable,
  orgId: string,
  provider: string,
  now: Date,
): Promise<ProviderCapState> {
  const row = await one(
    db,
    'SELECT cap_micros, cap_override_month FROM org_providers WHERE org_id = $1 AND provider = $2',
    [orgId, provider],
  );
  const c = await orgCostCtx(db, orgId);
  const m = monthOf(c, now);
  const spend = await one(
    db,
    `SELECT COALESCE(sum(cost_usd_micros), 0) AS usd, count(*) FILTER (WHERE cost_unknown)::int AS unknown
       FROM shift_costs
      WHERE org_id = $1 AND key_source = 'org' AND key_provider = $2 AND ended_at >= $3 AND ended_at < $4`,
    [orgId, provider, m.start, m.next],
  );
  const cap = row?.cap_micros === null || row?.cap_micros === undefined ? null : Number(row.cap_micros);
  const spendMicros = Number(spend?.usd ?? 0);
  const overridden = row?.cap_override_month === m.key;
  const { state, percent } = budgetStatus(cap, spendMicros, overridden);
  return {
    provider,
    capMicros: cap,
    spendMicros,
    unknownCostTurns: Number(spend?.unknown ?? 0),
    percent,
    state,
    month: m.key,
    resetsAt: m.next,
    overridden,
  };
}

/** The text shown when a run is refused because the cap on the organization's key is reached. */
export function capReachedText(provider: string, s: ProviderCapState): string {
  const label = PROVIDER_KEY_LABEL[provider] ?? provider;
  return `The organization's ${label} key has used its monthly cap of ${formatMoney(s.capMicros ?? 0, 'USD')} (spent ${formatMoney(s.spendMicros, 'USD')}). Raise the cap or override it for this month under Settings > Model providers, or run this on a workstation with its own ${label} key.`;
}

/**
 * Why a run of `choice` on a workstation that reported `reports` must not start: it would spend the organization's key of a
 * provider whose cap is reached. Null when it spends no key, the workstation's own key (never capped), or has headroom. A cap that
 * is 'overridden' for the month lets runs through. `cache` shares the answer for one pass over many agents.
 */
export async function providerCapProblem(
  db: Queryable,
  orgId: string,
  reports: readonly KeyUseReport[],
  choice: Pick<ModelChoice, 'runtime' | 'model'>,
  now: Date,
  cache?: Map<string, ProviderCapState>,
): Promise<string | null> {
  const use = choiceKeyUse(reports, choice, orgId);
  if (!use || use.source !== 'org') return null;
  const key = `${orgId}|${use.provider}`;
  let st = cache?.get(key);
  if (!st) {
    st = await providerCapState(db, orgId, use.provider, now);
    cache?.set(key, st);
  }
  return st.state === 'paused' ? capReachedText(use.provider, st) : null;
}

/** The same for an agent row joined with its workstation's `runtimes`. */
export async function agentCapBlocked(
  db: Queryable,
  agent: { org_id: string; runtime: string; model: string; runtimes?: unknown },
  now: Date,
  cache?: Map<string, ProviderCapState>,
): Promise<string | null> {
  if (!providerOfChoice(agent.runtime, agent.model)) return null;
  const reports = Array.isArray(agent.runtimes) ? (agent.runtimes as KeyUseReport[]) : [];
  return providerCapProblem(
    db,
    agent.org_id,
    reports,
    { runtime: agent.runtime, model: agent.model },
    now,
    cache,
  );
}

/** Throws the conflict a queued run is refused with. */
export async function assertProviderCapRoom(
  db: Queryable,
  orgId: string,
  reports: readonly KeyUseReport[],
  choice: Pick<ModelChoice, 'runtime' | 'model'>,
  now: Date,
): Promise<void> {
  const problem = await providerCapProblem(db, orgId, reports, choice, now);
  if (problem) throw conflict('provider_cap_reached', problem);
}

export { BUDGET };
