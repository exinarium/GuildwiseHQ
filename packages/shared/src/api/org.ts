import { z } from 'zod';
import { CatalogueStatus } from '../events/catalogue.ts';
import { RoleDefinitionSchema } from '../roles/schema.ts';
import { WorkflowDefinitionSchema } from '../workflows/schema.ts';
import { IsoTime } from './common.ts';

/**
 * Organization designer (M10): custom roles, custom workflows and departments, drafted by the manager or the BA,
 * validated, approved on the desk and only then available (docs/SPEC.md "Expanding the organization").
 */

/** What a manager or the BA submits for a role: the server assigns `builtIn: false` and the next version. */
export const RoleDraftInputSchema = RoleDefinitionSchema.omit({ version: true, builtIn: true });
export type RoleDraftInput = z.infer<typeof RoleDraftInputSchema>;

export const WorkflowDraftInputSchema = WorkflowDefinitionSchema.omit({
  version: true,
  builtIn: true,
}).extend({
  /** Defaults to 'custom': custom workflows keep their own card fields. */
  fieldSet: z.string().default('custom'),
});
export type WorkflowDraftInput = z.infer<typeof WorkflowDraftInputSchema>;

export const DefinitionIssueSchema = z.object({
  severity: z.enum(['error', 'warning']),
  /** Stable code (`unreachable_stage`, `failure_no_path_to_terminal`, `role_cannot_claim_stage`, ...). */
  code: z.string(),
  message: z.string(),
  stageId: z.string().optional(),
  outcomeId: z.string().optional(),
  field: z.string().optional(),
  /** Rule number of docs/ARCHITECTURE.md section 6.6 (workflows; 0 otherwise). */
  rule: z.number().int().optional(),
});
export type DefinitionIssue = z.infer<typeof DefinitionIssueSchema>;

/** `?projectId=`: act on the catalogue of the organization that owns the project (writes: its owner only). */
export const OrgContextQuerySchema = z.object({ projectId: z.uuid().optional() });

export const DraftResponseSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  version: z.number().int(),
  status: CatalogueStatus,
  issues: z.array(DefinitionIssueSchema),
});
export type DraftResponse = z.infer<typeof DraftResponseSchema>;

export const ValidateResponseSchema = z.object({
  id: z.uuid(),
  valid: z.boolean(),
  issues: z.array(DefinitionIssueSchema),
});
export type ValidateResponse = z.infer<typeof ValidateResponseSchema>;

export const SubmitResponseSchema = z.object({ id: z.uuid(), deskItemId: z.uuid(), status: CatalogueStatus });
export type SubmitResponse = z.infer<typeof SubmitResponseSchema>;

/** The owner's additions to a built-in role. Strict: core rules and everything else of the role cannot be sent. */
export const ExtendRoleRequestSchema = z.strictObject({
  instructions: z.string().max(20_000).default(''),
  skills: z.array(z.string().min(1)).default([]),
  standingOrders: z.array(z.string().min(1)).default([]),
});
export type ExtendRoleRequest = z.infer<typeof ExtendRoleRequestSchema>;
export const RoleExtensionResponseSchema = z.object({
  roleKey: z.string(),
  baseVersion: z.number().int(),
});

export const DepartmentDtoSchema = z.object({
  id: z.uuid().nullable(),
  name: z.string(),
  /** Shipped with the app (delivery, research, feeds, operations): cannot be removed. */
  builtIn: z.boolean(),
  roleKeys: z.array(z.string()),
  workflowKeys: z.array(z.string()),
});
export type DepartmentDto = z.infer<typeof DepartmentDtoSchema>;
export const DepartmentsResponseSchema = z.object({ departments: z.array(DepartmentDtoSchema) });
export const CreateDepartmentRequestSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-z][a-z0-9 _-]*$/i, 'letters, digits, spaces, - and _'),
});
export type CreateDepartmentRequest = z.infer<typeof CreateDepartmentRequestSchema>;

export const RoleVersionDtoSchema = z.object({
  id: z.uuid(),
  version: z.number().int(),
  status: CatalogueStatus,
  deskItemId: z.uuid().nullable(),
  vaultPath: z.string().nullable(),
  draftedByAgent: z.boolean(),
  createdAt: IsoTime,
  definition: RoleDefinitionSchema,
});
export type RoleVersionDto = z.infer<typeof RoleVersionDtoSchema>;
export const WorkflowVersionDtoSchema = z.object({
  id: z.uuid(),
  version: z.number().int(),
  status: CatalogueStatus,
  deskItemId: z.uuid().nullable(),
  vaultPath: z.string().nullable(),
  draftedByAgent: z.boolean(),
  createdAt: IsoTime,
  definition: WorkflowDefinitionSchema,
  /** Cards still running on exactly this version. */
  cardsInFlight: z.number().int(),
});
export type WorkflowVersionDto = z.infer<typeof WorkflowVersionDtoSchema>;

/** Everything the Organization page shows. Versions are newest first; drafts and pending ones are the owner's. */
export const OrgCatalogueResponseSchema = z.object({
  orgId: z.uuid(),
  /** Only the organization's owner can change the catalogue. */
  canEdit: z.boolean(),
  roles: z.array(
    z.object({
      key: z.string(),
      builtIn: z.boolean(),
      versions: z.array(RoleVersionDtoSchema),
      extensions: z
        .object({
          baseVersion: z.number().int(),
          instructions: z.string(),
          skills: z.array(z.string()),
          standingOrders: z.array(z.string()),
        })
        .nullable(),
    }),
  ),
  workflows: z.array(
    z.object({ key: z.string(), builtIn: z.boolean(), versions: z.array(WorkflowVersionDtoSchema) }),
  ),
  departments: z.array(DepartmentDtoSchema),
});
export type OrgCatalogueResponse = z.infer<typeof OrgCatalogueResponseSchema>;

export const DESK_SUBKIND_DEFINITION = 'definition';

/** `PUT /api/workflows/:id` and `PUT /api/roles/:id` (edit a draft) reuse the draft inputs. */
export const WorkflowIdParamsSchema = z.object({ id: z.uuid() });
export const RoleExtensionParamsSchema = z.object({ key: z.string().min(1) });

/** BA rpc payloads (`aom org ...`): the same drafts, plus which one to validate or submit. */
export const OrgRpcRefSchema = z.object({ id: z.uuid().optional(), key: z.string().optional() });
