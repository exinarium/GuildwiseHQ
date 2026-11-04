import { z } from 'zod';
import { ReleaseDocsPrepSummarySchema } from '../release/docs-prep-dto.ts';
import { defineEvent, Id } from './define.ts';

const StepState = z.enum(['passed', 'failed', 'skipped']);

/** Release prep (docs and videos). Run events live on `releasedocs-<runId>`; the switch on `project-<id>`. */
export const releaseDocsPrepEvents = [
  defineEvent(
    'ReleaseDocsPrepSettingsSet',
    z.object({
      projectId: Id,
      enabled: z.boolean(),
      steps: z.record(z.string(), z.boolean()),
      setBy: Id,
    }),
  ),
  defineEvent(
    'ReleaseDocsPrepStarted',
    z.object({
      runId: Id,
      projectId: Id,
      releaseBranch: z.string(),
      steps: z.array(z.string()),
      repos: z.array(
        z.object({
          repoId: Id,
          branch: z.string(),
          mainBranch: z.string().nullable(),
          workstationId: Id,
        }),
      ),
      trigger: z.enum(['manual', 'retry']),
      retryOf: Id.optional(),
      startedBy: Id,
    }),
  ),
  defineEvent(
    'ReleaseDocsPrepStepStarted',
    z.object({
      runId: Id,
      repoId: Id,
      step: z.string(),
      phase: z.enum(['prepare', 'push']).optional(),
      commandId: Id.optional(),
    }),
  ),
  defineEvent(
    'ReleaseDocsPrepStepFinished',
    z.object({
      runId: Id,
      repoId: Id,
      step: z.string(),
      phase: z.enum(['prepare', 'push']).optional(),
      state: StepState,
      error: z.string().optional(),
      files: z.array(z.string()).default([]),
      summary: ReleaseDocsPrepSummarySchema.optional(),
      baseTag: z.string().nullable().optional(),
      baseSha: z.string().optional(),
      headSha: z.string().optional(),
      commit: z.string().optional(),
      pushed: z.boolean().optional(),
      /** The step's report (content steps), shown on the Releases page. */
      output: z.unknown().optional(),
    }),
  ),
  defineEvent(
    'ReleaseDocsPrepFinished',
    z.object({
      runId: Id,
      status: z.enum(['passed', 'failed']),
      step: z.string().optional(),
      repoId: Id.optional(),
      error: z.string().optional(),
    }),
  ),
  defineEvent(
    'ReleaseDocsPrepSkipped',
    z.object({
      runId: Id,
      projectId: Id,
      releaseBranch: z.string(),
      skippedBy: Id,
      wasStatus: z.enum(['not_run', 'failed', 'running']),
    }),
  ),
] as const;
