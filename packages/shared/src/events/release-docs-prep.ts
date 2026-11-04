import { z } from 'zod';
import { ReleaseDocsPrepSummarySchema } from '../release/docs-prep-dto.ts';
import { ReleasePrepTaskSchema } from '../release/docs-prep-task.ts';
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
      phase: z.string().max(20).optional(),
      commandId: Id.optional(),
    }),
  ),
  defineEvent(
    'ReleaseDocsPrepStepFinished',
    z.object({
      runId: Id,
      repoId: Id,
      step: z.string(),
      phase: z.string().max(20).optional(),
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
      /** The step's own report (videos: what was chosen, why, and each render's result). */
      report: z.record(z.string(), z.unknown()).optional(),
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
  /** A phase row goes back to pending (the repair round of Generate videos: author and render once more). */
  defineEvent(
    'ReleaseDocsPrepStepReset',
    z.object({ runId: Id, repoId: Id, step: z.string(), phase: z.string().max(20), reason: z.string() }),
  ),
  /** A task an agent does in a `release_prep` shift (a new video script), waiting for a builder on the workstation. */
  defineEvent(
    'ReleaseDocsPrepTaskQueued',
    z.object({
      taskId: Id,
      runId: Id,
      repoId: Id,
      step: z.string(),
      phase: z.string().max(20),
      position: z.number().int().nonnegative(),
      attempt: z.number().int().nonnegative(),
      task: ReleasePrepTaskSchema,
      workstationId: Id,
    }),
  ),
  defineEvent(
    'ReleaseDocsPrepTaskDispatched',
    z.object({
      taskId: Id,
      shiftId: Id,
      agentId: Id,
      workstationId: Id,
      accountKey: z.string().optional(),
    }),
  ),
  /** The shift ended without a report it could keep (rejected, lost, stopped): the task waits again. */
  defineEvent('ReleaseDocsPrepTaskRequeued', z.object({ taskId: Id, reason: z.string() })),
  defineEvent(
    'ReleaseDocsPrepTaskFinished',
    z.object({
      taskId: Id,
      ok: z.boolean(),
      note: z.string(),
      commit: z.string().optional(),
      files: z.array(z.string()).default([]),
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
