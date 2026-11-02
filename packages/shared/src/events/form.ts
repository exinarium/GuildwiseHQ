import { z } from 'zod';
import { FormDefinitionSchema } from '../forms/schema.ts';
import { defineEvent, Id } from './define.ts';

/**
 * Forms (stream `form-<formId>`, org scope). Every save is a new immutable version; the logo bytes are never in an
 * event (the definition references `logo.imageId`). No form answers are stored by any of these.
 */
export const formEvents = [
  defineEvent(
    'FormVersionSaved',
    z.object({
      formId: Id,
      orgId: Id,
      version: z.number().int().min(1),
      definition: FormDefinitionSchema,
      definitionHash: z.string().length(64),
      by: Id,
    }),
  ),
  defineEvent('FormArchived', z.object({ formId: Id, orgId: Id, by: Id })),
  defineEvent('FormUnarchived', z.object({ formId: Id, orgId: Id, by: Id })),
] as const;
