import { z } from 'zod';
import { FormDefinitionSchema } from './schema.ts';

export const FormStatusSchema = z.enum(['active', 'archived']);
export type FormStatus = z.infer<typeof FormStatusSchema>;

export const FormSummaryDtoSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  latestVersion: z.number().int(),
  status: FormStatusSchema,
  fieldCount: z.number().int(),
  updatedAt: z.string(),
  updatedByName: z.string().nullable(),
});
export type FormSummaryDto = z.infer<typeof FormSummaryDtoSchema>;

export const FormVersionInfoSchema = z.object({
  version: z.number().int(),
  savedAt: z.string(),
  savedByName: z.string().nullable(),
});
export type FormVersionInfo = z.infer<typeof FormVersionInfoSchema>;

export const FormDtoSchema = z.object({
  id: z.uuid(),
  status: FormStatusSchema,
  latestVersion: z.number().int(),
  definition: FormDefinitionSchema,
  versions: z.array(FormVersionInfoSchema),
});
export type FormDto = z.infer<typeof FormDtoSchema>;

export const FormVersionDtoSchema = z.object({
  formId: z.uuid(),
  version: z.number().int(),
  definition: FormDefinitionSchema,
  savedAt: z.string(),
  savedByName: z.string().nullable(),
});
export type FormVersionDto = z.infer<typeof FormVersionDtoSchema>;

/** The definition is checked by `validateFormDefinition` in the command (422 with the issues), not here. */
export const CreateFormRequestSchema = z.object({ definition: z.unknown() });
export type CreateFormRequest = z.infer<typeof CreateFormRequestSchema>;
export const SaveFormRequestSchema = z.object({
  baseVersion: z.number().int().min(1),
  definition: z.unknown(),
});
export type SaveFormRequest = z.infer<typeof SaveFormRequestSchema>;

export const FormLogoDtoSchema = z.object({ imageId: z.uuid(), url: z.string() });
export type FormLogoDto = z.infer<typeof FormLogoDtoSchema>;
export const formLogoUrl = (imageId: string): string => `/api/forms/logos/${imageId}`;
