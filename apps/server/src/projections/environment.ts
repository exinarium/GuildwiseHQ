import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

/** Repository clones, project environments, the rights check and the sudo password facts (migration 1370). */
export const environmentProjectors: Record<string, Projector> = {
  RepoCloneRequested: async (tx, e) => {
    const p = (e.event as EventOf<'RepoCloneRequested'>).payload;
    await exec(
      tx,
      `INSERT INTO repo_clones (project_repo_id, workstation_id, project_id, state, mode, detail, local_path, request_id, updated_at, create_spec)
       VALUES ($1,$2,$3,'cloning',$4,NULL,NULL,$5,$6,$7::jsonb)
       ON CONFLICT (project_repo_id, workstation_id)
       DO UPDATE SET state='cloning', mode=EXCLUDED.mode, detail=NULL, request_id=EXCLUDED.request_id, updated_at=EXCLUDED.updated_at,
                     create_spec=COALESCE(EXCLUDED.create_spec, repo_clones.create_spec)`,
      [
        p.repoId,
        p.workstationId,
        p.projectId,
        p.mode,
        p.requestId,
        e.createdAt,
        p.create ? JSON.stringify(p.create) : null,
      ],
    );
  },
  RepoCloneReported: async (tx, e) => {
    const p = (e.event as EventOf<'RepoCloneReported'>).payload;
    // A late answer to an older request must not overwrite a newer attempt.
    await exec(
      tx,
      `INSERT INTO repo_clones (project_repo_id, workstation_id, project_id, state, mode, detail, local_path, request_id, updated_at)
       VALUES ($1,$2,$3,$4,'clone',$5,$6,$7,$8)
       ON CONFLICT (project_repo_id, workstation_id)
       DO UPDATE SET state=EXCLUDED.state, detail=EXCLUDED.detail,
                     local_path=COALESCE(EXCLUDED.local_path, repo_clones.local_path), updated_at=EXCLUDED.updated_at
          WHERE repo_clones.request_id IS NULL OR repo_clones.request_id = EXCLUDED.request_id`,
      [
        p.repoId,
        p.workstationId,
        p.projectId,
        p.state,
        p.detail ?? null,
        p.localPath ?? null,
        p.requestId,
        e.createdAt,
      ],
    );
  },
  EnvironmentPrepareRequested: async (tx, e) => {
    const p = (e.event as EventOf<'EnvironmentPrepareRequested'>).payload;
    await exec(
      tx,
      `INSERT INTO project_environments (project_id, workstation_id, state, summary, report, request_id, updated_at)
       VALUES ($1,$2,'preparing','Checking the development environment',NULL,$3,$4)
       ON CONFLICT (project_id, workstation_id)
       DO UPDATE SET state='preparing', summary=EXCLUDED.summary, request_id=EXCLUDED.request_id, updated_at=EXCLUDED.updated_at`,
      [p.projectId, p.workstationId, p.requestId, e.createdAt],
    );
  },
  EnvironmentPrepared: async (tx, e) => {
    const p = (e.event as EventOf<'EnvironmentPrepared'>).payload;
    await exec(
      tx,
      `INSERT INTO project_environments (project_id, workstation_id, state, summary, report, request_id, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
       ON CONFLICT (project_id, workstation_id)
       DO UPDATE SET state=EXCLUDED.state, summary=EXCLUDED.summary, report=EXCLUDED.report, updated_at=EXCLUDED.updated_at
          WHERE project_environments.request_id IS NULL OR project_environments.request_id = EXCLUDED.request_id`,
      [
        p.projectId,
        p.workstationId,
        p.report.state,
        p.report.summary,
        JSON.stringify(p.report),
        p.requestId,
        e.createdAt,
      ],
    );
  },
  DevOpsRightsVerified: async (tx, e) => {
    const p = (e.event as EventOf<'DevOpsRightsVerified'>).payload;
    await exec(tx, 'UPDATE workstations SET devops_rights=$2::jsonb, devops_rights_stale=false WHERE id=$1', [
      p.workstationId,
      JSON.stringify(p.report),
    ]);
  },
  // The ticks changed: the last check no longer describes them.
  DevOpsAccessChanged: async (tx, e) => {
    const p = (e.event as EventOf<'DevOpsAccessChanged'>).payload;
    await exec(tx, 'UPDATE workstations SET devops_rights_stale=true WHERE id=$1', [p.workstationId]);
  },
  DevOpsSudoPasswordSet: async (tx, e) => {
    const p = (e.event as EventOf<'DevOpsSudoPasswordSet'>).payload;
    await exec(
      tx,
      'UPDATE workstations SET devops_sudo_set_at=$2, devops_sudo_works=$3, devops_sudo_key_id=$4 WHERE id=$1',
      [p.workstationId, e.createdAt, p.works ?? null, p.keyId],
    );
  },
  DevOpsSudoPasswordCleared: async (tx, e) => {
    const p = (e.event as EventOf<'DevOpsSudoPasswordCleared'>).payload;
    await exec(
      tx,
      'UPDATE workstations SET devops_sudo_set_at=NULL, devops_sudo_works=NULL, devops_sudo_key_id=NULL WHERE id=$1',
      [p.workstationId],
    );
  },
};
