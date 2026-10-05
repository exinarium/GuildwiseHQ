import { one, type Queryable, type Row, rows } from '../db/sql.ts';

/** A runner that has not been heard from for this long counts as offline. */
export const ONLINE_WINDOW_MS = 45_000;

/** What the candidate query needs to know about an agent (docs/ARCHITECTURE.md section 9.3). */
export interface AgentView {
  id: string;
  orgId: string;
  projectId: string | null;
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
    projectId: a.project_id,
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
  projectId: string;
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
  projectId: '$3',
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
  // Cards without a repo (research, feed) work on a vault: when the card's domain has a registered vault the agent's
  // workstation must hold a clone of it (docs/ARCHITECTURE.md section 9.3, M3). The vault applicable to a card is its
  // project's vault, or the owner's vault of the project's domain (only for the owner's own workstations).
  const vaultOfCard = `(v.project_id = c.project_id
         OR (v.project_id IS NULL AND v.org_id = c.org_id AND v.kind = p.domain
             AND v.org_id = (SELECT w.user_id FROM workstations w WHERE w.id = ${A.workstationId})))`;
  return {
    scope: `c.org_id = ${A.orgId} AND (${A.projectId}::uuid IS NULL OR c.project_id = ${A.projectId})`,
    role: `st.kind = 'agent' AND st.claim_role = ${A.roleKey}`,
    senior: `(NOT st.senior_only OR ${A.senior})`,
    notExcluded: `NOT (${A.id} = ANY (c.excluded_agent_ids))`,
    tier: `(c.risk_tier IS NULL OR c.risk_tier = ANY (${A.riskTiers}))`,
    caps: `c.required_capabilities <@ ${A.capabilities}`,
    home: `(c.home_workstation_id IS NULL OR c.home_workstation_id = ${A.workstationId})`,
    repo: `(c.repo_id IS NULL OR EXISTS (
        SELECT 1 FROM workstation_repos wr
         WHERE wr.workstation_id = ${A.workstationId} AND wr.project_repo_id = c.repo_id))`,
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
  AND ${E.vault}
  AND ${E.worktree}
  AND NOT EXISTS (
        SELECT 1 FROM card_dependencies d JOIN cards dc ON dc.id = d.depends_on_card_id
         WHERE d.card_id = c.id AND c.stage = 'build' AND c.rework_round = 0
           AND dc.status NOT IN ('done','cancelled'))
  ${cardFilter}
ORDER BY
  c.scheduled DESC,
  (p.domain = 'work') DESC,
  CASE
    WHEN c.is_rework_or_bug AND c.original_builder_agent_id = $1 THEN 0
    WHEN c.is_rework_or_bug THEN 1
    ELSE 2
  END,
  p.priority_tier ASC,
  c.priority ASC,
  c.queued_at ASC,
  c.created_at ASC
LIMIT 5`;

const params = (a: AgentView) => [
  a.id,
  a.orgId,
  a.projectId,
  a.roleKey,
  a.senior,
  a.workstationId,
  a.capabilities,
  a.riskTiers,
];

/** Claimable cards for `agent` in priority order (limit 5). */
export async function candidateCards(
  db: Queryable,
  agent: AgentView,
): Promise<Array<{ id: string; stage: string }>> {
  return rows(db, CANDIDATES_SQL(''), params(agent));
}

/** Is this specific card currently claimable by this agent? (used inside the claim transaction) */
export async function isCandidate(db: Queryable, agent: AgentView, cardId: string): Promise<boolean> {
  const r = await one(db, CANDIDATES_SQL('AND c.id = $9'), [...params(agent), cardId]);
  return !!r;
}
