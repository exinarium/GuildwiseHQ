import { z } from 'zod';
import { HygieneHoursSchema, HygieneProblemKind } from '../hygiene/index.ts';
import { defineEvent, Id } from './define.ts';

/**
 * Repository hygiene events (docs/design/phases.md, "DevOps repository hygiene and the working branch").
 * `WorkstationHygieneChanged` is the workstation's cadence; the two reports feed the open findings that the BA reporter
 * turns into signals. Audience `org` of the workstation's owner.
 */
export const hygieneEvents = [
  defineEvent(
    'WorkstationHygieneChanged',
    z.object({ workstationId: Id, intervalHours: HygieneHoursSchema, changedBy: Id }),
  ),
  /** What one hygiene run found per repository (`problem` null: in order, which resolves its earlier findings). */
  defineEvent(
    'HygieneRepoReported',
    z.object({
      requestId: Id,
      workstationId: Id,
      repos: z.array(
        z.object({
          repoId: Id,
          projectId: Id,
          name: z.string(),
          problem: z.object({ kind: HygieneProblemKind, detail: z.string() }).nullable(),
          files: z.array(z.string()).default([]),
          /** The branches of the clone (agent branches left out), kept for the working-branch question's options. */
          branches: z.array(z.string()).default([]),
        }),
      ),
    }),
  ),
  /** The runner's stale-worktree sweep found worktrees of dead cards it did not delete (uncommitted changes). */
  defineEvent(
    'WorktreeSweepReported',
    z.object({
      workstationId: Id,
      requestId: Id.optional(),
      removed: z.number().int().nonnegative(),
      kept: z.number().int().nonnegative(),
      dirty: z.array(
        z.object({ path: z.string(), branch: z.string().nullable(), files: z.array(z.string()) }),
      ),
    }),
  ),
] as const;
