import type { Workability } from '@aom/shared';
import { getStage } from '@aom/shared';
import { loadRole, loadWorkflowById } from '../catalogue/loader.ts';
import type { Ctx } from '../context.ts';
import { type Row, rows } from '../db/sql.ts';
import { eligibility, ONLINE_WINDOW_MS } from '../dispatcher/candidates.ts';

/** A queued card nobody free took for this long is reported as "waiting: everyone is busy" (shorter is plain queueing). */
const BUSY_REPORT_AFTER_MS = 10 * 60_000;

const OK: Workability = { ok: true };

/** Names `a`, `a and b`, `a, b and c`. */
const nameList = (names: string[]): string =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/**
 * The dispatcher's own eligibility clauses (`eligibility()` in dispatcher/candidates.ts), evaluated for every hired
 * agent of each card's scope instead of for one bound agent. Per (card, agent) one boolean per clause.
 */
const AGENT_REFS = {
  id: 'a.id',
  orgId: 'a.org_id',
  projectId: 'a.project_id',
  roleKey: 'a.role_key',
  senior: `(a.seniority = 'senior')`,
  workstationId: 'ws.id',
  capabilities: `COALESCE((SELECT ARRAY(SELECT jsonb_array_elements_text(r->'capabilities'))
                             FROM jsonb_array_elements(ws.runtimes) r WHERE r->>'id' = a.runtime LIMIT 1), ARRAY[]::text[])`,
  riskTiers: `ARRAY(SELECT jsonb_array_elements_text(COALESCE(a.permissions->'riskTiers', '["small","large"]'::jsonb)))`,
};
const E = eligibility(AGENT_REFS);

const AGENTS_SQL = `
SELECT c.id AS card_id, a.id AS agent_id, a.name, a.capacity,
       (a.seniority = 'senior') AS is_senior,
       (${E.senior}) AS senior_ok, (${E.notExcluded}) AS not_excluded, (${E.tier}) AS tier_ok,
       (${E.home}) AS home_ok, (${E.worktree}) AS worktree_ok, (${E.repo}) AS repo_ok,
       (${E.vault}) AS vault_ok, (${E.caps}) AS caps_ok,
       (ws.status = 'active' AND wu.status = 'active' AND ws.connected AND ws.last_seen_at > $2
         AND EXISTS (SELECT 1 FROM jsonb_array_elements(ws.runtimes) r
                      WHERE r->>'id' = a.runtime AND COALESCE((r->>'available')::boolean, false))) AS online,
       ((SELECT count(*) FROM cards x WHERE x.claimed_by_agent_id = a.id AND x.claim_id IS NOT NULL) >= a.capacity) AS busy
  FROM cards c
  JOIN projects p ON p.id = c.project_id
  JOIN workflow_stages st ON st.workflow_version_id = c.workflow_version_id AND st.stage_id = c.stage
  JOIN agents a ON a.status = 'active' AND NOT a.is_devops AND ${E.scope} AND ${E.role}
  JOIN workstations ws ON ws.id = a.workstation_id
  JOIN users wu ON wu.id = ws.user_id
 WHERE c.id = ANY($1)
 ORDER BY a.hired_at, a.id`;

/**
 * For each open, unclaimed card (`queued`, no claim): could ANY agent ever take its current stage? Evaluated at read
 * time with the dispatcher's own eligibility clauses, so hiring, firing, role changes and claims show on the next read
 * (the web refetches the board and card on those events). Other cards are `ok`.
 */
export async function cardWorkability(ctx: Ctx, cards: Row[]): Promise<Map<string, Workability>> {
  const out = new Map<string, Workability>();
  const open = cards.filter((c) => c.status === 'queued' && !c.claim_id);
  if (open.length === 0) return out;
  const now = ctx.clock.now();
  const agentRows = await rows(ctx.pool, AGENTS_SQL, [
    open.map((c) => c.id),
    new Date(now.getTime() - ONLINE_WINDOW_MS),
  ]);
  const byCard = new Map<string, Row[]>();
  for (const r of agentRows) byCard.set(r.card_id, [...(byCard.get(r.card_id) ?? []), r]);

  const roleNames = new Map<string, string>();
  const roleName = async (orgId: string, key: string): Promise<string> => {
    const k = `${orgId}/${key}`;
    if (!roleNames.has(k)) roleNames.set(k, (await loadRole(ctx.pool, orgId, key))?.definition.name ?? key);
    return roleNames.get(k) as string;
  };

  for (const c of open) {
    const wf = await loadWorkflowById(ctx.pool, c.workflow_version_id);
    const stage = wf ? getStage(wf.definition, c.stage) : undefined;
    if (!stage || stage.kind !== 'agent' || !stage.claimRole) continue; // a manual or terminal stage: nobody claims it
    const project = (await rows(ctx.pool, 'SELECT status FROM projects WHERE id=$1', [c.project_id]))[0];
    if (project?.status !== 'active') continue;
    const verdict = await judge(c, stage, byCard.get(c.id) ?? [], now);
    if (!verdict.ok) out.set(c.id, verdict);
    else out.set(c.id, OK);
  }
  return out;

  async function judge(
    c: Row,
    st: NonNullable<ReturnType<typeof getStage>>,
    agents: Row[],
    nowDate: Date,
  ): Promise<Workability> {
    const role = await roleName(c.org_id, st.claimRole as string);
    const roleLower = role.toLowerCase();
    const seniorWord = st.seniorOnly ? 'senior ' : '';
    const hire = {
      roleKey: st.claimRole as string,
      ...(st.seniorOnly ? { seniority: 'senior' as const } : {}),
    };
    const blocked = (reason: string): Workability => ({
      ok: false,
      level: 'blocked',
      reason: `Not workable: ${reason}`,
      hire,
    });
    const waiting = (reason: string): Workability => ({
      ok: false,
      level: 'waiting',
      reason: `Waiting: ${reason}`,
    });
    const tier = (c.risk_tier ?? 'small') as 'small' | 'large';

    // 1. Is anybody hired for this stage at all?
    if (agents.length === 0)
      return blocked(
        `no ${roleLower} is hired for this project, and the ${c.stage} stage needs one. Hire a ${seniorWord}${roleLower}.`,
      );
    // 2. Seniority.
    const senior = agents.filter((a) => a.senior_ok);
    if (senior.length === 0)
      return blocked(
        `this stage needs a senior ${roleLower}, but only junior ones are hired (${nameList(agents.map((a) => a.name))}). Hire a senior ${roleLower}.`,
      );
    // 3. Risk tiers the agents accept.
    const tierOk = senior.filter((a) => a.tier_ok);
    if (tierOk.length === 0)
      return blocked(
        `no ${seniorWord}${roleLower} accepts ${c.risk_tier} changes (their risk tiers exclude it). Hire one or widen an agent's risk tiers.`,
      );
    // 4. Not excluded for this card: the builder never reviews their own work, and a second review is by someone else.
    const required = st.approvals?.[tier] ?? 1;
    const needed = Math.max(1, required - Number(c.review_approvals ?? 0));
    const free = tierOk.filter((a) => a.not_excluded);
    if (free.length < needed) {
      const excluded = tierOk.filter((a) => !a.not_excluded);
      const others = nameList(excluded.map((a) => a.name));
      const builderIsExcluded = excluded.some((a) => a.agent_id === c.original_builder_agent_id);
      let why: string;
      if (required > 1 && Number(c.review_approvals ?? 0) > 0)
        why = `this ${tier} change needs a second ${seniorWord}${roleLower} other than ${others}. Hire another ${seniorWord}${roleLower}.`;
      else if (required > 1)
        why = `this ${tier} change needs ${required} different ${seniorWord}${roleLower}s${builderIsExcluded ? ' (and not its builder)' : ''}, but only ${nameList(tierOk.map((a) => a.name))} can take it. Hire another ${seniorWord}${roleLower}.`;
      else if (builderIsExcluded)
        why = `the only ${seniorWord}${roleLower} (${others}) built this card and cannot review their own work. Hire another ${seniorWord}${roleLower}.`;
      else
        why = `every eligible ${roleLower} (${others}) is excluded from this stage. Hire another ${seniorWord}${roleLower}.`;
      return blocked(why);
    }
    // From here on someone is hired who could take it: the rest is where they are and whether they are up.
    // 5. Placement: the card's repo, vault, worktree home and capabilities on some eligible agent's workstation.
    const placed = free.filter((a) => a.home_ok && a.worktree_ok && a.repo_ok && a.vault_ok && a.caps_ok);
    if (placed.length === 0) return waiting(await placementReason(c, free, roleLower));
    // 6. Online.
    const online = placed.filter((a) => a.online);
    if (online.length === 0) {
      const names = placed.map((a) => `${role} ${a.name}`);
      return waiting(
        placed.length <= 3
          ? `${nameList(names)} ${placed.length === 1 ? 'is' : 'are'} offline.`
          : `all ${placed.length} eligible ${roleLower}s are offline.`,
      );
    }
    // 7. Busy (reported only after a while: a short queue is normal).
    if (
      online.every((a) => a.busy) &&
      c.queued_at &&
      nowDate.getTime() - new Date(c.queued_at).getTime() > BUSY_REPORT_AFTER_MS
    )
      return waiting(
        `${nameList(online.map((a) => a.name))} ${online.length === 1 ? 'is' : 'are'} busy with other work.`,
      );
    return OK;
  }

  async function placementReason(c: Row, free: Row[], roleLower: string): Promise<string> {
    const allFail = (key: string) => free.every((a) => !a[key]);
    if (allFail('home_ok')) {
      const ws = (
        await rows(ctx.pool, 'SELECT name FROM workstations WHERE id=$1', [c.home_workstation_id])
      )[0];
      return `the card's worktree lives on workstation ${ws?.name ?? 'another machine'}, which has no eligible ${roleLower}.`;
    }
    if (allFail('worktree_ok'))
      return `the card shares the worktree of another card, whose workstation has no eligible ${roleLower}.`;
    if (allFail('repo_ok')) {
      const repo = (await rows(ctx.pool, 'SELECT name FROM project_repos WHERE id=$1', [c.repo_id]))[0];
      return `no workstation with an eligible ${roleLower} holds repo ${repo?.name ?? 'of this card'}.`;
    }
    if (allFail('vault_ok')) return `no workstation with an eligible ${roleLower} holds the project's vault.`;
    if (allFail('caps_ok'))
      return `no eligible ${roleLower} has the capabilities this card needs (${(c.required_capabilities ?? []).join(', ')}).`;
    return `no workstation can host this card for an eligible ${roleLower}.`;
  }
}
