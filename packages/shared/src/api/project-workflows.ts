import { z } from 'zod';
import { CatalogueStatus } from '../events/catalogue.ts';
import { WorkflowVariantSpecSchema } from '../workflows/variant.ts';
import { DefinitionIssueSchema } from './org.ts';

/** A workflow version waiting to become a project's variant (draft, or submitted and awaiting the owner's approval). */
export const PendingVariantSchema = z.object({
  id: z.uuid(),
  version: z.number().int(),
  status: CatalogueStatus,
  deskItemId: z.uuid().nullable(),
  /** The insertions of this version (what the editor continues from when it is a draft). */
  variantSpec: WorkflowVariantSpecSchema.nullable(),
});

/** One workflow in the project's list (enabled or available to enable). */
export const ProjectWorkflowDtoSchema = z.object({
  workflowKey: z.string(),
  name: z.string(),
  /** The version new cards use (the newest active one; a variant that is not approved yet shows its pending one). */
  version: z.number().int(),
  /** The workflow version row of `version` (what Rebase starts from). */
  versionId: z.uuid(),
  isPrimary: z.boolean(),
  enabled: z.boolean(),
  /** Card types this workflow is the default for in this project. */
  defaultCardTypes: z.array(z.string()),
  /** Card types the workflow runs. */
  cardTypes: z.array(z.string()),
  /** Set for a project variant: the base it extends (and the version it was materialised from). */
  variantOf: z.object({ key: z.string(), version: z.number().int() }).nullable(),
  /** A variant: the newest version of its base, when newer than the one it extends ("Rebase"). */
  baseUpdate: z.object({ version: z.number().int() }).nullable(),
  /** A variant: the newest draft or submitted version. */
  pendingVersion: PendingVariantSchema.nullable(),
  /** The variant's insertions (for the editor), when it is one. */
  variantSpec: WorkflowVariantSpecSchema.nullable(),
  /** The workflow's stages in order, for the editor's read-only list. */
  stages: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      kind: z.enum(['agent', 'manual', 'terminal', 'subworkflow', 'human', 'server']),
      claimRole: z.string().nullable(),
      inherited: z.boolean(),
    }),
  ),
  /** Cards of this project still open on any version of the workflow. */
  openCards: z.number().int(),
});
export type ProjectWorkflowDto = z.infer<typeof ProjectWorkflowDtoSchema>;

/** `GET /api/projects/:id/workflows` */
export const ProjectWorkflowsResponseSchema = z.object({
  enabled: z.array(ProjectWorkflowDtoSchema),
  available: z.array(ProjectWorkflowDtoSchema),
  /** The caller may enable workflows and create variants (organization Owner and Admins). */
  canEdit: z.boolean(),
});
export type ProjectWorkflowsResponse = z.infer<typeof ProjectWorkflowsResponseSchema>;

/** `PUT /api/projects/:id/workflows`: the full enabled set (the primary workflow stays enabled whatever is sent). */
export const SetProjectWorkflowsRequestSchema = z.object({
  enabled: z
    .array(z.object({ workflowKey: z.string().min(1), defaultCardTypes: z.array(z.string()).default([]) }))
    .max(20),
});
export type SetProjectWorkflowsRequest = z.infer<typeof SetProjectWorkflowsRequestSchema>;

/** `POST /api/projects/:id/workflow-variants` and `PUT .../:versionId`: the insertions (the project comes from the URL). */
export const WorkflowVariantRequestSchema = WorkflowVariantSpecSchema.omit({ projectId: true });
export type WorkflowVariantRequest = z.infer<typeof WorkflowVariantRequestSchema>;

export const VariantParamsSchema = z.object({ id: z.uuid(), versionId: z.uuid() });

/** Draft answer of the variant routes: the stored draft, its issues and the materialised stage order. */
export const VariantDraftResponseSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  version: z.number().int(),
  status: CatalogueStatus,
  issues: z.array(DefinitionIssueSchema),
  stages: z.array(z.object({ id: z.string(), label: z.string(), inherited: z.boolean() })),
});
export type VariantDraftResponse = z.infer<typeof VariantDraftResponseSchema>;
