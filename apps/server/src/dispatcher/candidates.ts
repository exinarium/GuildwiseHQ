import { budgetPausedSql } from '../costs/index.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';

/** A runner that has not been heard from for this long counts as offline. */
export const ONLINE_WINDOW_MS = 45_000;

/** What the candidate query needs to know about an agent (docs/ARCHITECTURE.md section 9.3). */
export interface AgentView {
  id: string;
  orgId: string;
  /** Where the agent may work: a project list, or null for any project of its organization. */
  allowedProjectIds: string[] | null;
  /** Projects it prefers inside that list (soft: ordering only). */
  focusProjectIds: string[];
  roleKey: string;
  senior: boolean;
  workstationId: string;
  capabilities: string[];
  riskTiers: string[];
}

export function agentView(a: Row, capabilities: string[]): AgentView {
  return {
    id: a.id,
    orgId: a.org_id,
    allowedProjectIds: a.allowed_project_ids ?? null,
    focusProjectIds: a.focus_project_ids ?? [],
    roleKey: a.role_key,
    senior: a.seniority === 'senior',
    workstationId: a.workstation_id,
    capabilities,
    riskTiers: a.permissions?.riskTiers ?? ['small', 'large'],
  };
}

/**
 * How the eligibility clauses name the agent they test: the dispatcher binds one agent as query parameters
 * ($1..$8); the workability check (`queries/workability.ts`) tests every hired agent of a card's scope in one query,
 * so it names columns of `agents a` / `workstations ws` instead. Both build their clauses from `eligibility()` below,
 * so "could anyone ever take this card" can never drift from "can this agent take it now".
 */
export interface AgentRefs {
  id: string;
  orgId: string;
  /** The agent's allow-list as a uuid[] expression (NULL: any project). */
  allowedProjects: string;
  roleKey: string;
  senior: string;
  workstationId: string;
  capabilities: string;
  riskTiers: string;
}

/** The dispatcher's parameters, in the order `params()` binds them. */
export const PARAM_AGENT: AgentRefs = {
  id: '$1',
  orgId: '$2',
  allowedProjects: '$3',
  roleKey: '$4',
  senior: '$5',
  workstationId: '$6',
  capabilities: '$7',
  riskTiers: '$8',
};

/**
 * The conditions an agent must meet to take card `c` (aliases: `c` card, `p` project, `st` its workflow stage),
 * one named clause each. Hiring-level clauses say who could ever do the stage; placement clauses say where.
 */
export function eligibility(A: AgentRefs) {
  // Cards without a repo (research, feed) work on a vault: when the card's project has a registered vault the agent's
  // workstation must hold a clone of it (docs/ARCHITECTURE.md section 9.3, M3). The vault applicable to a card is its
  // project's vault, or the organization vault (only for workstations of its Owner and Admins, decision 12).
  const vaultOfCard = `(v.project_id = c.project_id
         OR (v.project_id IS NULL AND v.org_id = c.org_id AND v.kind = 'org'
             AND EXISTS (SELECT 1 FROM workstations w JOIN org_members om ON om.user_id = w.user_id
                          AND om.org_id = v.org_id AND om.status = 'active' AND om.role IN ('owner','admin')
                          WHERE w.id = ${A.workstationId})))`;
  return {
    // (An agent whose list is restricted still works an interest it is the assigned agent of.)
    // The agent's organization, then where its manager allowed it, then who may see the project: the user who owns the
    // agent's workstation must be an active member of the card's project (the Owner and Admins hold a row in every
    // project of their organization; a guest holds one only in the projects shared with them).
    scope: `c.org_id = ${A.orgId}
      AND (${A.allowedProjects}::uuid[] IS NULL OR c.project_id = ANY (${A.allowedProjects}::uuid[])
           OR (p.kind = 'interest' AND EXISTS (SELECT 1 FROM jsonb_each_text(c.preferred_agents) pa
                                                WHERE pa.value = (${A.id}::uuid)::text)))
      AND EXISTS (SELECT 1 FROM workstations aw JOIN project_members apm ON apm.user_id = aw.user_id
                   WHERE aw.id = ${A.workstationId} AND apm.project_id = c.project_id AND apm.status = 'active')`,
    // A stage with a `fallback_role` (the QA steps: tester, else BA) is also taken by the fallback role while the
    // organization has no active agent of the stage's own role that may work the project.
    role: `st.kind = 'agent' AND (st.claim_role = ${A.roleKey}
      OR (st.fallback_role = ${A.roleKey} AND NOT EXISTS (
            SELECT 1 FROM agents fa WHERE fa.org_id = c.org_id AND fa.status = 'active' AND fa.role_key = st.claim_role
               AND (fa.allowed_project_ids IS NULL OR c.project_id = ANY (fa.allowed_project_ids)))))`,
    senior: `(NOT st.senior_only OR ${A.senior})`,
    notExcluded: `NOT (${A.id} = ANY (c.excluded_agent_ids))`,
    tier: `(c.risk_tier IS NULL OR c.risk_tier = ANY (${A.riskTiers}))`,
    caps: `c.required_capabilities <@ ${A.capabilities}`,
    home: `(c.home_workstation_id IS NULL OR c.home_workstation_id = ${A.workstationId})`,
    repo: `(c.repo_id IS NULL OR EXISTS (
        SELECT 1 FROM workstation_repos wr
         WHERE wr.workstation_id = ${A.workstationId} AND wr.project_repo_id = c.repo_id))`,
    // The DevOps engineer prepares the toolchain of a project on a workstation before any build work (migration 1370):
    // while that is not done, ALL agent cards of the project wait on that workstation (D3; the DevOps engineer's own
    // stages are the one exception, they are how the environment gets fixed). A project without a row is not gated.
    env: `(c.repo_id IS NULL OR st.claim_role = 'devops' OR NOT EXISTS (
        SELECT 1 FROM project_environments pe
         WHERE pe.project_id = c.project_id AND pe.workstation_id = ${A.workstationId} AND pe.state <> 'ready'))`,
    vault: `(c.repo_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM vaults v WHERE ${vaultOfCard}) OR EXISTS (
        SELECT 1 FROM vaults v JOIN workstation_vaults wv ON wv.vault_id = v.id AND wv.workstation_id = ${A.workstationId}
         WHERE ${vaultOfCard}))`,
    worktree: `(c.worktree_card_id IS NULL OR EXISTS (
        SELECT 1 FROM cards pc WHERE pc.id = c.worktree_card_id AND pc.home_workstation_id = ${A.workstationId}))`,
  };
}
export type EligibilityPart = keyof ReturnType<typeof eligibility>;

const E = eligibility(PARAM_AGENT);

const CANDIDATES_SQL = (cardFilter: string) => `
SELECT c.id, c.stage
FROM cards c
JOIN projects p          ON p.id = c.project_id AND p.status = 'active'
JOIN organizations po   ON po.id = c.org_id AND po.status IN ('trial','active')
JOIN workflow_stages st  ON st.workflow_version_id = c.workflow_version_id AND st.stage_id = c.stage
WHERE c.status = 'queued'
  AND c.claim_id IS NULL
  AND ${E.scope}
  AND ${E.role}
  AND ${E.senior}
  AND ${E.notExcluded}
  AND ${E.tier}
  AND ${E.caps}
  AND ${E.home}
  AND ${E.repo}
  AND ${E.env}
  AND ${E.vault}
  AND ${E.worktree}
  AND (p.max_concurrent_shifts IS NULL OR (SELECT count(*) FROM cards pc
        WHERE pc.project_id = c.project_id AND pc.claim_id IS NOT NULL) < p.max_concurrent_shifts)
  AND (c.retry_after IS NULL OR c.retry_after <= $9::timestamptz)
  -- A project over its monthly budget starts nothing new (running shifts finish): costs/index.ts budgetPausedSql.
  AND NOT ${budgetPausedSql('p', '$9')}
  AND NOT EXISTS (
        SELECT 1 FROM card_dependencies d JOIN cards dc ON dc.id = d.depends_on_card_id
         WHERE d.card_id = c.id
           -- The first stage that creates the card branch waits for the dependencies (build, or investigate when the
           -- architect's stage creates the worktree), so a branch is never cut before they have landed.
           AND ((c.stage = 'build' AND c.rework_round = 0)
                OR (c.repo_id IS NOT NULL AND c.worktree_path IS NULL AND c.worktree_card_id IS NULL))
           AND dc.status NOT IN ('done','cancelled'))
  ${cardFilter}
ORDER BY
  -- 1. scheduled work first: schedules, interest scans and an on-demand "Research this" (they are scheduled cards)
  c.scheduled DESC,
  -- 2. the agent's own rework, then other rework
  CASE
    WHEN c.is_rework_or_bug AND c.original_builder_agent_id = $1 THEN 0
    WHEN c.is_rework_or_bug THEN 1
    ELSE 2
  END,
  -- 3. the agent's focus projects: a soft preference, ahead of the ranking
  (c.project_id = ANY ($10::uuid[])) DESC,
  -- 4. an interest's preferred agent sorts ahead (a soft preference: no claim window, any allowed agent takes the run)
  (c.preferred_agents IS NOT NULL AND EXISTS (SELECT 1 FROM jsonb_each_text(c.preferred_agents) pa
                                               WHERE pa.value = ($1::uuid)::text)) DESC,
  -- 5. the organization's ranking of its projects (1 = most important); interests are not ranked
  p.rank ASC NULLS LAST,
  c.priority ASC,
  c.queued_at ASC,
  c.created_at ASC
LIMIT 5`;

const params = (a: AgentView, now: Date) => [
  a.id,
  a.orgId,
  a.allowedProjectIds,
  a.roleKey,
  a.senior,
  a.workstationId,
  a.capabilities,
  a.riskTiers,
  now,
  a.focusProjectIds,
];

/** Claimable cards for `agent` in priority order (limit 5). A card in loop-breaker back-off is skipped until it expires. */
export async function candidateCards(
  db: Queryable,
  agent: AgentView,
  now: Date = new Date(),
): Promise<Array<{ id: string; stage: string }>> {
  return rows(db, CANDIDATES_SQL(''), params(agent, now));
}

/** Is this specific card currently claimable by this agent? (used inside the claim transaction) */
export async function isCandidate(
  db: Queryable,
  agent: AgentView,
  cardId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const r = await one(db, CANDIDATES_SQL('AND c.id = $11'), [...params(agent, now), cardId]);
  return !!r;
}
