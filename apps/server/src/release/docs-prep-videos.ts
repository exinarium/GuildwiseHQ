import { authorFailure, NO_NEW_VIDEOS_NOTE, streamId, VideoStepReportSchema } from '@aom/shared';
import { projectScope, SYSTEM_ACTOR } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import {
  failedNewVideos,
  newVideoTasks,
  phaseTasks,
  queueReleasePrepTasks,
  registerPhaseTasksFinisher,
} from './docs-prep-tasks.ts';

/**
 * Release prep 'Generate videos', the server's side: the `author` phase (between the runner's `plan` and `render`) and
 * the input the `render` phase gets.
 */

export interface ServerPhaseOutcome {
  /** `running`: the phase waits for its tasks (release_prep shifts); their end finishes the row. */
  state: 'passed' | 'failed' | 'skipped' | 'running';
  error?: string;
  report?: Record<string, unknown>;
}

async function stepReport(tx: Queryable, runId: string, repoId: string, phase: string) {
  const row = await one(
    tx,
    `SELECT report FROM release_docs_prep_steps WHERE run_id=$1 AND repo_id=$2 AND step='videos' AND phase=$3`,
    [runId, repoId, phase],
  );
  return (row?.report ?? null) as Record<string, unknown> | null;
}

const authoredOf = (report: Record<string, unknown> | null): string[] =>
  Array.isArray(report?.authored) ? (report.authored as unknown[]).map(String) : [];

/**
 * The `author` phase. With nothing to write (no new user-visible screen) it is skipped with 'no new videos'. Otherwise
 * it queues one release_prep task per new video (a builder writes the spec and narration, one after the other) and
 * waits. In the repair round (after a failed render of a new video) it queues one task per failed new video, with the
 * render error.
 */
export async function runVideosAuthorPhase(
  ctx: Ctx,
  tx: Tx,
  run: Row,
  repoId: string,
): Promise<ServerPhaseOutcome> {
  const plan = await stepReport(tx, run.id, repoId, 'plan');
  const parsed = VideoStepReportSchema.safeParse(plan);
  if (!parsed.success) return { state: 'failed', error: 'the videos plan of this repository has no report' };
  const earlier = await phaseTasks(tx, run.id, repoId, 'videos', 'author');
  if (earlier.length === 0) {
    const tasks = newVideoTasks(plan);
    if (tasks.length === 0) return { state: 'skipped', error: NO_NEW_VIDEOS_NOTE, report: { authored: [] } };
    await queueReleasePrepTasks(ctx, tx, run, repoId, 'videos', 'author', 0, tasks);
    return { state: 'running' };
  }
  // The repair round: only the new videos whose render failed get another script.
  const authored = new Set(authoredOf(await stepReport(tx, run.id, repoId, 'author')));
  const failed = failedNewVideos(await stepReport(tx, run.id, repoId, 'render'), authored);
  const tasks = newVideoTasks(plan, failed);
  if (tasks.length === 0) return { state: 'failed', error: 'the repair round found no video to write again' };
  await queueReleasePrepTasks(ctx, tx, run, repoId, 'videos', 'author', 1, tasks);
  return { state: 'running' };
}

/** The author row once its tasks are finished: passed with the authored slugs, or failed naming each video. */
registerPhaseTasksFinisher('videos/author', async (tx, run, repoId, tasks) => {
  const before = authoredOf(await stepReport(tx, run.id, repoId, 'author'));
  const slugOf = (t: Row) => String((t.task as { slug?: unknown }).slug ?? '');
  const done = tasks.filter((t) => t.status === 'done').map(slugOf);
  const bad = tasks.filter((t) => t.status !== 'done');
  const authored = [...new Set([...before, ...done])].sort();
  const repair = tasks.some((t) => t.attempt > 0);
  if (bad.length > 0)
    return {
      state: 'failed',
      error: `${bad.length} new video(s) could not be written: ${bad
        .map((t) => authorFailure(slugOf(t), t.note || 'the agent gave no reason'))
        .join('; ')}`,
      report: { authored, failed: bad.map(slugOf), ...(repair ? { repair: true } : {}) },
    };
  return { state: 'passed', report: { authored, ...(repair ? { repair: true } : {}) } };
});

/**
 * After a failed render: when a newly written video failed and its script had no repair round yet, author and render
 * go back to pending (the run goes on with a repair round) instead of failing the run. Existing videos get none.
 */
export async function videosRepairRound(ctx: Ctx, tx: Tx, run: Row, repoId: string): Promise<boolean> {
  const tasks = await phaseTasks(tx, run.id, repoId, 'videos', 'author');
  if (tasks.length === 0 || tasks.some((t) => t.attempt > 0)) return false;
  const authored = new Set(authoredOf(await stepReport(tx, run.id, repoId, 'author')));
  const failed = failedNewVideos(await stepReport(tx, run.id, repoId, 'render'), authored);
  if (failed.size === 0) return false;
  const reason = `repair round for ${[...failed.keys()].join(', ')}`;
  await ctx.store.append(
    ['author', 'render'].map((phase) => ({
      streamId: streamId.releaseDocsPrep(run.id),
      event: {
        type: 'ReleaseDocsPrepStepReset' as const,
        payload: { runId: run.id as string, repoId, step: 'videos', phase, reason },
      },
      actor: SYSTEM_ACTOR,
      scope: projectScope(run.org_id, run.project_id),
    })),
    { tx },
  );
  return true;
}

/** What the `render` phase gets: the plan's report and the slugs whose script the author phase wrote. */
export async function videosRenderInput(
  tx: Queryable,
  runId: string,
  repoId: string,
): Promise<Record<string, unknown>> {
  const plan = await stepReport(tx, runId, repoId, 'plan');
  const author = await stepReport(tx, runId, repoId, 'author');
  return { plan: plan ?? {}, authored: authoredOf(author) };
}

/** Server phases by step and phase. */
export const SERVER_PHASES: Record<
  string,
  (ctx: Ctx, tx: Tx, run: Row, repoId: string) => Promise<ServerPhaseOutcome>
> = { 'videos/author': runVideosAuthorPhase };

/** Runs after a runner phase failed: true when the step goes on (a repair round) instead of failing the run. */
export const PHASE_FAILURE_HOOKS: Record<
  string,
  (ctx: Ctx, tx: Tx, run: Row, repoId: string) => Promise<boolean>
> = { 'videos/render': videosRepairRound };

/** Inputs of runner phases that need an earlier phase's report. */
export const PHASE_INPUTS: Record<
  string,
  (tx: Queryable, runId: string, repoId: string) => Promise<Record<string, unknown>>
> = { 'videos/render': videosRenderInput };

/** Reports above this size (JSON) are not stored; the step's error says so. */
export const REPORT_MAX_BYTES = 64 * 1024;
