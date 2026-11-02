import { z } from 'zod';

/** The ten field types of a form, in palette order. */
export const FORM_FIELD_TYPES = [
  'short_text',
  'long_text',
  'email',
  'phone',
  'number',
  'date',
  'dropdown',
  'radio',
  'checkbox',
  'file',
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export const FORM_LIMITS = {
  fields: 100,
  options: 200,
  label: 200,
  placeholder: 200,
  helpText: 500,
  description: 4000,
  confirmation: 2000,
  shortText: 1000,
  longText: 20000,
  fileTypes: 30,
  /** Equals the storage connectors' per-file limit. */
  fileMaxBytes: 25 * 1024 * 1024,
  logoBytes: 512 * 1024,
} as const;

/** Keys a folder or file-name template may use, as `{key}`. `{{` and `}}` are literal braces. */
export const FORM_TEMPLATE_KEYS = [
  'journey',
  'client',
  'form',
  'field',
  'submission',
  'date',
  'time',
  'original',
  'ext',
] as const;

export const FORM_SCHEMA_VERSION = 1 as const;

const FieldId = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);
const Int0 = z.number().int().min(0);
const Int1 = z.number().int().min(1);
const Base = {
  id: FieldId,
  label: z.string().trim().min(1).max(FORM_LIMITS.label),
  required: z.boolean().default(false),
  helpText: z.string().max(FORM_LIMITS.helpText).optional(),
};
const Placeholder = { placeholder: z.string().max(FORM_LIMITS.placeholder).optional() };
const Options = { options: z.array(z.string().trim().min(1).max(FORM_LIMITS.label)).min(1).max(FORM_LIMITS.options) };
const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const FormDestinationSchema = z.object({
  /** null = not set (allowed until a storage connection is chosen). */
  connectionId: z.uuid().nullable(),
  /** Template, e.g. `Forms/{form}/{submission}`. */
  folder: z.string().max(400),
  /** Template, e.g. `{field}-{original}`. */
  name: z.string().max(200),
});
export type FormDestination = z.infer<typeof FormDestinationSchema>;

export const FormFieldSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('short_text'),
    ...Base,
    ...Placeholder,
    minLength: Int0.optional(),
    maxLength: Int1.max(FORM_LIMITS.shortText).optional(),
  }),
  z.object({
    type: z.literal('long_text'),
    ...Base,
    ...Placeholder,
    minLength: Int0.optional(),
    maxLength: Int1.max(FORM_LIMITS.longText).optional(),
  }),
  z.object({ type: z.literal('email'), ...Base, ...Placeholder }),
  z.object({ type: z.literal('phone'), ...Base, ...Placeholder }),
  z.object({
    type: z.literal('number'),
    ...Base,
    ...Placeholder,
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  }),
  z.object({ type: z.literal('date'), ...Base, min: IsoDay.optional(), max: IsoDay.optional() }),
  z.object({ type: z.literal('dropdown'), ...Base, ...Placeholder, ...Options }),
  z.object({ type: z.literal('radio'), ...Base, ...Options }),
  z.object({ type: z.literal('checkbox'), ...Base, ...Options }),
  z.object({
    type: z.literal('file'),
    ...Base,
    allowedTypes: z
      .array(z.string().regex(/^(\.[a-z0-9]{1,10}|[a-z]+\/([a-z0-9.+-]+|\*))$/))
      .min(1)
      .max(FORM_LIMITS.fileTypes),
    maxSizeBytes: z.number().int().min(1).max(FORM_LIMITS.fileMaxBytes),
    destination: FormDestinationSchema,
  }),
]);
export type FormField = z.infer<typeof FormFieldSchema>;
export type FormFieldOf<T extends FormFieldType> = Extract<FormField, { type: T }>;

export const FormSettingsSchema = z.object({
  title: z.string().trim().min(1).max(FORM_LIMITS.label),
  description: z.string().max(FORM_LIMITS.description).default(''),
  logo: z
    .object({ imageId: z.uuid(), alt: z.string().max(FORM_LIMITS.label).default('') })
    .nullable()
    .default(null),
  answersDestination: FormDestinationSchema,
  confirmationText: z.string().trim().min(1).max(FORM_LIMITS.confirmation),
});
export type FormSettings = z.infer<typeof FormSettingsSchema>;

export const FormDefinitionSchema = z.object({
  schemaVersion: z.literal(FORM_SCHEMA_VERSION),
  settings: FormSettingsSchema,
  fields: z.array(FormFieldSchema).max(FORM_LIMITS.fields),
});
export type FormDefinition = z.infer<typeof FormDefinitionSchema>;

export type FieldProperty =
  | 'label'
  | 'required'
  | 'placeholder'
  | 'helpText'
  | 'lengthRange'
  | 'numberRange'
  | 'dateRange'
  | 'options'
  | 'allowedTypes'
  | 'maxSizeBytes'
  | 'destination';

const COMMON: readonly FieldProperty[] = ['label', 'required', 'helpText'];

/** Drives the palette labels and which inputs the property panel shows. */
export const FIELD_TYPE_META: Record<FormFieldType, { label: string; properties: readonly FieldProperty[] }> = {
  short_text: { label: 'Short text', properties: [...COMMON, 'placeholder', 'lengthRange'] },
  long_text: { label: 'Long text', properties: [...COMMON, 'placeholder', 'lengthRange'] },
  email: { label: 'Email', properties: [...COMMON, 'placeholder'] },
  phone: { label: 'Phone', properties: [...COMMON, 'placeholder'] },
  number: { label: 'Number', properties: [...COMMON, 'placeholder', 'numberRange'] },
  date: { label: 'Date', properties: [...COMMON, 'dateRange'] },
  dropdown: { label: 'Dropdown', properties: [...COMMON, 'placeholder', 'options'] },
  radio: { label: 'Radio buttons', properties: [...COMMON, 'options'] },
  checkbox: { label: 'Checkboxes', properties: [...COMMON, 'options'] },
  file: { label: 'File upload', properties: [...COMMON, 'allowedTypes', 'maxSizeBytes', 'destination'] },
};
