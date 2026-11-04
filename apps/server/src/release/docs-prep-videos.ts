import { NO_NEW_VIDEOS_NOTE, VideoStepReportSchema } from '@aom/shared';
import { one, type Queryable } from '../db/sql.ts';

/**
 * Release prep 'Generate videos', the server's side: the `author` phase (between the runner's `plan` and `render`) and
 * the input the `render` phase gets.
 */

export interface ServerPhaseOutcome {
  state: 'passed' | 'failed' | 'skipped';
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

/**
 * The `author` phase. With nothing to write (no new user-visible screen) it is skipped with 'no new videos'. A new
 * screen needs its video script written by an agent; until that shift exists on this server, the phase fails naming
 * each new video, so nothing half-done is rendered or committed.
 */
export async function runVideosAuthorPhase(tx: Queryable, runId: string, repoId: string): Promise<ServerPhaseOutcome> {
  const parsed = VideoStepReportSchema.safeParse(await stepReport(tx, runId, repoId, 'plan'));
  if (!parsed.success) return { state: 'failed', error: 'the videos plan of this repository has no report' };
  const needs = parsed.data.needsAuthoring ?? [];
  if (needs.length === 0) return { state: 'skipped', error: NO_NEW_VIDEOS_NOTE, report: { authored: [] } };
  return {
    state: 'failed',
    error: `${needs.length} new video(s) need a script: ${needs
      .map((n) => `${n.slug}: could not write the video script: no agent can be given this task on this server yet`)
      .join('; ')}`,
    report: { authored: [], needed: needs.map((n) => n.slug) },
  };
}

/** What the `render` phase gets: the plan's report and the slugs whose script the author phase wrote. */
export async function videosRenderInput(
  tx: Queryable,
  runId: string,
  repoId: string,
): Promise<Record<string, unknown>> {
  const plan = await stepReport(tx, runId, repoId, 'plan');
  const author = await stepReport(tx, runId, repoId, 'author');
  const authored = Array.isArray(author?.authored) ? (author.authored as unknown[]).map(String) : [];
  return { plan: plan ?? {}, authored };
}

/** Server phases by step and phase. */
export const SERVER_PHASES: Record<string, (tx: Queryable, runId: string, repoId: string) => Promise<ServerPhaseOutcome>> =
  { 'videos/author': runVideosAuthorPhase };

/** Inputs of runner phases that need an earlier phase's report. */
export const PHASE_INPUTS: Record<
  string,
  (tx: Queryable, runId: string, repoId: string) => Promise<Record<string, unknown>>
> = { 'videos/render': videosRenderInput };

/** Reports above this size (JSON) are not stored; the step's error says so. */
export const REPORT_MAX_BYTES = 64 * 1024;
