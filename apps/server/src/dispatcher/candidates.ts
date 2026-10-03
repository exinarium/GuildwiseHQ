import { one, type Queryable, type Row, rows } from '../db/sql.ts';

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

const CANDIDATES_SQL = (cardFilter: string) => `
SELECT c.id, c.stage
FROM cards c
JOIN projects p          ON p.id = c.project_id AND p.status = 'active'
JOIN workflow_stages st  ON st.workflow_version_id = c.workflow_version_id AND st.stage_id = c.stage
WHERE c.status = 'queued'
  AND c.claim_id IS NULL
  AND c.org_id = $2
  AND ($3::uuid IS NULL OR c.project_id = $3)
  AND st.kind = 'agent'
  AND st.claim_role = $4
  AND (NOT st.senior_only OR $5)
  AND NOT ($1 = ANY (c.excluded_agent_ids))
  AND (c.risk_tier IS NULL OR c.risk_tier = ANY ($8))
  AND c.required_capabilities <@ $7
  AND (c.home_workstation_id IS NULL OR c.home_workstation_id = $6)
  AND (c.repo_id IS NULL OR EXISTS (
        SELECT 1 FROM workstation_repos wr
         WHERE wr.workstation_id = $6 AND wr.project_repo_id = c.repo_id))
  AND (c.worktree_card_id IS NULL OR EXISTS (
        SELECT 1 FROM cards pc WHERE pc.id = c.worktree_card_id AND pc.home_workstation_id = $6))
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
