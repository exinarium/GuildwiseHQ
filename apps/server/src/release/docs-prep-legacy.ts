import { streamId } from '@aom/shared';
import { orgScope, projectScope, SYSTEM_ACTOR } from '../commands/common.ts';
import type { ReportResult } from '../commands/shifts.ts';
import type { Ctx } from '../context.ts';
import { one, type Row } from '../db/sql.ts';
import { afterCommit, type Tx } from '../db/tx.ts';
import { advance } from './docs-prep.ts';

/**
 * REMOVE IN 1.7. Tasks of the retired BA kind `release_changelog` that were queued before the upgrade (GWP-134): Write
 * changelog now gets its text from a release prep task, so a report or fallback for such a task only closes it as
 * cancelled and fails the run's changelog row (if it still waits for it) with a message that asks for a retry.
 */

const INTERRUPTED = 'Write changelog was interrupted by an update. Retry prep.';

async function cancel(ctx: Ctx, tx: Tx, task: Row): Promise<void> {
  await ctx.store.append(
    [
      {
        streamId: streamId.baTask(task.id),
        event: {
          type: 'BaTaskCompleted' as const,
          payload: {
            taskId: task.id,
            status: 'cancelled',
            note: 'Write changelog now uses a release prep task',
          },
        },
        actor: SYSTEM_ACTOR,
        scope: task.project_id ? projectScope(task.org_id, task.project_id) : orgScope(task.org_id),
      },
    ],
    { tx },
  );
  if (!task.prep_run_id || !task.prep_repo_id) return;
  const run = await one(tx, 'SELECT * FROM release_docs_prep_runs WHERE id=$1 FOR UPDATE', [
    task.prep_run_id,
  ]);
  if (!run || run.status !== 'running') return;
  const row = await one(
    tx,
    `SELECT state FROM release_docs_prep_steps WHERE run_id=$1 AND repo_id=$2 AND step='changelog' AND phase=''`,
    [run.id, task.prep_repo_id],
  );
  if (row?.state !== 'running') return;
  await ctx.store.append(
    [
      {
        streamId: streamId.releaseDocsPrep(run.id),
        event: {
          type: 'ReleaseDocsPrepStepFinished',
          payload: {
            runId: run.id,
            repoId: task.prep_repo_id,
            step: 'changelog',
            state: 'failed',
            error: INTERRUPTED,
            files: [],
          },
        },
        actor: SYSTEM_ACTOR,
        scope: projectScope(run.org_id, run.project_id),
      },
    ],
    { tx },
  );
  const workstations = await advance(ctx, tx, run.id);
  for (const w of new Set(workstations))
    afterCommit(tx, () => {
      void Promise.resolve(ctx.services.gateway.deliverPending(w)).catch(() => undefined);
    });
}

/** A report of a `release_changelog` BA task queued before the upgrade. */
export async function applyLegacyChangelogReport(ctx: Ctx, tx: Tx, task: Row): Promise<ReportResult> {
  await cancel(ctx, tx, task);
  return {
    accepted: true,
    message: 'Write changelog now uses a release prep task; nothing is written from this report.',
  };
}

/** The fallback of a `release_changelog` BA task queued before the upgrade. */
export async function runLegacyChangelogFallback(ctx: Ctx, tx: Tx, task: Row): Promise<void> {
  await cancel(ctx, tx, task);
}
