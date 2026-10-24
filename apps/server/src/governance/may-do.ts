import {
  type AgentMayDo,
  GATE_CLASSES,
  GATE_INFO,
  normalizeScopes,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { effectiveRegistry } from '../capabilities/registry.ts';
import { orgCostCtx, spendBriefs } from '../costs/index.ts';
import { monthOf } from '../costs/index.ts';
import type { Ctx } from '../context.ts';
import { one, rows } from '../db/sql.ts';
import { notFound } from '../errors.ts';
import { grantsWithHandles } from '../sessions/delegate-grants.ts';
import { agentsPacksGranted, packScopes } from './scopes.ts';
import { gatedClassesOf } from './gates.ts';

/**
 * "What it may do" for one agent: everything that decides what the agent can do, in one answer. Read-only; every number comes from
 * the same tables the enforcement reads (permissions, grants, gates, budgets), so the screen cannot drift from the rules.
 */
export async function getAgentMayDo(ctx: Ctx, user: AuthSession['user'], agentId: string): Promise<AgentMayDo> {
  const agent = await one(ctx.pool, 'SELECT * FROM agents WHERE id=$1', [agentId]);
  if (!agent) throw notFound('agent not found');
  const role = await orgRoleOf(ctx.pool, user.id, agent.org_id);
  if (!role) throw notFound('agent not found');
  const perms = (agent.permissions ?? {}) as Record<string, any>;
  const canManage = role === 'owner' || role === 'admin' || agent.manager_user_id === user.id;
  const manager = role === 'owner' || role === 'admin';
  const now = ctx.clock.now();

  // repositories
  let repos: AgentMayDo['repos']['repos'] = null;
  if (Array.isArray(perms.repoIds)) {
    repos = (
      await rows(ctx.pool, 'SELECT id, name FROM project_repos WHERE id = ANY($1::uuid[])', [perms.repoIds])
    ).map((r) => ({ id: r.id as string, name: r.name as string }));
  }
  // data scopes: the projects it may work on
  const allowed = agent.allowed_project_ids as string[] | null;
  const projects =
    allowed === null
      ? null
      : (
          await rows(ctx.pool, 'SELECT id, key, name FROM projects WHERE id = ANY($1::uuid[]) ORDER BY key', [
            allowed,
          ])
        ).map((p) => ({ id: p.id as string, key: p.key as string, name: p.name as string }));
  const tools: string[] = perms.allowedTools ?? [];

  // which key pays: from the agent's latest recorded work
  const lastCost = await one(
    ctx.pool,
    `SELECT key_source, key_provider FROM shift_costs WHERE agent_id=$1 ORDER BY ended_at DESC LIMIT 1`,
    [agentId],
  );
  const ws = agent.workstation_id
    ? await one(ctx.pool, 'SELECT name FROM workstations WHERE id=$1', [agent.workstation_id])
    : null;

  // delegation grants, role-inherited and excluded ones included
  const grants = await grantsWithHandles(ctx.pool, 'agent', agentId, true);
  const delegation = grants.map((g) => ({
    kind: g.row.target_kind as 'persona' | 'agent',
    name: g.agent?.name ?? (g.row.target_key as string),
    handle: g.handle,
    inherited: g.row.inherited === true,
    excluded: g.row.excluded === true,
    maxCalls: g.row.max_calls as number,
    maxProfile: (g.row.max_profile ?? null) as string | null,
  }));

  // playbook and skill grants, with what each needs
  const reg = await effectiveRegistry(ctx.pool, agent.org_id, { usableOnly: true, userId: user.id });
  const meta = new Map(reg.items.map((i) => [`${i.kind}:${i.key}`, i as unknown as { name: string; scopes?: string[] }]));
  const playbookKeys = (
    await rows(ctx.pool, 'SELECT playbook_key FROM agent_playbook_grants WHERE agent_id=$1 ORDER BY playbook_key', [
      agentId,
    ])
  ).map((r) => r.playbook_key as string);
  const playbooks = playbookKeys.map((key) => ({ key, name: meta.get(`playbook:${key}`)?.name ?? key }));
  const skills = ((agent.skills ?? []) as string[]).map((key) => ({
    key,
    scopes: normalizeScopes(meta.get(`skill:${key}`)?.scopes),
  }));
  const packs = [];
  for (const p of await agentsPacksGranted(ctx.pool, agentId))
    packs.push({ packId: p.id as string, name: p.name as string, scopes: await packScopes(ctx.pool, p.id) });

  // spend and the budgets in force
  const cost = await orgCostCtx(ctx.pool, agent.org_id);
  const spend = (await spendBriefs(ctx.pool, cost, now, 'agent', [agentId])).get(agentId);
  const m = monthOf(cost, now);
  const budgets: NonNullable<AgentMayDo['spend']>['budgets'] = [];
  const budgetProjects = await rows(
    ctx.pool,
    `SELECT p.id, p.key, p.budget_micros,
            COALESCE((SELECT sum(sc.cost_usd_micros) FROM shift_costs sc WHERE sc.project_id = p.id AND sc.ended_at >= $2 AND sc.ended_at < $3), 0) AS usd
       FROM projects p
      WHERE p.org_id=$1 AND p.kind='project' AND p.budget_micros IS NOT NULL AND ($4::uuid[] IS NULL OR p.id = ANY($4::uuid[]))
      ORDER BY p.key LIMIT 10`,
    [agent.org_id, m.start, m.next, allowed],
  );
  for (const b of budgetProjects)
    budgets.push({
      label: `Project ${b.key}, monthly`,
      capMicros: Number(b.budget_micros),
      usedMicros: Math.round(Number(b.usd) * Number(cost.usdRate)),
    });
  if (lastCost?.key_source === 'org' && lastCost.key_provider) {
    const cap = await one(ctx.pool, 'SELECT cap_micros FROM org_providers WHERE org_id=$1 AND provider=$2', [
      agent.org_id,
      lastCost.key_provider,
    ]);
    if (cap?.cap_micros) {
      const used = await one(
        ctx.pool,
        `SELECT COALESCE(sum(cost_usd_micros),0) AS usd FROM shift_costs
          WHERE org_id=$1 AND key_source='org' AND key_provider=$2 AND ended_at >= $3 AND ended_at < $4`,
        [agent.org_id, lastCost.key_provider, m.start, m.next],
      );
      budgets.push({
        label: `Organization ${lastCost.key_provider} key, monthly cap`,
        capMicros: Number(cap.cap_micros),
        usedMicros: Math.round(Number(used?.usd ?? 0) * Number(cost.usdRate)),
      });
    }
  }

  // gates
  const gated = await gatedClassesOf(ctx.pool, agentId);
  const pending = await rows<{ action_class: string; n: string }>(
    ctx.pool,
    `SELECT action_class, count(*) AS n FROM gated_actions WHERE agent_id=$1 AND status='pending' GROUP BY 1`,
    [agentId],
  );
  const pendingBy = new Map(pending.map((p) => [p.action_class, Number(p.n)]));
  const gates = GATE_CLASSES.map((c) => ({
    actionClass: c,
    label: GATE_INFO[c].label,
    description: GATE_INFO[c].description,
    enforcement: GATE_INFO[c].enforcement,
    note: GATE_INFO[c].note,
    gated: GATE_INFO[c].enforcement === 'always' ? true : gated.has(c),
    pending: pendingBy.get(c) ?? 0,
  }));

  return {
    agentId,
    agentName: agent.name,
    tools: {
      allowedTools: tools,
      deniedShellPatterns: perms.deniedShellPatterns ?? [],
      writableGlobs: perms.writableGlobs ?? null,
      mayCommit: perms.mayCommit === true,
      browser: perms.browser === true,
      riskTiers: perms.riskTiers ?? ['small', 'large'],
    },
    repos: { readOrgRepos: perms.readOrgRepos === true, repos },
    data: {
      projects,
      mcpServers: tools.filter((t) => t.startsWith('mcp:')).map((t) => t.slice(4)),
    },
    provider: {
      runtime: agent.runtime,
      model: agent.model,
      effort: agent.effort ?? null,
      workstation: ws?.name ?? null,
      keySource: lastCost
        ? lastCost.key_source === 'org'
          ? 'org'
          : lastCost.key_source === 'workstation'
            ? 'workstation'
            : 'login'
        : 'unknown',
    },
    delegation,
    playbooks,
    skills,
    packs,
    spend: spend
      ? { currency: spend.currency, monthMicros: spend.monthMicros, totalMicros: spend.totalMicros, budgets }
      : null,
    gates,
    canGate: canManage && agent.role_key !== 'ceo',
    canUngate: manager && agent.role_key !== 'ceo',
  };
}
