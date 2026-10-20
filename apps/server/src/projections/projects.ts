import { type EventOf, LEGACY_CODE_V6_KEY, normalizeProjectPath, scrubRemoteUrl } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { Projector } from '../eventstore/types.ts';

const PROJECT_COLUMNS: Record<string, string> = {
  name: 'name',
  workflowKey: 'workflow_key',
  branchPrefix: 'branch_prefix',
  workingBranch: 'working_branch',
  defaultCompletion: 'default_completion',
  removeFinishedBranches: 'remove_finished_branches',
  prBranchPrefix: 'pr_branch_prefix',
  subCategories: 'sub_categories',
  vaultFolder: 'vault_folder',
  architecturalGlobs: 'architectural_globs',
  e2eGlobs: 'e2e_globs',
};

/**
 * Removes every row that belongs to a project, in foreign-key order (the `ProjectDeleted` projector). Owned by the
 * project: its cards and everything hanging off them, its threads, desk items, ledger entries, schedules, feed and
 * research rows, repositories, vault registration and members. Other rows that merely point at its cards are detached
 * (a parent/worktree reference, a DevOps request, an intake mapping). Idempotent: a rebuild replays it after the events
 * that created the rows.
 */
export async function deleteProjectRows(tx: Tx, projectId: string): Promise<void> {
  const P = [projectId];
  const cards = 'SELECT id FROM cards WHERE project_id=$1';
  const desk = `SELECT id FROM desk_items WHERE project_id=$1 OR card_id IN (${cards})`;
  const threads = `SELECT id FROM threads WHERE kind <> 'intake' AND (project_id=$1 OR card_id IN (${cards}))`;
  // Detach what points at the doomed cards from elsewhere.
  await exec(
    tx,
    `UPDATE cards SET parent_card_id = NULL WHERE project_id <> $1 AND parent_card_id IN (${cards})`,
    P,
  );
  await exec(
    tx,
    `UPDATE cards SET worktree_card_id = NULL WHERE project_id <> $1 AND worktree_card_id IN (${cards})`,
    P,
  );
  await exec(tx, `UPDATE devops_requests SET card_id = NULL WHERE card_id IN (${cards})`, P);
  // Run environments and plans of the project (migrations 1890, 1900).
  await exec(tx, 'DELETE FROM run_environments WHERE project_id=$1', P);
  await exec(tx, 'DELETE FROM run_plans WHERE project_id=$1', P);
  await exec(tx, 'DELETE FROM setup_proposals WHERE project_id=$1', P);
  await exec(tx, 'DELETE FROM run_plan_consents WHERE project_id=$1', P);
  await exec(tx, 'DELETE FROM delivery_setup_drafts WHERE project_id=$1', P);
  await exec(tx, 'DELETE FROM deploy_probes WHERE project_id=$1', P);
  await exec(tx, 'DELETE FROM deploy_target_connections WHERE project_id=$1', P);
  await exec(tx, 'UPDATE intakes SET mapped_project_id = NULL WHERE mapped_project_id=$1', P);
  await exec(
    tx,
    `UPDATE ledger_entries SET superseded_by = NULL
      WHERE superseded_by IN (SELECT id FROM ledger_entries WHERE project_id=$1 OR card_id IN (${cards}))
        AND NOT (project_id IS NOT DISTINCT FROM $1::uuid OR card_id IN (${cards}))`,
    P,
  );
  // Phases, their follow-ups, deploy targets and the BA tasks (the follow-ups' DevOps requests belong to workstations).
  const phases = 'SELECT id FROM phases WHERE project_id=$1';
  await exec(
    tx,
    `DELETE FROM shifts WHERE ba_task_id IN (SELECT id FROM ba_tasks WHERE project_id=$1 OR phase_id IN (${phases}))`,
    P,
  );
  await exec(tx, `DELETE FROM ba_tasks WHERE project_id=$1 OR phase_id IN (${phases})`, P);
  await exec(tx, `DELETE FROM phase_followups WHERE phase_id IN (${phases})`, P);
  await exec(
    tx,
    `UPDATE cards SET phase_id = NULL, phase_assignment = NULL WHERE phase_id IN (${phases})`,
    P,
  );
  // Rows hanging off the cards.
  await exec(
    tx,
    `DELETE FROM card_dependencies WHERE card_id IN (${cards}) OR depends_on_card_id IN (${cards})`,
    P,
  );
  await exec(tx, `DELETE FROM card_blockers WHERE card_id IN (${cards}) OR desk_item_id IN (${desk})`, P);
  await exec(
    tx,
    `DELETE FROM card_attachment_data WHERE id IN (SELECT id FROM card_attachments WHERE card_id IN (${cards}))`,
    P,
  );
  for (const t of [
    'card_handoffs',
    'card_attachments',
    'card_transitions',
    'card_activity',
    'test_runs',
    'test_suite_results',
    'intake_cards',
    'agent_card_stats',
    'agent_review_log',
    'digest_items',
    'research_publications',
    'outbound_drafts',
  ]) {
    await exec(tx, `DELETE FROM ${t} WHERE card_id IN (${cards})`, P);
  }
  await exec(tx, 'DELETE FROM shifts WHERE card_id IN (SELECT id FROM cards WHERE project_id=$1)', P);
  await exec(tx, `DELETE FROM thread_messages WHERE thread_id IN (${threads})`, P);
  await exec(tx, `DELETE FROM threads WHERE id IN (${threads})`, P);
  await exec(
    tx,
    `DELETE FROM ledger_entries WHERE project_id=$1 OR card_id IN (${cards}) OR source_desk_item_id IN (${desk})`,
    P,
  );
  await exec(tx, `DELETE FROM desk_items WHERE id IN (${desk})`, P);
  await exec(tx, 'DELETE FROM cards WHERE project_id=$1', P);
  await exec(tx, 'DELETE FROM phases WHERE project_id=$1', P);
  await exec(tx, 'DELETE FROM ba_signals WHERE project_id=$1', P);
  await exec(tx, 'DELETE FROM hygiene_findings WHERE project_id=$1', P);
  await exec(tx, 'DELETE FROM deploy_targets WHERE project_id=$1', P);
  // The interest this project backs goes with it (its run log and deliveries too); an interest of the first model
  // only loses the link.
  await exec(
    tx,
    'DELETE FROM interest_runs WHERE interest_id IN (SELECT id FROM interests WHERE project_id=$1)',
    P,
  );
  await exec(
    tx,
    'DELETE FROM interest_deliveries WHERE interest_id IN (SELECT id FROM interests WHERE project_id=$1)',
    P,
  );
  await exec(tx, 'DELETE FROM interests WHERE project_id=$1', P);
  await exec(
    tx,
    `UPDATE interests SET legacy_feed_project_id = NULL, scan = NULL, legacy_schedule_id = NULL
      WHERE legacy_feed_project_id=$1`,
    P,
  );
  await exec(
    tx,
    'UPDATE interests SET legacy_research_project_id = NULL WHERE legacy_research_project_id=$1',
    P,
  );
  await exec(tx, 'DELETE FROM taste_seeds WHERE project_id=$1', P);
  // Project-level rows.
  for (const t of ['feed_seen', 'transcripts', 'repo_requests', 'schedules']) {
    await exec(tx, `DELETE FROM ${t} WHERE project_id=$1`, P);
  }
  await exec(
    tx,
    'DELETE FROM workstation_repos WHERE project_repo_id IN (SELECT id FROM project_repos WHERE project_id=$1)',
    P,
  );
  await exec(tx, 'DELETE FROM repo_pr_requests WHERE project_id=$1', P);
  await exec(tx, 'DELETE FROM project_repos WHERE project_id=$1', P);
  await exec(
    tx,
    'DELETE FROM workstation_vaults WHERE vault_id IN (SELECT id FROM vaults WHERE project_id=$1)',
    P,
  );
  await exec(tx, 'DELETE FROM vaults WHERE project_id=$1', P);
  await exec(tx, 'DELETE FROM project_members WHERE project_id=$1', P);
  // Agents belong to the organization and stay. The project leaves their allow-lists and focus. An agent that was
  // allowed on this project only ends with an EMPTY allow-list: benched until the manager reassigns it (owner
  // decision, 2026-10-07). `hired_for_project_id` keeps the id as history.
  await exec(
    tx,
    `UPDATE agents SET
       allowed_project_ids = array_remove(allowed_project_ids, $1::uuid),
       focus_project_ids = array_remove(focus_project_ids, $1::uuid)
     WHERE $1::uuid = ANY(allowed_project_ids) OR $1::uuid = ANY(focus_project_ids)`,
    P,
  );
  // The enabled workflows and the project's own workflow variants (its cards, which pinned them, are gone above).
  await exec(tx, 'DELETE FROM project_workflows WHERE project_id=$1', P);
  await exec(
    tx,
    'DELETE FROM workflow_stages WHERE workflow_version_id IN (SELECT id FROM workflow_versions WHERE project_id=$1)',
    P,
  );
  await exec(tx, 'DELETE FROM workflow_versions WHERE project_id=$1', P);
  await exec(tx, 'DELETE FROM projects WHERE id=$1', P);
}

export const projectProjectors: Record<string, Projector> = {
  ProjectCreated: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectCreated'>).payload;
    await exec(
      tx,
      `INSERT INTO projects (id, org_id, key, name, workflow_key, branch_prefix,
         working_branch, sub_categories, vault_folder, created_at, created_by, started_as, kind, vault_dir, rank)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$5,$12,$13,
         CASE WHEN $12 = 'interest' THEN NULL
              ELSE (SELECT COALESCE(max(rank), 0) + 1 FROM projects WHERE org_id = $2 AND kind = 'project') END)`,
      [
        p.projectId,
        p.orgId,
        p.key,
        p.name,
        p.workflowKey,
        p.branchPrefix,
        p.workingBranch,
        p.subCategories,
        p.vaultFolder,
        e.createdAt,
        p.createdByUserId ?? p.orgId,
        p.kind ?? 'project',
        p.vaultDir ?? null,
      ],
    );
    // Legacy alias (workflows/legacy.ts): a project created on the old `lean team` key had the automatic full suite off.
    if (p.workflowKey === LEGACY_CODE_V6_KEY)
      await exec(tx, 'UPDATE projects SET full_suite_after_finalize=false WHERE id=$1', [p.projectId]);
    if (p.createdByUserId) {
      // Organizations: the creator is an Owner or Admin; every active Owner and Admin gets an organization grant.
      await exec(
        tx,
        `INSERT INTO project_members (project_id, user_id, role, status, joined_at, direct, org_grant)
         SELECT $1, om.user_id, 'owner', 'active', $3, false, true FROM org_members om
          WHERE om.org_id = $2 AND om.status = 'active' AND om.role IN ('owner','admin')`,
        [p.projectId, p.orgId, e.createdAt],
      );
    } else {
      // Legacy event (before organizations): the user whose id is `orgId` created and owns it.
      await exec(
        tx,
        `INSERT INTO project_members (project_id, user_id, role, status, joined_at)
         VALUES ($1,$2,'owner','active',$3)`,
        [p.projectId, p.orgId, e.createdAt],
      );
    }
    // People added with the project (an interest created by a Member or a guest is private to them and the org's Owner and Admins).
    for (const m of p.members ?? []) {
      await exec(
        tx,
        `INSERT INTO project_members (project_id, user_id, role, status, invited_by, invited_at, joined_at, direct, org_grant)
         VALUES ($1,$2,$3,'active',$4,$5,$5,true,false)
         ON CONFLICT (project_id, user_id) DO UPDATE SET direct = true`,
        [p.projectId, m.userId, m.role, p.createdByUserId ?? p.orgId, e.createdAt],
      );
    }
  },
  ProjectKindChanged: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectKindChanged'>).payload;
    // An interest's project is not ranked; a project that becomes visible goes to the bottom.
    await exec(
      tx,
      `UPDATE projects SET kind=$2, vault_dir=COALESCE($3, vault_dir),
              rank = CASE WHEN $2 = 'interest' THEN NULL
                          ELSE COALESCE(rank, (SELECT COALESCE(max(r.rank), 0) + 1 FROM projects r
                                                WHERE r.org_id = projects.org_id AND r.kind = 'project')) END
        WHERE id=$1`,
      [p.projectId, p.kind, p.vaultDir ?? null],
    );
  },
  ProjectsRanked: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectsRanked'>).payload;
    await exec(
      tx,
      `UPDATE projects SET rank = o.pos::int
         FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id, pos)
        WHERE projects.id = o.id AND projects.org_id = $1 AND projects.kind = 'project'`,
      [p.orgId, p.projectIds],
    );
  },
  ProjectVaultDirSet: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectVaultDirSet'>).payload;
    await exec(tx, 'UPDATE projects SET vault_dir=$2 WHERE id=$1', [p.projectId, p.vaultDir]);
  },
  ProjectUpdated: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectUpdated'>).payload;
    const sets: string[] = [];
    const params: unknown[] = [p.projectId];
    for (const [k, v] of Object.entries(p.changes)) {
      const col = PROJECT_COLUMNS[k];
      if (!col || v === undefined) continue;
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    }
    if (sets.length) await exec(tx, `UPDATE projects SET ${sets.join(', ')} WHERE id=$1`, params);
  },
  ProjectConverted: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectConverted'>).payload;
    await exec(
      tx,
      `UPDATE projects SET workflow_key=$2, converted_at=$3, converted_by=$4, pending_conversion=NULL WHERE id=$1`,
      [p.projectId, p.toWorkflowKey, e.createdAt, p.by],
    );
  },
  ProjectConversionRequested: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectConversionRequested'>).payload;
    await exec(tx, 'UPDATE projects SET pending_conversion=$2 WHERE id=$1', [
      p.projectId,
      JSON.stringify({
        conversionId: p.conversionId,
        toWorkflowKey: p.toWorkflowKey,
        cardDecisions: p.cardDecisions,
        repoRequestIds: p.repoRequestIds,
        ...(p.note ? { note: p.note } : {}),
        by: p.by,
      }),
    ]);
  },
  ProjectConversionCancelled: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectConversionCancelled'>).payload;
    await exec(
      tx,
      `UPDATE projects SET pending_conversion=NULL WHERE id=$1 AND pending_conversion->>'conversionId' = $2`,
      [p.projectId, p.conversionId],
    );
  },
  ProjectMergePolicyChanged: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectMergePolicyChanged'>).payload;
    await exec(
      tx,
      `UPDATE projects SET merge_large_without_approval=$2, merge_large_changed_by=$3, merge_large_changed_at=$4
        WHERE id=$1`,
      [p.projectId, p.mergeLargeWithoutApproval, p.changedBy, e.createdAt],
    );
  },
  ProjectArchitectSettingsSet: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectArchitectSettingsSet'>).payload;
    await exec(
      tx,
      `UPDATE projects SET design_step=$2, merge_main_first=$3, investigation_path=$4, investigation_location=$5
        WHERE id=$1`,
      [p.projectId, p.designStep, p.mergeMainFirst, p.investigationPath, p.investigationLocation],
    );
  },

  ProjectPolicySet: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectPolicySet'>).payload;
    await exec(
      tx,
      `UPDATE projects SET decisions_project_only=COALESCE($2, decisions_project_only),
              test_without_environment=COALESCE($3, test_without_environment) WHERE id=$1`,
      [p.projectId, p.decisionsProjectOnly ?? null, p.testWithoutEnvironment ?? null],
    );
  },
  ProjectFullSuiteSet: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectFullSuiteSet'>).payload;
    await exec(tx, 'UPDATE projects SET full_suite_after_finalize=$2 WHERE id=$1', [p.projectId, p.enabled]);
  },
  ProjectClaudeAccountSet: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectClaudeAccountSet'>).payload;
    await exec(tx, 'UPDATE projects SET claude_account_key=$2, claude_account_fallback=$3 WHERE id=$1', [
      p.projectId,
      p.accountKey,
      p.fallbackToMain,
    ]);
  },
  ProjectManualQaSet: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectManualQaSet'>).payload;
    await exec(tx, 'UPDATE projects SET manual_qa=$2 WHERE id=$1', [p.projectId, p.enabled]);
  },
  ProjectConcurrencyCapSet: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectConcurrencyCapSet'>).payload;
    await exec(tx, 'UPDATE projects SET max_concurrent_shifts=$2 WHERE id=$1', [p.projectId, p.cap]);
  },
  ProjectPaused: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectPaused'>).payload;
    await exec(
      tx,
      'UPDATE projects SET paused_at=$2, paused_by=$3, pause_reason=$4 WHERE id=$1 AND paused_at IS NULL',
      [p.projectId, e.createdAt, p.by, p.reason?.trim() || null],
    );
  },
  ProjectResumed: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectResumed'>).payload;
    await exec(tx, 'UPDATE projects SET paused_at=NULL, paused_by=NULL, pause_reason=NULL WHERE id=$1', [
      p.projectId,
    ]);
  },
  ProjectMcpServersSet: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectMcpServersSet'>).payload;
    await exec(tx, 'UPDATE projects SET mcp_servers=$2::text[] WHERE id=$1', [p.projectId, p.servers]);
  },
  ProjectReferenceReposSet: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectReferenceReposSet'>).payload;
    await exec(tx, 'UPDATE projects SET reference_repo_ids=$2::uuid[] WHERE id=$1', [p.projectId, p.repoIds]);
    // events from before workstation clones could be picked carry no list: it stays as it was ([])
    if (p.workstationRepos)
      await exec(tx, 'UPDATE projects SET reference_workstation_repos=$2::jsonb WHERE id=$1', [
        p.projectId,
        JSON.stringify(p.workstationRepos),
      ]);
  },
  ProjectRepoAdded: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectRepoAdded'>).payload;
    await exec(
      tx,
      `INSERT INTO project_repos (id, project_id, name, remote_url, remote_url_normalized, working_branch, forge_kind, project_path, access_method, main_branch)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (project_id, remote_url_normalized) DO UPDATE
         SET removed_at = NULL, name = EXCLUDED.name, remote_url = EXCLUDED.remote_url,
             working_branch = EXCLUDED.working_branch, forge_kind = EXCLUDED.forge_kind,
             project_path = EXCLUDED.project_path, access_method = EXCLUDED.access_method,
             main_branch = EXCLUDED.main_branch`,
      [
        p.repoId,
        p.projectId,
        p.name,
        scrubRemoteUrl(p.remoteUrl),
        p.remoteUrlNormalized,
        p.workingBranch ?? null,
        p.forge ?? null,
        normalizeProjectPath(p.projectPath),
        p.accessMethod ?? null,
        p.mainBranch ?? null,
      ],
    );
  },
  ProjectRepoAccessSet: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectRepoAccessSet'>).payload;
    await exec(tx, 'UPDATE project_repos SET access_method=$2 WHERE id=$1', [p.repoId, p.accessMethod]);
  },
  ProjectRepoMainBranchSet: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectRepoMainBranchSet'>).payload;
    await exec(tx, 'UPDATE project_repos SET main_branch=$2 WHERE id=$1', [p.repoId, p.mainBranch]);
  },
  ProjectRepoWorkingBranchCreated: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectRepoWorkingBranchCreated'>).payload;
    await exec(
      tx,
      `UPDATE project_repos SET working_branch_created_at=$2, working_branch_created_from=$3,
              working_branch_created_pushed=$4,
              known_branches = CASE WHEN known_branches ? $5::text THEN known_branches
                                    ELSE known_branches || to_jsonb($5::text) END
        WHERE id=$1`,
      [p.repoId, e.createdAt, p.from, p.pushed, p.workingBranch],
    );
  },
  ProjectRepoBranchesObserved: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectRepoBranchesObserved'>).payload;
    await exec(tx, 'UPDATE project_repos SET known_branches=$2::jsonb, known_branches_at=$3 WHERE id=$1', [
      p.repoId,
      JSON.stringify(p.branches),
      e.createdAt,
    ]);
  },
  ProjectRepoPathSet: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectRepoPathSet'>).payload;
    await exec(tx, 'UPDATE project_repos SET project_path=$2 WHERE id=$1', [
      p.repoId,
      normalizeProjectPath(p.projectPath),
    ]);
  },
  ProjectRepoForgeSet: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectRepoForgeSet'>).payload;
    await exec(tx, 'UPDATE project_repos SET forge_kind=$2 WHERE id=$1', [p.repoId, p.forge]);
  },
  ProjectRepoRemoved: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectRepoRemoved'>).payload;
    await exec(tx, 'UPDATE project_repos SET removed_at=$2 WHERE id=$1', [p.repoId, e.createdAt]);
  },
  ProjectArchived: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectArchived'>).payload;
    await exec(tx, `UPDATE projects SET status='archived' WHERE id=$1`, [p.projectId]);
  },
  ProjectRestored: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectRestored'>).payload;
    await exec(tx, `UPDATE projects SET status='active' WHERE id=$1`, [p.projectId]);
  },
  ProjectDeleted: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectDeleted'>).payload;
    await deleteProjectRows(tx, p.projectId);
  },
};
