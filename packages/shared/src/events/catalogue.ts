import { z } from 'zod';
import { RoleDefinitionSchema, RoleExtensionsSchema } from '../roles/schema.ts';
import { WorkflowDefinitionSchema } from '../workflows/schema.ts';
import { defineEvent, Id } from './define.ts';

export const CatalogueStatus = z.enum(['draft', 'pending_approval', 'active', 'superseded', 'rejected']);
export type CatalogueStatus = z.infer<typeof CatalogueStatus>;

export const catalogueEvents = [
  defineEvent(
    'WorkflowVersionRegistered',
    z.object({
      workflowVersionId: Id,
      orgId: Id.nullable(),
      key: z.string(),
      version: z.number().int().min(1),
      name: z.string(),
      department: z.string().optional(),
      definition: WorkflowDefinitionSchema,
      status: CatalogueStatus,
    }),
  ),
  defineEvent('WorkflowVersionApproved', z.object({ workflowVersionId: Id })),
  defineEvent('WorkflowVersionRejected', z.object({ workflowVersionId: Id })),
  defineEvent(
    'RoleVersionRegistered',
    z.object({
      roleVersionId: Id,
      orgId: Id.nullable(),
      key: z.string(),
      version: z.number().int().min(1),
      definition: RoleDefinitionSchema,
      status: CatalogueStatus,
    }),
  ),
  defineEvent('RoleVersionApproved', z.object({ roleVersionId: Id })),
  defineEvent('RoleVersionRejected', z.object({ roleVersionId: Id })),
  defineEvent(
    'RoleExtended',
    z.object({
      orgId: Id,
      roleKey: z.string(),
      baseVersion: z.number().int().min(1),
      extensions: RoleExtensionsSchema,
    }),
  ),
  defineEvent(
    'RoleResetToDefault',
    z.object({
      orgId: Id,
      roleKey: z.string(),
      toVersion: z.number().int().min(1),
      droppedExtensions: RoleExtensionsSchema,
    }),
  ),
  defineEvent('DepartmentCreated', z.object({ departmentId: Id, orgId: Id, name: z.string().min(1) })),
] as const;
