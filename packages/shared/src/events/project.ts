import { z } from 'zod';
import { WorkingBranchReason } from '../hygiene/index.ts';
import { ProjectKeySchema } from '../ids.ts';
import { BranchPrefixSchema, GitRefSchema, VaultFolderSchema } from '../safe.ts';
import { defineEvent, Id } from './define.ts';

export const ProjectDomain = z.enum(['work', 'personal']);
export type ProjectDomain = z.infer<typeof ProjectDomain>;

/** Mutable project columns (also the body of PATCH /api/projects/:id). */
export const ProjectChangesSchema = z
  .object({
    name: z.string().min(1).max(120),
    domain: ProjectDomain,
    workflowKey: z.string().min(1),
    priorityTier: z.number().int().min(1).max(4),
    branchPrefix: BranchPrefixSchema,
    workingBranch: GitRefSchema,
    subCategories: z.array(z.string()),
    vaultFolder: VaultFolderSchema.nullable(),
    architecturalGlobs: z.array(z.string()),
    e2eGlobs: z.array(z.string()),
  })
  .partial();
export type ProjectChanges = z.infer<typeof ProjectChangesSchema>;

export const projectEvents = [
  defineEvent(
    'ProjectCreated',
    z.object({
      projectId: Id,
      orgId: Id,
      /** Absent on events from before organizations (then the org's owner, `orgId`, created it). */
      createdByUserId: Id.optional(),
      key: ProjectKeySchema,
      name: z.string().min(1),
      domain: ProjectDomain,
      workflowKey: z.string().min(1),
      priorityTier: z.number().int().min(1).max(4),
      branchPrefix: z.string(),
      workingBranch: z.string().min(1),
      subCategories: z.array(z.string()),
      vaultFolder: z.string().nullable(),
    }),
  ),
  defineEvent('ProjectUpdated', z.object({ projectId: Id, changes: ProjectChangesSchema })),
  defineEvent(
    'ProjectRepoAdded',
    z.object({
      projectId: Id,
      repoId: Id,
      name: z.string().min(1),
      remoteUrl: z.string().min(1),
      remoteUrlNormalized: z.string().min(1),
      workingBranch: z.string().optional(),
    }),
  ),
  defineEvent('ProjectRepoRemoved', z.object({ projectId: Id, repoId: Id })),
  /**
   * The manager confirmed (or changed) the repository's working branch: the answer to the DevOps engineer's question on
   * the desk, or a change in the project settings. Hygiene commits and pushes only to a confirmed branch.
   */
  defineEvent(
    'ProjectRepoWorkingBranchSet',
    z.object({
      projectId: Id,
      repoId: Id,
      workingBranch: GitRefSchema,
      previousBranch: z.string().nullable().default(null),
      reason: WorkingBranchReason,
      setBy: Id,
      deskItemId: Id.optional(),
    }),
  ),
  /**
   * The project owner turned the large-merge approval off or on: with it on, a large-tier `merge` finalizes without the
   * manager's desk approval (default off). Recorded with who and when; shown in the project settings.
   */
  defineEvent(
    'ProjectMergePolicyChanged',
    z.object({ projectId: Id, mergeLargeWithoutApproval: z.boolean(), changedBy: Id }),
  ),
  /**
   * A member archived the project: it disappears from boards, pickers, the dispatcher, schedules, intake mapping and the
   * desk; history, cards and the vault folder are kept. The same append closes the open cards (`CardCancelled` with
   * cause `project_archived`), disables the schedules and dismisses the open desk items.
   */
  defineEvent('ProjectArchived', z.object({ projectId: Id, archivedBy: Id.optional() })),
  /** A member brought an archived project back. Closed cards stay closed and schedules stay disabled. */
  defineEvent('ProjectRestored', z.object({ projectId: Id, restoredBy: Id.optional() })),
  /**
   * The project owner deleted an archived project permanently. The projector removes every row of the project; the
   * event (with the key and name, for the audit trail) and the project's earlier events stay in the append-only log,
   * and a projection rebuild replays this tombstone after them so the project is not resurrected.
   */
  defineEvent(
    'ProjectDeleted',
    z.object({ projectId: Id, key: z.string(), name: z.string(), deletedBy: Id }),
  ),
] as const;
