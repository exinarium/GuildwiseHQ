import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';

interface Finding {
  orgId: string;
  workstationId: string;
  projectId: string | null;
  subject: string;
  subjectName: string;
  kind: string;
  detail: string;
  files: string[];
  requestId: string | null;
}

/** Opens (or refreshes) the finding of a subject and closes its findings of any other kind. */
async function openFinding(tx: Tx, e: StoredEvent, f: Finding): Promise<void> {
  await exec(
    tx,
    `UPDATE hygiene_findings SET status='resolved', resolved_at=$4
      WHERE workstation_id=$1 AND subject=$2 AND status='open' AND kind <> $3`,
    [f.workstationId, f.subject, f.kind, e.createdAt],
  );
  await exec(
    tx,
    `INSERT INTO hygiene_findings (id, org_id, workstation_id, project_id, subject, subject_name, kind, detail, files,
       request_id, status, first_seen_at, last_seen_at)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,'open',$10,$10)
     ON CONFLICT (workstation_id, subject, kind) WHERE status = 'open'
     DO UPDATE SET detail = EXCLUDED.detail, files = EXCLUDED.files, subject_name = EXCLUDED.subject_name,
                   request_id = EXCLUDED.request_id, last_seen_at = EXCLUDED.last_seen_at`,
    [
      f.orgId,
      f.workstationId,
      f.projectId,
      f.subject,
      f.subjectName,
      f.kind,
      f.detail,
      JSON.stringify(f.files),
      f.requestId,
      e.createdAt,
    ],
  );
}

const resolveSubject = (tx: Tx, e: StoredEvent, workstationId: string, subject: string) =>
  exec(
    tx,
    `UPDATE hygiene_findings SET status='resolved', resolved_at=$3
      WHERE workstation_id=$1 AND subject=$2 AND status='open'`,
    [workstationId, subject, e.createdAt],
  );

export const hygieneProjectors: Record<string, Projector> = {
  WorkstationHygieneChanged: async (tx, e) => {
    const p = (e.event as EventOf<'WorkstationHygieneChanged'>).payload;
    await exec(tx, 'UPDATE workstations SET hygiene_interval_hours=$2 WHERE id=$1', [
      p.workstationId,
      p.intervalHours,
    ]);
  },

  ProjectRepoWorkingBranchSet: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectRepoWorkingBranchSet'>).payload;
    await exec(
      tx,
      `UPDATE project_repos SET working_branch=$2, working_branch_set_by=$3, working_branch_set_at=$4 WHERE id=$1`,
      [p.repoId, p.workingBranch, p.setBy, e.createdAt],
    );
    // Cards the runner turned away for the old branch are dispatchable again at once.
    await exec(
      tx,
      `UPDATE cards SET last_rejection=NULL, retry_after=NULL, retry_failures=0, retry_episode_id=NULL
        WHERE repo_id=$1 AND last_rejection->>'kind' = 'branch'`,
      [p.repoId],
    );
  },

  HygieneRepoReported: async (tx, e) => {
    const p = (e.event as EventOf<'HygieneRepoReported'>).payload;
    const orgId = e.scope.orgId as string;
    for (const r of p.repos) {
      if (r.branches.length)
        await exec(
          tx,
          'UPDATE project_repos SET known_branches=$2::jsonb, known_branches_at=$3 WHERE id=$1',
          [r.repoId, JSON.stringify(r.branches), e.createdAt],
        );
      // A missing working branch is a question on the desk, not a finding.
      if (!r.problem || r.problem.kind === 'needs_branch') {
        await resolveSubject(tx, e, p.workstationId, r.repoId);
        continue;
      }
      await openFinding(tx, e, {
        orgId,
        workstationId: p.workstationId,
        projectId: r.projectId,
        subject: r.repoId,
        subjectName: r.name,
        kind: r.problem.kind,
        detail: r.problem.detail,
        files: r.files,
        requestId: p.requestId,
      });
    }
  },

  WorktreeSweepReported: async (tx, e) => {
    const p = (e.event as EventOf<'WorktreeSweepReported'>).payload;
    const orgId = e.scope.orgId as string;
    const paths = p.dirty.map((d) => d.path);
    // Worktrees that are gone or clean now are not a finding any more.
    await exec(
      tx,
      `UPDATE hygiene_findings SET status='resolved', resolved_at=$3
        WHERE workstation_id=$1 AND kind='dirty_worktree' AND status='open' AND NOT (subject = ANY($2::text[]))`,
      [p.workstationId, paths, e.createdAt],
    );
    for (const d of p.dirty) {
      await openFinding(tx, e, {
        orgId,
        workstationId: p.workstationId,
        projectId: null,
        subject: d.path,
        subjectName: d.path,
        kind: 'dirty_worktree',
        detail: `The card of this worktree is finished, but it has uncommitted changes${d.branch ? ` on ${d.branch}` : ''}; it was not deleted.`,
        files: d.files,
        requestId: p.requestId ?? null,
      });
    }
  },
};
