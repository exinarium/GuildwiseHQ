import { one, rows } from '../db/sql.ts';
import type { ActionEnv } from './types.ts';

const money = (m: number) => `$${(m / 1e6).toFixed(2)}`;

/**
 * The budget guard of D12 (docs/design/ceo-agent-v2.md section 3.4): a hire or a model-up is allowed only while the
 * forecast spend of the month for the project it works on stays under `budgetHeadroom` of the project's budget. The
 * forecast is the month so far spread over the days passed, plus what one more agent (or the dearer model) would add.
 * Projects without a budget do not hold it back. Returns the reason it is blocked, or undefined.
 */
export async function budgetBlock(
  env: ActionEnv,
  projectIds: string[] | null,
  kind: 'hire' | 'model_up',
  agentMonthMicros = 0,
): Promise<string | undefined> {
  const now = env.now;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const elapsed = Math.max(1, (now.getTime() - start.getTime()) / 86_400_000);
  // The optional organization budget holds hires and model-ups back too.
  if (env.ceo.settings.orgBudgetMonthlyMicros > 0) {
    const { orgBudgetState } = await import('./orgbudget.ts');
    const st = await orgBudgetState(env.ctx, env.ceo, now);
    const org = (st.spent / elapsed) * daysInMonth;
    const nAgents = await one<{ n: string }>(env.ctx.pool, `SELECT count(*)::text AS n FROM agents WHERE org_id=$1 AND status='active' AND NOT is_devops AND role_key <> 'ceo'`, [env.orgId]);
    const add = kind === 'hire' ? org / Math.max(1, Number(nAgents?.n ?? 1)) : agentMonthMicros * 0.5;
    if (org + add > env.ceo.policy.limits.budgetHeadroom * st.budget)
      return `the organization budget: the forecast ${money(org + add)} for the month would pass ${Math.round(env.ceo.policy.limits.budgetHeadroom * 100)}% of ${money(st.budget)}`;
  }
  const projects = await rows(
    env.ctx.pool,
    `SELECT p.id, p.key, p.budget_micros,
            (SELECT COALESCE(sum(cost_usd_micros),0) FROM shift_costs s WHERE s.project_id = p.id AND s.ended_at >= $3) AS spent
       FROM projects p
      WHERE p.org_id=$1 AND p.status='active' AND p.kind='project' AND p.budget_micros IS NOT NULL
        AND ($2::uuid[] IS NULL OR p.id = ANY($2::uuid[]))`,
    [env.orgId, projectIds, start],
  );
  if (projects.length === 0) return undefined;
  const agents = await one<{ n: string }>(
    env.ctx.pool,
    `SELECT count(*)::text AS n FROM agents WHERE org_id=$1 AND status='active' AND NOT is_devops AND role_key <> 'ceo' AND paused_at IS NULL`,
    [env.orgId],
  );
  const n = Math.max(1, Number(agents?.n ?? 1));
  const limit = env.ceo.policy.limits.budgetHeadroom;
  for (const p of projects) {
    const spent = Number(p.spent);
    const forecast = (spent / elapsed) * daysInMonth;
    const added = kind === 'hire' ? forecast / n : agentMonthMicros * 0.5;
    const budget = Number(p.budget_micros);
    if (forecast + added > limit * budget)
      return `${p.key}: the forecast ${money(forecast + added)} for the month would pass ${Math.round(limit * 100)}% of the ${money(budget)} budget`;
  }
  return undefined;
}

/** A hire must cite a current HR recommendation or an open signal: the server refuses evidence-free hires. */
export async function hireEvidenceMissing(env: ActionEnv): Promise<boolean> {
  for (const raw of env.evidence) {
    const [kind, id] = raw.split(':');
    if (!id) continue;
    if (kind === 'signal' && /^[0-9a-f-]{36}$/i.test(id)) {
      if (await one(env.ctx.pool, 'SELECT 1 FROM ba_signals WHERE id=$1 AND org_id=$2', [id, env.orgId])) return false;
    }
    if (kind === 'hr') {
      const { computeRecommendations } = await import('../hr/recommendations.ts');
      const recs = await computeRecommendations(env.ctx, env.orgId);
      if (recs.some((r) => r.id === id)) return false;
    }
    if (kind === 'desk' && /^[0-9a-f-]{36}$/i.test(id)) {
      if (await one(env.ctx.pool, `SELECT 1 FROM desk_items WHERE id=$1 AND org_id=$2 AND subkind='tester_bottleneck'`, [id, env.orgId])) return false;
    }
  }
  return true;
}
