import { z } from 'zod';
import { RoleDefinitionSchema, RoleExtensionsSchema } from '../roles/schema.ts';
import { WorkflowDefinitionSchema } from '../workflows/schema.ts';
import { defineEvent, Id } from './define.ts';

export const CatalogueStatus = z.enum(['draft', 'pending_approval', 'active', 'superseded', 'rejected']);
export type CatalogueStatus = z.infer<typeof CatalogueStatus>;

/** Who drafted a definition: the manager, or the BA in a design chat. */
export const DefinitionAuthor = z.object({ kind: z.enum(['user', 'agent']), id: Id });

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
      /** M10: custom drafts only. */
      draftedBy: DefinitionAuthor.optional(),
    }),
  ),
  defineEvent(
    'WorkflowDraftUpdated',
    z.object({
      workflowVersionId: Id,
      name: z.string(),
      department: z.string().optional(),
      definition: WorkflowDefinitionSchema,
    }),
  ),
  /** The draft passed validation and waits on the owner's desk (`deskItemId`). */
  defineEvent('WorkflowVersionSubmitted', z.object({ workflowVersionId: Id, deskItemId: Id })),
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
      /** M10: custom drafts only. */
      draftedBy: DefinitionAuthor.optional(),
    }),
  ),
  defineEvent('RoleDraftUpdated', z.object({ roleVersionId: Id, definition: RoleDefinitionSchema })),
  defineEvent('RoleVersionSubmitted', z.object({ roleVersionId: Id, deskItemId: Id })),
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
  /** A draft that was never approved is dropped (approved and superseded versions are never removed). */
  defineEvent('DefinitionDraftDiscarded', z.object({ kind: z.enum(['role', 'workflow']), versionId: Id })),
  defineEvent('DepartmentCreated', z.object({ departmentId: Id, orgId: Id, name: z.string().min(1) })),
] as const;
