import { z } from 'zod';
import { FormDefinitionSchema } from '../forms/schema.ts';
import { StorageReferenceSchema } from '../storage/index.ts';
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
  // Public hosting (publish keeps one public id; "Publish changes" is the same id with a newer version).
  defineEvent(
    'FormPublished',
    z.object({
      formId: Id,
      orgId: Id,
      publicId: z.string().length(22),
      version: z.number().int().min(1),
      by: Id,
    }),
  ),
  defineEvent('FormUnpublished', z.object({ formId: Id, orgId: Id, by: Id })),
  defineEvent(
    'FormPublicLinkReset',
    z.object({ formId: Id, orgId: Id, publicId: z.string().length(22), by: Id }),
  ),
  defineEvent(
    'FormClientLinkCreated',
    z.object({
      linkId: z.string().length(22),
      formId: Id,
      orgId: Id,
      reference: z.string().min(1).max(120),
      recordKind: z.string().max(60).optional(),
      recordId: z.string().max(120).optional(),
      expiresAt: z.iso.datetime(),
      by: Id,
    }),
  ),
  defineEvent(
    'FormClientLinkRevoked',
    z.object({ linkId: z.string().length(22), formId: Id, orgId: Id, by: Id }),
  ),
  defineEvent(
    'FormClientLinkUsed',
    z.object({ linkId: z.string().length(22), formId: Id, orgId: Id, submissionId: Id }),
  ),
  // References only: no answer, no file content, no file name beyond the storage path.
  defineEvent(
    'FormSubmitted',
    z.object({
      submissionId: Id,
      formId: Id,
      orgId: Id,
      version: z.number().int().min(1),
      linkId: z.string().length(22).optional(),
      answers: z.array(StorageReferenceSchema),
      files: z.array(StorageReferenceSchema),
    }),
  ),
] as const;
