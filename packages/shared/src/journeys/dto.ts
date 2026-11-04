import { z } from 'zod';
import { JourneyRecordInputSchema, JourneyReferenceInputSchema } from './record.ts';
import { JourneyDefinitionSchema } from './schema.ts';

export const JOURNEY_INSTANCE_STATUSES = ['running', 'waiting', 'stuck', 'completed', 'cancelled'] as const;
export const JourneyInstanceStatusSchema = z.enum(JOURNEY_INSTANCE_STATUSES);
export type JourneyInstanceStatus = z.infer<typeof JourneyInstanceStatusSchema>;

export const JOURNEY_RUN_STATUSES = [
  'pending',
  'open',
  'waiting',
  'done',
  'cancelled',
  'skipped',
  'refused',
] as const;
export const JourneyRunStatusSchema = z.enum(JOURNEY_RUN_STATUSES);
export type JourneyRunStatus = z.infer<typeof JourneyRunStatusSchema>;

export const CreateJourneyBodySchema = z
  .object({
    projectId: z.uuid(),
    definition: JourneyDefinitionSchema.optional(),
    templateId: z.string().optional(),
  })
  .strict()
  .refine((b) => !!b.definition !== !!b.templateId, 'send a definition or a templateId');
export type CreateJourneyBody = z.infer<typeof CreateJourneyBodySchema>;

export const SaveJourneyBodySchema = z
  .object({ definition: JourneyDefinitionSchema, baseVersion: z.number().int().min(1) })
  .strict();

export const StartInstanceBodySchema = z
  .object({
    journeyId: z.uuid(),
    record: z.union([z.object({ recordId: z.uuid() }).strict(), JourneyRecordInputSchema]),
  })
  .strict();
export type StartInstanceBody = z.infer<typeof StartInstanceBodySchema>;

export const ContinueBodySchema = z.object({ visit: z.number().int().min(1) }).strict();
export const PlaybookBodySchema = z
  .object({ visit: z.number().int().min(1), workstationId: z.uuid().optional() })
  .strict();
export const AddReferenceBodySchema = JourneyReferenceInputSchema;

export const InstanceFiltersSchema = z.object({
  projectId: z.uuid().optional(),
  journeyId: z.uuid().optional(),
  status: JourneyInstanceStatusSchema.optional(),
  stepId: z.string().optional(),
});
