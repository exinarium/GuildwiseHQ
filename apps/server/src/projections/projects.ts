import { type EventOf, scrubRemoteUrl } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { Projector } from '../eventstore/types.ts';

const PROJECT_COLUMNS: Record<string, string> = {
  name: 'name',
  domain: 'domain',
  workflowKey: 'workflow_key',
  priorityTier: 'priority_tier',
  branchPrefix: 'branch_prefix',
  workingBranch: 'working_branch',
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
  for (const t of [
    'card_handoffs',
    'card_transitions',
    'card_activity',
    'test_runs',
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
  // Interests: those that only lived in this project go; one that also has another project loses just this link.
  await exec(
    tx,
    `DELETE FROM interests WHERE COALESCE(feed_project_id, research_project_id) = $1
        AND COALESCE(research_project_id, feed_project_id) = $1`,
    P,
  );
  await exec(
    tx,
    'UPDATE interests SET feed_project_id = NULL, scan = NULL, schedule_id = NULL WHERE feed_project_id=$1',
    P,
  );
  await exec(tx, 'UPDATE interests SET research_project_id = NULL WHERE research_project_id=$1', P);
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
  await exec(tx, 'DELETE FROM projects WHERE id=$1', P);
}

export const projectProjectors: Record<string, Projector> = {
  ProjectCreated: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectCreated'>).payload;
    await exec(
      tx,
      `INSERT INTO projects (id, org_id, key, name, domain, workflow_key, priority_tier, branch_prefix,
         working_branch, sub_categories, vault_folder, created_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        p.projectId,
        p.orgId,
        p.key,
        p.name,
        p.domain,
        p.workflowKey,
        p.priorityTier,
        p.branchPrefix,
        p.workingBranch,
        p.subCategories,
        p.vaultFolder,
        e.createdAt,
        p.createdByUserId ?? p.orgId,
      ],
    );
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
  ProjectMergePolicyChanged: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectMergePolicyChanged'>).payload;
    await exec(
      tx,
      `UPDATE projects SET merge_large_without_approval=$2, merge_large_changed_by=$3, merge_large_changed_at=$4
        WHERE id=$1`,
      [p.projectId, p.mergeLargeWithoutApproval, p.changedBy, e.createdAt],
    );
  },
  ProjectConcurrencyCapSet: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectConcurrencyCapSet'>).payload;
    await exec(tx, 'UPDATE projects SET max_concurrent_shifts=$2 WHERE id=$1', [p.projectId, p.cap]);
  },
  ProjectRepoAdded: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectRepoAdded'>).payload;
    await exec(
      tx,
      `INSERT INTO project_repos (id, project_id, name, remote_url, remote_url_normalized, working_branch)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (project_id, remote_url_normalized) DO UPDATE
         SET removed_at = NULL, name = EXCLUDED.name, remote_url = EXCLUDED.remote_url,
             working_branch = EXCLUDED.working_branch`,
      [
        p.repoId,
        p.projectId,
        p.name,
        scrubRemoteUrl(p.remoteUrl),
        p.remoteUrlNormalized,
        p.workingBranch ?? null,
      ],
    );
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
