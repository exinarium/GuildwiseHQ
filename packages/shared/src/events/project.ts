import { z } from 'zod';
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
   * The project owner turned the large-merge approval off or on: with it on, a large-tier `merge` finalizes without the
   * manager's desk approval (default off). Recorded with who and when; shown in the project settings.
   */
  defineEvent(
    'ProjectMergePolicyChanged',
    z.object({ projectId: Id, mergeLargeWithoutApproval: z.boolean(), changedBy: Id }),
  ),
  defineEvent('ProjectArchived', z.object({ projectId: Id })),
] as const;
