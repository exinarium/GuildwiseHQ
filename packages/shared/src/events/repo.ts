import { z } from 'zod';
import { defineEvent, Id } from './define.ts';

const Visibility = z.enum(['private', 'public']);

/**
 * Approved repository setup: an agent requested a new GitHub repository for a project; the project owner approves on
 * the desk; the owner's runner creates it; the server adds it to the project. The stream id is `repo-<requestId>`.
 */
export const repoEvents = [
  defineEvent(
    'RepoCreateRequested',
    z.object({
      requestId: Id,
      projectId: Id,
      name: z.string().min(3).max(200),
      visibility: Visibility,
      description: z.string().max(350).optional(),
      /** The git host the repository is made on (absent: GitHub) and, for a self-managed host, its name. */
      provider: z.enum(['github', 'gitlab', 'bitbucket-cloud', 'azure-devops']).optional(),
      host: z.string().max(200).optional(),
      /** Absent when the manager asked from the project's convert dialog (`requestedByUserId`). */
      requestedByAgentId: Id.optional(),
      requestedByUserId: Id.optional(),
      /** The chat or DevOps thread that gets the result. */
      threadId: Id.optional(),
      deskItemId: Id,
    }),
  ),
  defineEvent('RepoCreateApproved', z.object({ requestId: Id, approvedBy: Id, workstationId: Id })),
  /** The owner retried a failed request from its alert: back to approved for that workstation, error cleared. */
  defineEvent('RepoCreateRetried', z.object({ requestId: Id, by: Id, workstationId: Id })),
  defineEvent('RepoCreateRejected', z.object({ requestId: Id, by: Id, reason: z.string().optional() })),
  /** The runner created (or reused) the repository and the server added it to the project. */
  defineEvent(
    'RepoCreateCompleted',
    z.object({
      requestId: Id,
      remoteUrl: z.string(),
      localPath: z.string().optional(),
      projectRepoId: Id,
      existing: z.boolean().default(false),
    }),
  ),
  defineEvent(
    'RepoCreateFailed',
    z.object({ requestId: Id, error: z.string(), alertDeskItemId: Id.optional() }),
  ),
] as const;
