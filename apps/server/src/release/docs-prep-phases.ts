import type { Ctx } from '../context.ts';
import type { Queryable, Row } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import {
  changelogApplyInput,
  guideApplyInput,
  runChangelogWritePhase,
  runGuideWritePhase,
} from './docs-prep-writer.ts';
import { runVideosAuthorPhase, videosRenderInput, videosRepairRound } from './docs-prep-videos.ts';

/**
 * The server's side of the phased content steps: which phases the server runs itself, what a runner phase gets from an
 * earlier phase, and what runs after a runner phase failed. One registry for Write changelog, Update user guide and
 * Generate videos, so a new content step registers here and adds no writer path of its own.
 */

export interface ServerPhaseOutcome {
  /** `running`: the phase waits for its tasks (release_prep shifts); their end finishes the row. */
  state: 'passed' | 'failed' | 'skipped' | 'running';
  error?: string;
  report?: Record<string, unknown>;
}

/** Server phases by step and phase. */
export const SERVER_PHASES: Record<
  string,
  (ctx: Ctx, tx: Tx, run: Row, repoId: string) => Promise<ServerPhaseOutcome>
> = {
  'changelog/write': runChangelogWritePhase,
  'guide/write': runGuideWritePhase,
  'videos/author': runVideosAuthorPhase,
};

/** Runs after a runner phase failed: true when the step goes on (a repair round) instead of failing the run. */
export const PHASE_FAILURE_HOOKS: Record<
  string,
  (ctx: Ctx, tx: Tx, run: Row, repoId: string) => Promise<boolean>
> = { 'videos/render': videosRepairRound };

/** Inputs of runner phases that need an earlier phase's report or result. */
export const PHASE_INPUTS: Record<
  string,
  (tx: Queryable, runId: string, repoId: string) => Promise<Record<string, unknown>>
> = {
  'changelog/apply': changelogApplyInput,
  'guide/apply': guideApplyInput,
  'videos/render': videosRenderInput,
};

/** Reports above this size (JSON) are not stored; the step's error says so. */
export const REPORT_MAX_BYTES = 64 * 1024;
