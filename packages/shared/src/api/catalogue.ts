import { z } from 'zod';
import { CatalogueStatus } from '../events/catalogue.ts';
import { RoleDefinitionSchema, RoleExtensionsSchema } from '../roles/schema.ts';
import { WorkflowDefinitionSchema } from '../workflows/schema.ts';

export const RoleCatalogueEntrySchema = z.object({
  definition: RoleDefinitionSchema,
  orgId: z.uuid().nullable(),
  status: CatalogueStatus,
  /** Owner's additions to a built-in role (M9/M10). */
  extensions: RoleExtensionsSchema.nullable(),
});
export const RolesResponseSchema = z.object({ roles: z.array(RoleCatalogueEntrySchema) });

export const WorkflowCatalogueEntrySchema = z.object({
  id: z.uuid(),
  orgId: z.uuid().nullable(),
  status: CatalogueStatus,
  definition: WorkflowDefinitionSchema,
});
export const WorkflowsResponseSchema = z.object({ workflows: z.array(WorkflowCatalogueEntrySchema) });
