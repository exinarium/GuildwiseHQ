import { z } from 'zod';
import { JourneyRecordTypeSchema } from './schema.ts';

/**
 * The shared record holds status, step, timestamps and references only: never document content or form answers
 * (owner decision 5). Every schema here is strict so unknown keys are refused.
 */
export const JourneyRecordStatusSchema = z.enum(['active', 'closed']);
export const JourneyReferenceKindSchema = z.enum(['document', 'form_submission', 'card', 'playbook_session']);
export type JourneyReferenceKind = z.infer<typeof JourneyReferenceKindSchema>;

const Iso = z.iso.datetime();

export const JourneyReferenceInputSchema = z
  .object({
    kind: JourneyReferenceKindSchema,
    /** An id or a URI into the firm's own storage (`onedrive:...`, `s3://...`, `runner://...`); never content. */
    ref: z
      .string()
      .min(1)
      .max(500)
      .regex(/^\S+$/, 'a reference has no whitespace')
      .refine((r) => !/^data:/i.test(r), 'inline data is not a reference'),
    /** A file or form name, never its content. */
    label: z.string().max(200).optional(),
  })
  .strict();
export type JourneyReferenceInput = z.infer<typeof JourneyReferenceInputSchema>;

export const JourneyReferenceSchema = z
  .object({
    kind: JourneyReferenceKindSchema,
    ref: z.string().min(1).max(500),
    label: z.string().max(200).nullable().optional(),
    addedAt: Iso,
  })
  .strict();

export const JourneyRecordInputSchema = z
  .object({
    type: JourneyRecordTypeSchema,
    displayName: z.string().min(1).max(200),
    /** The firm's own id for the client, matter or deal. */
    externalId: z.string().max(120).optional(),
  })
  .strict();
export type JourneyRecordInput = z.infer<typeof JourneyRecordInputSchema>;

export const JourneyRecordDtoSchema = z
  .object({
    id: z.uuid(),
    orgId: z.uuid(),
    projectId: z.uuid(),
    type: JourneyRecordTypeSchema,
    externalId: z.string().max(120).nullable(),
    displayName: z.string().min(1).max(200),
    status: JourneyRecordStatusSchema,
    currentInstanceId: z.uuid().nullable(),
    currentStepId: z.string().nullable(),
    createdAt: Iso,
    updatedAt: Iso,
    references: z.array(JourneyReferenceSchema),
  })
  .strict();
export type JourneyRecordDto = z.infer<typeof JourneyRecordDtoSchema>;

/** The allow-list the "no content" test checks against the table columns. */
export const RECORD_COLUMNS = [
  'id',
  'org_id',
  'project_id',
  'record_type',
  'external_id',
  'display_name',
  'status',
  'current_instance_id',
  'current_step_id',
  'created_at',
  'updated_at',
] as const;
export const RECORD_REF_COLUMNS = ['record_id', 'kind', 'ref', 'label', 'added_at'] as const;
