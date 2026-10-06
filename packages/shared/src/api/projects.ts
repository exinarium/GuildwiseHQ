import { z } from 'zod';
import { ProjectChangesSchema, ProjectDomain } from '../events/project.ts';
import { ProjectKeySchema } from '../ids.ts';
import { BranchPrefixSchema, GitRefSchema, RemoteUrlSchema, VaultFolderSchema } from '../safe.ts';
import { IsoTime } from './common.ts';

export const ProjectRepoDtoSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  name: z.string(),
  remoteUrl: z.string(),
  remoteUrlNormalized: z.string(),
  /** The confirmed working branch; null until the manager named one (hygiene commits nothing then). */
  workingBranch: z.string().nullable(),
  removedAt: IsoTime.nullable(),
  /** Branches of the clone, as the last hygiene run saw them (the options of the working-branch question). */
  knownBranches: z.array(z.string()).optional(),
  workingBranchSetAt: IsoTime.nullable().optional(),
  /** The open desk question that asks for this repository's working branch. */
  branchQuestionId: z.uuid().nullable().optional(),
});
export type ProjectRepoDto = z.infer<typeof ProjectRepoDtoSchema>;

export const ProjectDtoSchema = z.object({
  id: z.uuid(),
  orgId: z.uuid(),
  /** The organization that owns the project (guests see it as a label). */
  orgName: z.string().optional(),
  key: z.string(),
  name: z.string(),
  domain: ProjectDomain,
  workflowKey: z.string(),
  /** M10: the department of the project's workflow (its type). */
  department: z.string().nullable().optional(),
  priorityTier: z.number().int(),
  branchPrefix: z.string(),
  workingBranch: z.string(),
  subCategories: z.array(z.string()),
  vaultFolder: z.string().nullable(),
  architecturalGlobs: z.array(z.string()),
  e2eGlobs: z.array(z.string()),
  status: z.enum(['active', 'archived']),
  /** Owner-only setting: large-tier merges finalize without the manager's desk approval (default off). */
  mergeLargeWithoutApproval: z.boolean().optional(),
  /** Who last changed the setting and when (null: never). */
  mergeLargeChanged: z.object({ byName: z.string(), at: IsoTime }).nullable().optional(),
  /** Optional cap on shifts running at once on this project; null: no cap (the default). */
  maxConcurrentShifts: z.number().int().nullable().optional(),
  createdAt: IsoTime,
  /** The requesting user's relation to the project. */
  myRole: z.enum(['owner', 'manager']),
});
export type ProjectDto = z.infer<typeof ProjectDtoSchema>;

/** `PUT /api/projects/:id/concurrency-cap`: a number of shifts, or null to remove the cap. */
export const SetConcurrencyCapRequestSchema = z.object({ cap: z.number().int().min(1).max(50).nullable() });
export type SetConcurrencyCapRequest = z.infer<typeof SetConcurrencyCapRequestSchema>;

export const ProjectMemberDtoSchema = z.object({
  userId: z.uuid(),
  displayName: z.string(),
  email: z.string(),
  role: z.enum(['owner', 'manager']),
  status: z.enum(['invited', 'active', 'removed']),
});

/** `status` defaults to `active`: archived projects never appear unless asked for (`archived`, or `all`). */
export const ProjectsQuerySchema = z.object({
  department: z.string().optional(),
  status: z.enum(['active', 'archived', 'all']).optional(),
});
/** What archiving a project stops (shown in the confirmation dialog). */
export const ProjectImpactSchema = z.object({
  activeShifts: z.number().int(),
  openCards: z.number().int(),
  schedules: z.number().int(),
  openDeskItems: z.number().int(),
});
export type ProjectImpact = z.infer<typeof ProjectImpactSchema>;
/** Permanent delete: the caller types the project key, the server checks it matches. */
export const DeleteProjectRequestSchema = z.object({ confirmKey: z.string().min(1) });
export type DeleteProjectRequest = z.infer<typeof DeleteProjectRequestSchema>;
export const ProjectsResponseSchema = z.object({ projects: z.array(ProjectDtoSchema) });
export const ProjectDetailResponseSchema = z.object({
  project: ProjectDtoSchema,
  repos: z.array(ProjectRepoDtoSchema),
  members: z.array(ProjectMemberDtoSchema),
  /** The setting's change history, newest first (who turned it on or off, when). */
  mergePolicyHistory: z
    .array(z.object({ enabled: z.boolean(), byName: z.string(), at: IsoTime }))
    .default([]),
});
export type ProjectDetailResponse = z.infer<typeof ProjectDetailResponseSchema>;

export const CreateProjectRequestSchema = z.object({
  key: ProjectKeySchema,
  name: z.string().min(1).max(120),
  domain: ProjectDomain.default('work'),
  workflowKey: z.string().min(1).default('code'),
  priorityTier: z.number().int().min(1).max(4).default(2),
  branchPrefix: BranchPrefixSchema.default('aom/'),
  workingBranch: GitRefSchema.default('main'),
  subCategories: z.array(z.string()).default([]),
  vaultFolder: VaultFolderSchema.nullable().default(null),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

/** `PUT /api/projects/:id/merge-policy` (owner only). */
export const SetMergePolicyRequestSchema = z.object({ mergeLargeWithoutApproval: z.boolean() });
export type SetMergePolicyRequest = z.infer<typeof SetMergePolicyRequestSchema>;

export const PatchProjectRequestSchema = ProjectChangesSchema;
export type PatchProjectRequest = z.infer<typeof PatchProjectRequestSchema>;

export const AddRepoRequestSchema = z.object({
  name: z.string().min(1).max(120),
  remoteUrl: RemoteUrlSchema,
  workingBranch: GitRefSchema.optional(),
});
export type AddRepoRequest = z.infer<typeof AddRepoRequestSchema>;
export const RepoParamsSchema = z.object({ id: z.uuid(), repoId: z.uuid() });
