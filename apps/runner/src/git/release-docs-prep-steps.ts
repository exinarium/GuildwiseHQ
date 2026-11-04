import type { ReleaseDocsPrepPayload, ReleaseDocsPrepSummary } from '@aom/shared';
import { runGuideStep } from './release-docs-prep-guide.ts';

/**
 * Handlers of the content steps of Release prep (docs and videos): changelog, user guide, videos. A handler writes files
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
  /** A scratch folder for this step (removed afterwards); the model writes only here. */
  outDir: string;
  /** One unattended model call as `payload.writer`: reads `readDirs`, writes only `writeDir`, no shell. */
  runModel: (req: DocsPrepModelRequest) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** A process with a time limit and the runner's toolchain PATH; output redacted. */
  exec: DocsPrepExec;
}

export interface DocsPrepModelRequest {
  instructions: string;
  prompt: string;
  readDirs: string[];
  writeDir: string;
  timeoutMs: number;
}

export type DocsPrepExec = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;

export type DocsPrepStepHandler = (
  ctx: DocsPrepStepContext,
) => Promise<
  { ok: true; files: string[]; output?: unknown } | { ok: false; error: string; output?: unknown }
>;

/** A sibling card adds one entry here (and one registry entry in the shared package). */
export const DOCS_PREP_STEP_HANDLERS: Record<string, DocsPrepStepHandler> = {
  guide: runGuideStep,
};
