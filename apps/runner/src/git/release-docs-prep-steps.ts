import type { ReleaseDocsPrepPayload, ReleaseDocsPrepSummary } from '@aom/shared';

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
}

export type DocsPrepStepHandler = (
  ctx: DocsPrepStepContext,
) => Promise<{ ok: true; files: string[] } | { ok: false; error: string }>;

/** A sibling card adds one entry here (and one registry entry in the shared package). */
export const DOCS_PREP_STEP_HANDLERS: Record<string, DocsPrepStepHandler> = {};
