import { type EventOf, stepPhases } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

type T =
  | 'ReleaseDocsPrepSettingsSet'
  | 'ReleaseDocsPrepStarted'
  | 'ReleaseDocsPrepStepStarted'
  | 'ReleaseDocsPrepStepFinished'
  | 'ReleaseDocsPrepFinished'
  | 'ReleaseDocsPrepSkipped'
  | 'ReleaseDocsPrepStepReset'
  | 'ReleaseDocsPrepTaskQueued'
  | 'ReleaseDocsPrepTaskDispatched'
  | 'ReleaseDocsPrepTaskRequeued'
  | 'ReleaseDocsPrepTaskFinished';
const ev = <K extends T>(e: { event: unknown }) => e.event as EventOf<K>;

/**
 * Release prep (docs and videos), migration 2830. Every write uses the event's time and is an upsert or a keyed update,
 * so a rebuild gives the same rows.
 */
export const releaseDocsPrepProjectors: Record<string, Projector> = {
  ReleaseDocsPrepSettingsSet: async (tx, e) => {
    const p = ev<'ReleaseDocsPrepSettingsSet'>(e).payload;
    await exec(tx, 'UPDATE projects SET release_docs_prep=$2::jsonb WHERE id=$1', [
      p.projectId,
      JSON.stringify({
        enabled: p.enabled,
        steps: p.steps,
        ...(p.guidePaths && Object.keys(p.guidePaths).length > 0 ? { guidePaths: p.guidePaths } : {}),
      }),
    ]);
  },
  ReleaseDocsPrepStarted: async (tx, e) => {
    const p = ev<'ReleaseDocsPrepStarted'>(e).payload;
    await exec(
      tx,
      `INSERT INTO release_docs_prep_runs (id, org_id, project_id, release_branch, status, steps, trigger, retry_of, started_by, started_at, updated_at)
       SELECT $1, pr.org_id, pr.id, $3, 'running', $4::text[], $5, $6, $7, $8, $8 FROM projects pr WHERE pr.id = $2
       ON CONFLICT (id) DO NOTHING`,
      [
        p.runId,
        p.projectId,
        p.releaseBranch,
        p.steps,
        p.trigger,
        p.retryOf ?? null,
        p.startedBy,
        e.createdAt,
      ],
    );
    for (const r of p.repos) {
      await exec(
        tx,
        `INSERT INTO release_docs_prep_repos (run_id, repo_id, branch, main_branch, workstation_id, state)
         VALUES ($1,$2,$3,$4,$5,'pending') ON CONFLICT (run_id, repo_id) DO NOTHING`,
        [p.runId, r.repoId, r.branch, r.mainBranch, r.workstationId],
      );
      for (const step of p.steps) {
        for (const phase of stepPhases(step))
          await exec(
            tx,
            `INSERT INTO release_docs_prep_steps (run_id, repo_id, step, phase, state)
             VALUES ($1,$2,$3,$4,'pending') ON CONFLICT DO NOTHING`,
            [p.runId, r.repoId, step, phase],
          );
      }
    }
  },
  ReleaseDocsPrepStepStarted: async (tx, e) => {
    const p = ev<'ReleaseDocsPrepStepStarted'>(e).payload;
    await exec(
      tx,
      `UPDATE release_docs_prep_steps SET state='running', command_id=$5, started_at=$6, finished_at=NULL, error=NULL
        WHERE run_id=$1 AND repo_id=$2 AND step=$3 AND phase=$4`,
      [p.runId, p.repoId, p.step, p.phase ?? '', p.commandId ?? null, e.createdAt],
    );
    await exec(
      tx,
      `UPDATE release_docs_prep_repos SET state='running' WHERE run_id=$1 AND repo_id=$2 AND state='pending'`,
      [p.runId, p.repoId],
    );
    await exec(tx, 'UPDATE release_docs_prep_runs SET updated_at=$2 WHERE id=$1', [p.runId, e.createdAt]);
  },
  ReleaseDocsPrepStepFinished: async (tx, e) => {
    const p = ev<'ReleaseDocsPrepStepFinished'>(e).payload;
    await exec(
      tx,
      `UPDATE release_docs_prep_steps SET state=$5, finished_at=$6, files=$7::text[], error=$8, output=$9::jsonb,
         report=COALESCE($10::jsonb, report)
        WHERE run_id=$1 AND repo_id=$2 AND step=$3 AND phase=$4`,
      [
        p.runId,
        p.repoId,
        p.step,
        p.phase ?? '',
        p.state,
        e.createdAt,
        p.files,
        p.error ?? null,
        p.output === undefined ? null : JSON.stringify(p.output),
        p.report ? JSON.stringify(p.report) : null,
      ],
    );
    await exec(
      tx,
      `UPDATE release_docs_prep_repos SET
         state = CASE WHEN $3 = 'failed' THEN 'failed' WHEN $3 = 'skipped' AND $4 = 'analyse' THEN 'skipped' ELSE state END,
         summary = COALESCE($5::jsonb, summary), base_tag = CASE WHEN $5::jsonb IS NULL THEN base_tag ELSE $6 END,
         base_sha = COALESCE($7, base_sha), head_sha = COALESCE($8, head_sha),
         commit_sha = COALESCE($9, commit_sha), pushed = pushed OR $10
        WHERE run_id=$1 AND repo_id=$2`,
      [
        p.runId,
        p.repoId,
        p.state,
        p.step,
        p.summary ? JSON.stringify(p.summary) : null,
        p.baseTag ?? null,
        p.baseSha ?? null,
        p.headSha ?? null,
        p.commit ?? null,
        p.pushed ?? false,
      ],
    );
    await exec(tx, 'UPDATE release_docs_prep_runs SET updated_at=$2 WHERE id=$1', [p.runId, e.createdAt]);
  },
  ReleaseDocsPrepFinished: async (tx, e) => {
    const p = ev<'ReleaseDocsPrepFinished'>(e).payload;
    await exec(
      tx,
      `UPDATE release_docs_prep_runs SET status=$2, finished_at=$3, updated_at=$3, failed_step=$4, failed_repo_id=$5, error=$6
        WHERE id=$1 AND status='running'`,
      [p.runId, p.status, e.createdAt, p.step ?? null, p.repoId ?? null, p.error ?? null],
    );
    if (p.status === 'passed')
      await exec(
        tx,
        `UPDATE release_docs_prep_repos SET state='passed' WHERE run_id=$1 AND state IN ('pending','running')`,
        [p.runId],
      );
  },
  ReleaseDocsPrepStepReset: async (tx, e) => {
    const p = ev<'ReleaseDocsPrepStepReset'>(e).payload;
    // The report stays: the author phase of the repair round reads the render errors from it.
    await exec(
      tx,
      `UPDATE release_docs_prep_steps SET state='pending', command_id=NULL, started_at=NULL, finished_at=NULL, error=NULL
        WHERE run_id=$1 AND repo_id=$2 AND step=$3 AND phase=$4`,
      [p.runId, p.repoId, p.step, p.phase],
    );
    await exec(
      tx,
      `UPDATE release_docs_prep_repos SET state='running' WHERE run_id=$1 AND repo_id=$2 AND state='failed'`,
      [p.runId, p.repoId],
    );
  },
  ReleaseDocsPrepTaskQueued: async (tx, e) => {
    const p = ev<'ReleaseDocsPrepTaskQueued'>(e).payload;
    await exec(
      tx,
      `INSERT INTO release_docs_prep_tasks (id, run_id, repo_id, step, phase, position, attempt, task, workstation_id,
         status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,'queued',$10,$10) ON CONFLICT (id) DO NOTHING`,
      [
        p.taskId,
        p.runId,
        p.repoId,
        p.step,
        p.phase,
        p.position,
        p.attempt,
        JSON.stringify(p.task),
        p.workstationId,
        e.createdAt,
      ],
    );
  },
  ReleaseDocsPrepTaskDispatched: async (tx, e) => {
    const p = ev<'ReleaseDocsPrepTaskDispatched'>(e).payload;
    await exec(
      tx,
      `INSERT INTO shifts (id, org_id, agent_id, workstation_id, card_id, kind, stage, status, runtime, model, overflow,
         started_at, release_prep_task_id, account_key)
       SELECT $1, a.org_id, a.id, $3, NULL, 'release_prep', NULL, 'starting', a.runtime, a.model, false, $4, $5, $6
         FROM agents a WHERE a.id = $2
       ON CONFLICT (id) DO NOTHING`,
      [p.shiftId, p.agentId, p.workstationId, e.createdAt, p.taskId, p.accountKey ?? null],
    );
    await exec(
      tx,
      `UPDATE release_docs_prep_tasks SET status='running', agent_id=$2, shift_id=$3, updated_at=$4 WHERE id=$1`,
      [p.taskId, p.agentId, p.shiftId, e.createdAt],
    );
  },
  ReleaseDocsPrepTaskRequeued: async (tx, e) => {
    const p = ev<'ReleaseDocsPrepTaskRequeued'>(e).payload;
    await exec(
      tx,
      `UPDATE release_docs_prep_tasks SET status='queued', shift_id=NULL, agent_id=NULL, note=$2, updated_at=$3
        WHERE id=$1 AND status='running'`,
      [p.taskId, p.reason, e.createdAt],
    );
  },
  ReleaseDocsPrepTaskFinished: async (tx, e) => {
    const p = ev<'ReleaseDocsPrepTaskFinished'>(e).payload;
    await exec(
      tx,
      `UPDATE release_docs_prep_tasks SET status=$2, note=$3, commit_sha=$4, files=$5::jsonb, updated_at=$6,
              result=$7::jsonb, code=$8
        WHERE id=$1 AND status IN ('queued','running')`,
      [
        p.taskId,
        p.ok ? 'done' : 'failed',
        p.note,
        p.commit ?? null,
        JSON.stringify(p.files),
        e.createdAt,
        p.result === undefined ? null : JSON.stringify(p.result),
        p.code ?? null,
      ],
    );
  },
  ReleaseDocsPrepSkipped: async (tx, e) => {
    const p = ev<'ReleaseDocsPrepSkipped'>(e).payload;
    await exec(
      tx,
      `INSERT INTO release_docs_prep_runs (id, org_id, project_id, release_branch, status, steps, trigger, started_by, started_at, finished_at, skipped_by, skipped_at, updated_at)
       SELECT $1, pr.org_id, pr.id, $3, 'skipped', '{}', 'skip', $4, $5, $5, $4, $5, $5 FROM projects pr WHERE pr.id = $2
       ON CONFLICT (id) DO UPDATE SET status='skipped', finished_at=$5, skipped_by=$4, skipped_at=$5, updated_at=$5`,
      [p.runId, p.projectId, p.releaseBranch, p.skippedBy, e.createdAt],
    );
  },
};
