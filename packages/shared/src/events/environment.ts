import { z } from 'zod';
import { EnvironmentReportSchema, RepoCloneStateSchema, RightsReportSchema } from '../devops/environment.ts';
import { defineEvent, Id } from './define.ts';

/**
 * Workstation preparation (docs/RUNNER.md "Repository setup, toolchain and rights"). Audience: the project (clone and
 * environment) or the workstation's owner (rights). No event ever carries the sudo password or its ciphertext.
 */
export const environmentEvents = [
  /** A repository added to a project is being put on a workstation (`repo.clone` queued). */
  defineEvent(
    'RepoCloneRequested',
    z.object({
      requestId: Id,
      repoId: Id,
      projectId: Id,
      workstationId: Id,
      /** `create`: the manager chose "create new"; the repository is created if it does not exist. */
      mode: z.enum(['clone', 'create']),
      requestedBy: Id.optional(),
      /** Set with `mode: 'create'`: what the manager chose (the repository is created with the owner's code host login). */
      create: z
        .object({
          name: z.string(),
          visibility: z.enum(['private', 'public']),
          description: z.string().max(350).optional(),
        })
        .optional(),
    }),
  ),
  defineEvent(
    'RepoCloneReported',
    z.object({
      requestId: Id,
      repoId: Id,
      projectId: Id,
      workstationId: Id,
      state: RepoCloneStateSchema,
      detail: z.string().max(2000).optional(),
      localPath: z.string().optional(),
    }),
  ),
  /** The toolchain of a project is being checked or installed on a workstation; its cards wait until it is ready. */
  defineEvent(
    'EnvironmentPrepareRequested',
    z.object({
      requestId: Id,
      projectId: Id,
      workstationId: Id,
      reason: z.enum(['repo_cloned', 'repo_found', 'manual', 'access_changed']),
    }),
  ),
  defineEvent(
    'EnvironmentPrepared',
    z.object({
      requestId: Id,
      projectId: Id,
      workstationId: Id,
      report: EnvironmentReportSchema,
    }),
  ),
  /** The runner checked the rights the manager ticked on the DevOps engineer. */
  defineEvent('DevOpsRightsVerified', z.object({ workstationId: Id, report: RightsReportSchema })),
  /** The manager sent a sudo password (encrypted for the runner). Only the fact is recorded. */
  defineEvent(
    'DevOpsSudoPasswordSet',
    z.object({ workstationId: Id, by: Id, keyId: z.string(), works: z.boolean().optional() }),
  ),
  defineEvent('DevOpsSudoPasswordCleared', z.object({ workstationId: Id, by: Id })),
] as const;
