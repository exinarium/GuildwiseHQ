import { READONLY_DESIGN_CAPABILITY } from '@aom/shared';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { platformPausedSql } from '../platform-team/pause.ts';
import { landedSql } from './dependencies.ts';
import { projectHeldSql } from './project-hold.ts';

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
    // A stage with `environment: 'project'` (the tester's integration tests, code v4) waits until the environment the
    // server started for the card's commit is healthy on this agent's workstation (docs/design/run-and-integration-tests.md
    // D9). No wait when the project does not run local environments, the card opted out, it is a suite or regression
    // card (they use a target URL), or the workstation's runner cannot provision (an older runner: the tester works as before).
    //
    // lean team (`st.env_strict`): the environment was prepared by the server-run Test deploy stage before this one, so the
    // escapes above do not apply. The tester starts only on a healthy environment of the card, after the server recorded
    // that none applies (`test_deploy_state = 'skipped'`), or when the project works without one (S1b's
    // `test_without_environment`). Suite and regression cards test a target and are not part of the card flow.
    envReady: `((st.environment <> 'project' OR COALESCE(st.env_strict, false)
      OR p.test_without_environment
      OR c.origin IN ('full_suite','regression')
      OR p.integration_tests->>'mode' IS DISTINCT FROM 'local'
      OR COALESCE((c.fields->>'integrationTests')::boolean, true) = false
      OR NOT EXISTS (SELECT 1 FROM workstation_capabilities wc
                      WHERE wc.workstation_id = ${A.workstationId} AND 'runs:3' = ANY (wc.capabilities))
      OR EXISTS (SELECT 1 FROM run_environments re
                  WHERE re.card_id = c.id AND re.purpose = 'test' AND re.verdict_at IS NULL AND re.state = 'healthy'
                    AND re.workstation_id = ${A.workstationId}))
      AND (NOT COALESCE(st.env_strict, false)
        OR p.test_without_environment
        OR c.origin IN ('full_suite','regression')
        OR c.test_deploy_state = 'skipped'
        OR EXISTS (SELECT 1 FROM run_environments re
                    WHERE re.card_id = c.id AND re.purpose = 'test' AND re.verdict_at IS NULL AND re.state = 'healthy'
                      AND re.workstation_id = ${A.workstationId})))`,
    vault: `(c.repo_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM vaults v WHERE ${vaultOfCard}) OR EXISTS (
        SELECT 1 FROM vaults v JOIN workstation_vaults wv ON wv.vault_id = v.id AND wv.workstation_id = ${A.workstationId}
         WHERE ${vaultOfCard}))`,
    worktree: `(c.worktree_card_id IS NULL OR EXISTS (
        SELECT 1 FROM cards pc WHERE pc.id = c.worktree_card_id AND pc.home_workstation_id = ${A.workstationId}))`,
  };
}
export type EligibilityPart = keyof ReturnType<typeof eligibility>;

const E = eligibility(PARAM_AGENT);

/**
 * A reservation (card affinity, group builder) only holds a card for an agent that may take it: the card's risk tier is
 * one of the agent's tiers and the agent is not excluded from it. Otherwise nobody could claim it: a large card
 * reserved for a junior (small only) waited until the reservation expired while every free builder was turned away.
 */
const reserveHolderCanTake = (a: string): string =>
  `NOT (${a}.id = ANY (c.excluded_agent_ids))
   AND (c.risk_tier IS NULL OR c.risk_tier = ANY (ARRAY(SELECT jsonb_array_elements_text(
         COALESCE(${a}.permissions->'riskTiers', '["small","large"]'::jsonb)))))`;

const CANDIDATES_SQL = (cardFilter: string) => `
SELECT c.id, c.stage, c.project_id
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
  AND ${E.envReady}
  AND (p.max_concurrent_shifts IS NULL OR (SELECT count(*) FROM cards pc
        WHERE pc.project_id = c.project_id AND pc.claim_id IS NOT NULL) < p.max_concurrent_shifts)
  AND (c.retry_after IS NULL OR c.retry_after <= $9::timestamptz)
  -- Card affinity (a waiting question was converted, or review findings went back to the builder): while it is valid
  -- only that agent may claim the card. It ends at its expiry, when the card moves on, or when the agent is gone.
  AND (c.affinity_agent_id IS NULL OR c.affinity_until IS NULL OR c.affinity_until <= $9::timestamptz
       OR c.affinity_agent_id = $1
       OR NOT EXISTS (SELECT 1 FROM agents aa WHERE aa.id = c.affinity_agent_id AND aa.status = 'active'
                       AND aa.paused_at IS NULL AND ${reserveHolderCanTake('aa')}))
  -- Group builder affinity (lean team): the first builder of a group keeps the rest of its build cards, a hard clause, until it
  -- is gone or paused or the assignment expired. Review, test and the other roles are not held back.
  AND (c.group_id IS NULL OR st.claim_role IS DISTINCT FROM 'builder' OR NOT EXISTS (
        SELECT 1 FROM card_groups g JOIN agents ga ON ga.id = g.builder_agent_id AND ga.status = 'active' AND ga.paused_at IS NULL
         WHERE g.project_id = c.project_id AND g.group_id = c.group_id AND g.until > $9::timestamptz
           AND ${reserveHolderCanTake('ga')}
           AND g.builder_agent_id <> $1))
  -- A project over its monthly budget or paused by an Owner/Admin starts nothing new (running shifts finish):
  -- dispatcher/project-hold.ts. This one query also guards the claim (isCandidate), so a claim for a paused project is refused.
  AND NOT ${projectHeldSql('p', '$9')}
  -- A scope the platform team paused (project, workflow, stage, workstation) starts nothing new; the platform project never.
  AND NOT ${platformPausedSql('c', '$6')}
  AND NOT EXISTS (
        SELECT 1 FROM card_dependencies d JOIN cards dc ON dc.id = d.depends_on_card_id
         WHERE d.card_id = c.id
           -- Order is a hard rule (Lean Team v3): at every stage except planning and design a card waits for its dependencies
           -- to have LANDED (done, cancelled or finalized with a merge: dependencies.ts). The design stage waits only while
           -- it would have to cut a card branch (no worktree yet), as before; the exception below keeps it going read-only.
           AND c.stage <> 'planning'
           AND (c.stage NOT LIKE 'investigate%'
                OR (c.repo_id IS NOT NULL AND c.worktree_path IS NULL AND c.worktree_card_id IS NULL))
           AND NOT ${landedSql('dc')}
           -- Except the architect's design stage (backlog #80): it may start without a card branch, in a read-only
           -- checkout of the working branch, on a runner that can do that. An investigation-only card has no later
           -- Build to carry its report, so it still waits.
           AND NOT (c.stage LIKE 'investigate%' AND st.claim_role = 'architect' AND c.investigation_only IS NOT TRUE
                    AND c.repo_id IS NOT NULL AND c.worktree_path IS NULL AND c.worktree_card_id IS NULL
                    AND EXISTS (SELECT 1 FROM workstation_capabilities wc
                                 WHERE wc.workstation_id = $6 AND '${READONLY_DESIGN_CAPABILITY}' = ANY (wc.capabilities))))
  -- A design held until its dependencies land (assumption review pending) waits for all of them.
  AND NOT (COALESCE(c.design_review->>'state', '') = 'waiting' AND EXISTS (
        SELECT 1 FROM card_dependencies d JOIN cards dc ON dc.id = d.depends_on_card_id
         WHERE d.card_id = c.id AND NOT ${landedSql('dc')}))
  ${cardFilter}
ORDER BY
  -- 0. cards this agent holds affinity to resume before any new work
  (c.affinity_agent_id = $1 AND c.affinity_until > $9::timestamptz) DESC,
  -- 0b. the next card of the group this agent builds (one sticky session moves from card to card in order)
  (c.group_id IS NOT NULL AND EXISTS (SELECT 1 FROM card_groups g WHERE g.project_id = c.project_id
     AND g.group_id = c.group_id AND g.builder_agent_id = $1 AND g.until > $9::timestamptz)) DESC,
  -- 1. scheduled work first: schedules, interest scans and an on-demand "Research this" (they are scheduled cards)
  c.scheduled DESC,
  -- 2. the agent's own rework, then other rework
  CASE
    WHEN c.is_rework_or_bug AND c.original_builder_agent_id = $1 THEN 0
    WHEN c.is_rework_or_bug THEN 1
    ELSE 2
  END,
  -- 2b. the assumption review goes to the architect who made the design, when that one is free
  COALESCE(c.design_review->>'agentId' = ($1::uuid)::text, false) DESC,
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
  /**
   * Projects whose tickets must not be offered to this agent now (their Claude account is out and the project does not
   * fall back to main), and/or the only projects that may be (when the main account is out, only projects on their own
   * account can run). Keeps the 5-card window from filling with cards that cannot start.
   */
  accounts?: { excludeProjectIds?: string[]; onlyProjectIds?: string[] },
): Promise<Array<{ id: string; stage: string; project_id: string }>> {
  const extra: unknown[] = [];
  let filter = '';
  if (accounts?.excludeProjectIds?.length) {
    extra.push(accounts.excludeProjectIds);
    filter += ` AND NOT (c.project_id = ANY ($${10 + extra.length}::uuid[]))`;
  }
  if (accounts?.onlyProjectIds) {
    extra.push(accounts.onlyProjectIds);
    filter += ` AND c.project_id = ANY ($${10 + extra.length}::uuid[])`;
  }
  return rows(db, CANDIDATES_SQL(filter), [...params(agent, now), ...extra]);
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
