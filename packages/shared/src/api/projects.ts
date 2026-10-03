import { z } from 'zod';
import { ProjectChangesSchema, ProjectDomain } from '../events/project.ts';
import { ProjectKeySchema } from '../ids.ts';
import { IsoTime } from './common.ts';

export const ProjectRepoDtoSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  name: z.string(),
  remoteUrl: z.string(),
  remoteUrlNormalized: z.string(),
  workingBranch: z.string().nullable(),
  removedAt: IsoTime.nullable(),
});
export type ProjectRepoDto = z.infer<typeof ProjectRepoDtoSchema>;

export const ProjectDtoSchema = z.object({
  id: z.uuid(),
  orgId: z.uuid(),
  key: z.string(),
  name: z.string(),
  domain: ProjectDomain,
  workflowKey: z.string(),
  priorityTier: z.number().int(),
  branchPrefix: z.string(),
  workingBranch: z.string(),
  subCategories: z.array(z.string()),
  vaultFolder: z.string().nullable(),
  architecturalGlobs: z.array(z.string()),
  e2eGlobs: z.array(z.string()),
  status: z.enum(['active', 'archived']),
  createdAt: IsoTime,
  /** The requesting user's relation to the project. */
  myRole: z.enum(['owner', 'manager']),
});
export type ProjectDto = z.infer<typeof ProjectDtoSchema>;

export const ProjectMemberDtoSchema = z.object({
  userId: z.uuid(),
  displayName: z.string(),
  email: z.string(),
  role: z.enum(['owner', 'manager']),
  status: z.enum(['invited', 'active', 'removed']),
});

export const ProjectsResponseSchema = z.object({ projects: z.array(ProjectDtoSchema) });
export const ProjectDetailResponseSchema = z.object({
  project: ProjectDtoSchema,
  repos: z.array(ProjectRepoDtoSchema),
  members: z.array(ProjectMemberDtoSchema),
});
export type ProjectDetailResponse = z.infer<typeof ProjectDetailResponseSchema>;

export const CreateProjectRequestSchema = z.object({
  key: ProjectKeySchema,
  name: z.string().min(1).max(120),
  domain: ProjectDomain.default('work'),
  workflowKey: z.string().min(1).default('code'),
  priorityTier: z.number().int().min(1).max(4).default(2),
  branchPrefix: z.string().default('aom/'),
  workingBranch: z.string().min(1).default('main'),
  subCategories: z.array(z.string()).default([]),
  vaultFolder: z.string().nullable().default(null),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const PatchProjectRequestSchema = ProjectChangesSchema;
export type PatchProjectRequest = z.infer<typeof PatchProjectRequestSchema>;

export const AddRepoRequestSchema = z.object({
  name: z.string().min(1).max(120),
  remoteUrl: z.string().min(1),
  workingBranch: z.string().min(1).optional(),
});
export type AddRepoRequest = z.infer<typeof AddRepoRequestSchema>;
export const RepoParamsSchema = z.object({ id: z.uuid(), repoId: z.uuid() });
