import type { EventOf } from '@aom/shared';
import { exec, one } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

/**
 * `project_workflows` (migration 1660): the workflows a project has enabled. The primary row mirrors
 * `projects.workflow_key` (created with the project, moved by a conversion); the rest follow `ProjectWorkflowsSet`.
 */
export const projectWorkflowProjectors: Record<string, Projector> = {
  ProjectCreated: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectCreated'>).payload;
    await exec(
      tx,
      `INSERT INTO project_workflows (project_id, workflow_key, is_primary, default_card_types, enabled_at)
       VALUES ($1,$2,true,'{}',$3) ON CONFLICT DO NOTHING`,
      [p.projectId, p.workflowKey, e.createdAt],
    );
  },
  ProjectConverted: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectConverted'>).payload;
    // The old primary leaves the enabled set (its open cards finish on their pinned version); the new one is primary.
    await exec(
      tx,
      'DELETE FROM project_workflows WHERE project_id=$1 AND is_primary AND workflow_key <> $2',
      [p.projectId, p.toWorkflowKey],
    );
    await exec(
      tx,
      `INSERT INTO project_workflows (project_id, workflow_key, is_primary, default_card_types, enabled_at)
       VALUES ($1,$2,true,'{}',$3)
       ON CONFLICT (project_id, workflow_key) DO UPDATE SET is_primary = true`,
      [p.projectId, p.toWorkflowKey, e.createdAt],
    );
  },
  ProjectWorkflowsSet: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectWorkflowsSet'>).payload;
    const project = await one<{ workflow_key: string }>(tx, 'SELECT workflow_key FROM projects WHERE id=$1', [
      p.projectId,
    ]);
    if (!project) return;
    const keys = p.enabled.map((x) => x.workflowKey);
    await exec(
      tx,
      'DELETE FROM project_workflows WHERE project_id=$1 AND NOT is_primary AND workflow_key <> ALL($2::text[])',
      [p.projectId, keys],
    );
    for (const x of p.enabled) {
      await exec(
        tx,
        `INSERT INTO project_workflows (project_id, workflow_key, is_primary, default_card_types, enabled_at)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (project_id, workflow_key) DO UPDATE SET default_card_types = EXCLUDED.default_card_types`,
        [p.projectId, x.workflowKey, x.workflowKey === project.workflow_key, x.defaultCardTypes, e.createdAt],
      );
    }
  },
};
