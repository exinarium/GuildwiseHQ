import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';

const ev = <
  T extends
    | 'RepoCreateRequested'
    | 'RepoCreateApproved'
    | 'RepoCreateRetried'
    | 'RepoCreateRejected'
    | 'RepoCreateCompleted'
    | 'RepoCreateFailed',
>(
  e: StoredEvent,
) => e.event as EventOf<T>;

export const repoProjectors: Record<string, Projector> = {
  RepoCreateRequested: async (tx, e) => {
    const p = ev<'RepoCreateRequested'>(e).payload;
    await exec(
      tx,
      `INSERT INTO repo_requests (id, org_id, project_id, name, visibility, description, requested_by_agent_id, thread_id, desk_item_id, status, created_at, updated_at)
       SELECT $1, pr.org_id, pr.id, $3, $4, $5, $6, $7, $8, 'pending', $9, $9 FROM projects pr WHERE pr.id = $2`,
      [
        p.requestId,
        p.projectId,
        p.name,
        p.visibility,
        p.description ?? null,
        p.requestedByAgentId,
        p.threadId ?? null,
        p.deskItemId,
        e.createdAt,
      ],
    );
  },
  RepoCreateApproved: async (tx, e) => {
    const p = ev<'RepoCreateApproved'>(e).payload;
    await exec(
      tx,
      `UPDATE repo_requests SET status='approved', approved_by=$2, workstation_id=$3, updated_at=$4 WHERE id=$1`,
      [p.requestId, p.approvedBy, p.workstationId, e.createdAt],
    );
  },
  RepoCreateRetried: async (tx, e) => {
    const p = ev<'RepoCreateRetried'>(e).payload;
    await exec(
      tx,
      `UPDATE repo_requests SET status='approved', workstation_id=$2, error=NULL, updated_at=$3 WHERE id=$1`,
      [p.requestId, p.workstationId, e.createdAt],
    );
  },
  RepoCreateRejected: async (tx, e) => {
    const p = ev<'RepoCreateRejected'>(e).payload;
    await exec(tx, `UPDATE repo_requests SET status='rejected', error=$2, updated_at=$3 WHERE id=$1`, [
      p.requestId,
      p.reason ?? null,
      e.createdAt,
    ]);
  },
  RepoCreateCompleted: async (tx, e) => {
    const p = ev<'RepoCreateCompleted'>(e).payload;
    await exec(
      tx,
      `UPDATE repo_requests SET status='created', remote_url=$2, local_path=$3, project_repo_id=$4, error=NULL, updated_at=$5 WHERE id=$1`,
      [p.requestId, p.remoteUrl, p.localPath ?? null, p.projectRepoId, e.createdAt],
    );
  },
  RepoCreateFailed: async (tx, e) => {
    const p = ev<'RepoCreateFailed'>(e).payload;
    await exec(tx, `UPDATE repo_requests SET status='failed', error=$2, updated_at=$3 WHERE id=$1`, [
      p.requestId,
      p.error,
      e.createdAt,
    ]);
  },
};
