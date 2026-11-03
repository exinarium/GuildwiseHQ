import { z } from 'zod';
import {
  FIELD_TYPE_META,
  FORM_SCHEMA_VERSION,
  FORM_TEMPLATE_KEYS,
  type FormDefinition,
  FormDefinitionSchema,
  type FormDestination,
  type FormField,
  type FormFieldType,
} from './schema.ts';

export interface FormDefinitionIssue {
  /** Dotted path into the definition, e.g. `fields.2.options`. */
  path: string;
  fieldId?: string;
  message: string;
}

export type FormDefinitionCheck =
  | { ok: true; definition: FormDefinition }
  | { ok: false; issues: FormDefinitionIssue[] };

/** True for a real calendar day written `YYYY-MM-DD`. */
export function isRealIsoDay(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const dim = [
    31,
    y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return d <= (dim[mo - 1] as number);
}

/** Problem with a folder or file-name template, or null when it is fine. */
export function templateProblem(template: string, kind: 'folder' | 'name'): string | null {
  const keys = new Set<string>(FORM_TEMPLATE_KEYS);
  let i = 0;
  while (i < template.length) {
    const c = template[i];
    if (c === '{') {
      if (template[i + 1] === '{') {
        i += 2;
        continue;
      }
      const end = template.indexOf('}', i);
      if (end < 0) return 'A { has no closing }.';
      const key = template.slice(i + 1, end);
      if (!keys.has(key))
        return `{${key}} is not a known key. Use ${FORM_TEMPLATE_KEYS.map((k) => `{${k}}`).join(', ')}.`;
      i = end + 1;
    } else if (c === '}') {
      if (template[i + 1] === '}') {
        i += 2;
        continue;
      }
      return 'A } has no opening {.';
    } else i++;
  }
  if (kind === 'folder') {
    if (template.startsWith('/') || template.startsWith('\\')) return 'The folder cannot start with a slash.';
    if (template.split(/[\\/]/).some((seg) => seg === '..')) return 'The folder cannot contain "..".';
  } else if (/[\\/]/.test(template)) return 'The file name cannot contain a slash.';
  return null;
}

function checkDestination(
  d: FormDestination,
  base: string,
  fieldId: string | undefined,
  out: FormDefinitionIssue[],
) {
  const add = (sub: string, message: string) =>
    out.push({ path: `${base}.${sub}`, ...(fieldId ? { fieldId } : {}), message });
  const f = templateProblem(d.folder, 'folder');
  if (f) add('folder', f);
  const n = templateProblem(d.name, 'name');
  if (n) add('name', n);
}

/** Zod parse, then the rules a schema cannot say. */
export function validateFormDefinition(input: unknown): FormDefinitionCheck {
  const parsed = FormDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    const raw = input as { fields?: Array<{ id?: unknown }> } | null;
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => {
        const path = i.path.join('.');
        const idx = i.path[0] === 'fields' && typeof i.path[1] === 'number' ? i.path[1] : -1;
        const fid = idx >= 0 ? raw?.fields?.[idx]?.id : undefined;
        return { path, ...(typeof fid === 'string' ? { fieldId: fid } : {}), message: i.message };
      }),
    };
  }
  const def = parsed.data;
  const issues: FormDefinitionIssue[] = [];
  const seen = new Set<string>();
  def.fields.forEach((f, i) => {
    const base = `fields.${i}`;
    const add = (sub: string, message: string) =>
      issues.push({ path: `${base}.${sub}`, fieldId: f.id, message });
    if (seen.has(f.id)) add('id', 'Two fields share the same id.');
    seen.add(f.id);
    if (f.type === 'short_text' || f.type === 'long_text') {
      if (f.minLength !== undefined && f.maxLength !== undefined && f.minLength > f.maxLength)
        add('minLength', 'The minimum length is larger than the maximum length.');
    } else if (f.type === 'number') {
      if (f.min !== undefined && f.max !== undefined && f.min > f.max)
        add('min', 'The minimum is larger than the maximum.');
    } else if (f.type === 'date') {
      if (f.min !== undefined && !isRealIsoDay(f.min)) add('min', 'The earliest date is not a real date.');
      if (f.max !== undefined && !isRealIsoDay(f.max)) add('max', 'The latest date is not a real date.');
      if (f.min && f.max && isRealIsoDay(f.min) && isRealIsoDay(f.max) && f.min > f.max)
        add('min', 'The earliest date is after the latest date.');
    } else if (f.type === 'dropdown' || f.type === 'radio' || f.type === 'checkbox') {
      const lower = new Set<string>();
      for (const o of f.options) {
        const k = o.toLowerCase();
        if (lower.has(k)) {
          add('options', `The option "${o}" appears more than once.`);
          break;
        }
        lower.add(k);
      }
    } else if (f.type === 'file') {
      checkDestination(f.destination, `${base}.destination`, f.id, issues);
    }
  });
  checkDestination(def.settings.answersDestination, 'settings.answersDestination', undefined, issues);
  if (issues.length) return { ok: false, issues };
  return { ok: true, definition: def };
}

/** Deterministic JSON of a parsed definition (the schema's key order), for the "unchanged" check. */
export function canonicalFormDefinition(def: FormDefinition): string {
  return JSON.stringify(FormDefinitionSchema.parse(def));
}

/** JSON Schema of the definition for external readers (webhooks). */
export function formDefinitionJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(FormDefinitionSchema, { io: 'input' }) as Record<string, unknown>;
}

export const DEFAULT_FILE_TYPES = ['.pdf', '.jpg', '.jpeg', '.png'] as const;

export function newFormField(type: FormFieldType, id: string, label?: string): FormField {
  const base = { id, label: label ?? FIELD_TYPE_META[type].label, required: false };
  switch (type) {
    case 'short_text':
    case 'long_text':
    case 'email':
    case 'phone':
    case 'number':
    case 'date':
      return { type, ...base } as FormField;
    case 'dropdown':
    case 'radio':
    case 'checkbox':
      return { type, ...base, options: ['Option 1', 'Option 2'] } as FormField;
    case 'file':
      return {
        type,
        ...base,
        allowedTypes: [...DEFAULT_FILE_TYPES],
        maxSizeBytes: 10 * 1024 * 1024,
        destination: { connectionId: null, folder: 'Forms/{form}/{submission}', name: '{field}-{original}' },
      };
  }
}

export function newFormDefinition(title: string): FormDefinition {
  return {
    schemaVersion: FORM_SCHEMA_VERSION,
    settings: {
      title,
      description: '',
      logo: null,
      answersDestination: { connectionId: null, folder: 'Forms/{form}', name: '{date}-{submission}' },
      confirmationText: 'Thank you. We have received your answers.',
    },
    fields: [],
  };
}
