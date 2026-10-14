import type { EventOf } from '@aom/shared';
import { exec, one } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

/** Run & test settings (migration 1880) and run plans (migration 1890). `run_environments` is operational, not projected. */
export const runProjectors: Record<string, Projector> = {
  ProjectRunSettingsSet: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectRunSettingsSet'>).payload;
    await exec(tx, 'UPDATE projects SET run_instructions=$2, run_settings=$3::jsonb WHERE id=$1', [
      p.projectId,
      p.runInstructions,
      JSON.stringify(p.settings),
    ]);
    // The whole list: a repository not named has no instructions.
    await exec(tx, `UPDATE project_repos SET run_instructions='' WHERE project_id=$1`, [p.projectId]);
    for (const r of p.repoInstructions)
      await exec(tx, 'UPDATE project_repos SET run_instructions=$3 WHERE id=$2 AND project_id=$1', [
        p.projectId,
        r.repoId,
        r.runInstructions,
      ]);
  },
  RunPlanSaved: async (tx, e) => {
    const p = (e.event as EventOf<'RunPlanSaved'>).payload;
    const req = p.requestId
      ? await one<{ devops_agent_id: string }>(
          tx,
          'SELECT devops_agent_id FROM devops_requests WHERE id=$1',
          [p.requestId],
        )
      : undefined;
    await exec(
      tx,
      `UPDATE run_plans SET status='superseded' WHERE project_id=$1 AND workstation_id=$2 AND status <> 'superseded'`,
      [p.projectId, p.workstationId],
    );
    await exec(
      tx,
      `INSERT INTO run_plans (id, org_id, project_id, workstation_id, version, status, plan, fingerprint,
                              devops_request_id, saved_by_agent_id, created_at)
       VALUES ($1,$2,$3,$4,$5,'active',$6::jsonb,$7,$8,$9,$10)`,
      [
        p.planId,
        e.scope.orgId,
        p.projectId,
        p.workstationId,
        p.version,
        JSON.stringify(p.plan),
        p.fingerprint,
        p.requestId,
        req?.devops_agent_id ?? null,
        e.createdAt,
      ],
    );
  },
};
