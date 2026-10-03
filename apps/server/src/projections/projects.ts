import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
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

export const projectProjectors: Record<string, Projector> = {
  ProjectCreated: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectCreated'>).payload;
    await exec(
      tx,
      `INSERT INTO projects (id, org_id, key, name, domain, workflow_key, priority_tier, branch_prefix,
         working_branch, sub_categories, vault_folder, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
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
      ],
    );
    await exec(
      tx,
      `INSERT INTO project_members (project_id, user_id, role, status, joined_at)
       VALUES ($1,$2,'owner','active',$3)`,
      [p.projectId, p.orgId, e.createdAt],
    );
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
  ProjectRepoAdded: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectRepoAdded'>).payload;
    await exec(
      tx,
      `INSERT INTO project_repos (id, project_id, name, remote_url, remote_url_normalized, working_branch)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (project_id, remote_url_normalized) DO UPDATE
         SET removed_at = NULL, name = EXCLUDED.name, remote_url = EXCLUDED.remote_url,
             working_branch = EXCLUDED.working_branch`,
      [p.repoId, p.projectId, p.name, p.remoteUrl, p.remoteUrlNormalized, p.workingBranch ?? null],
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
};
