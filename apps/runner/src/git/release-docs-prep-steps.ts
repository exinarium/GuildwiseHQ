import type { ReleaseDocsPrepPayload, ReleaseDocsPrepSummary } from '@aom/shared';
import { changelogStep } from './release-docs-prep-changelog.ts';
import { runGuideStep } from './release-docs-prep-guide.ts';
import { runHelpStep } from './release-docs-prep-help.ts';
import { videosStep } from './release-docs-prep-videos.ts';

/**
 * Handlers of the content steps of Release prep (docs and videos): changelog, user guide, Help articles, videos. A handler writes files
 * into the throwaway worktree (cut from the release branch, with the earlier steps' commits) and returns the repo
 * relative paths it wrote. The runner commits them to a local kept ref; nothing leaves the workstation until the
 * 'commit' step pushes.
 *
 * Contract for a step: it must produce byte-identical files when its content is already on the branch. A retry after a
 * partial push then produces no diff and no duplicate commit.
 */
export interface DocsPrepStepContext {
  worktree: string;
  payload: ReleaseDocsPrepPayload;
  /** The analysis of 'Analyse changes' for this repository. */
  summary: ReleaseDocsPrepSummary | undefined;
  /** A scratch folder for this step (removed afterwards). */
  outDir: string;
  /** A process with a time limit and the runner's toolchain PATH; output redacted. */
  exec: DocsPrepExec;
  /** The phase of a step with phases; '' for a single-phase step. */
  phase: string;
  /** What an earlier phase handed on (payload.input). */
  input: Record<string, unknown> | undefined;
  /** The local clone, for read-only git (show, ls-tree, log). */
  repoPath: string;
  /** The runner's data folder (render cache). */
  dataDir: string | undefined;
  /** The commit the worktree started from. */
  start: string;
}

export type DocsPrepExec = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;

export type DocsPrepStepOutcome =
  | {
      ok: true;
      files: string[];
      /** What the step reports (per step id; 'changelog': ReleaseChangelogOutput). */
      output?: unknown;
      /** `skipped` with a note: the later phases of the step are skipped in this repository too. */
      state?: 'passed' | 'skipped';
      note?: string;
      report?: Record<string, unknown>;
    }
  | { ok: false; error: string; output?: unknown; report?: Record<string, unknown> };

export type DocsPrepStepHandler = (ctx: DocsPrepStepContext) => Promise<DocsPrepStepOutcome>;

export interface DocsPrepStepSpec {
  run: DocsPrepStepHandler;
  /** Phases that run without the repository lock (long renders); the lock is held only to add and keep the worktree. */
  unlocked?: readonly string[];
}

/** A sibling card adds one entry here (and one registry entry in the shared package). */
export const DOCS_PREP_STEP_HANDLERS: Record<string, DocsPrepStepHandler | DocsPrepStepSpec> = {
  changelog: changelogStep,
  guide: runGuideStep,
  help: runHelpStep,
  videos: videosStep,
};

export const stepSpecOf = (step: string): DocsPrepStepSpec | undefined => {
  const h = DOCS_PREP_STEP_HANDLERS[step];
  if (!h) return undefined;
  return typeof h === 'function' ? { run: h } : h;
};
