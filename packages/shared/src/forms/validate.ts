import { isRealIsoDay } from './definition.ts';
import { FORM_LIMITS, type FormDefinition, type FormField } from './schema.ts';

/** Metadata of a chosen file; the bytes never enter this module. */
export type FormFileAnswer = { name: string; size: number; type: string };
export type FormAnswerValue = string | number | string[] | FormFileAnswer | null | undefined;

export type FormFieldErrorCode =
  | 'required'
  | 'too_short'
  | 'too_long'
  | 'invalid_email'
  | 'invalid_phone'
  | 'not_a_number'
  | 'below_min'
  | 'above_max'
  | 'invalid_date'
  | 'date_before_min'
  | 'date_after_max'
  | 'invalid_option'
  | 'file_type'
  | 'file_too_large'
  | 'invalid_value';

export interface FormFieldError {
  code: FormFieldErrorCode;
  message: string;
}

const err = (code: FormFieldErrorCode, message: string): FormFieldError => ({ code, message });

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** `2026-01-01` -> `1 Jan 2026`, with a fixed English formatter so server and browser agree. */
export function formatFormDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** `10485760` -> `10 MB`, `12992000` -> `12.4 MB`, `300000` -> `293 KB`. */
export function formatFormBytes(n: number): string {
  if (n >= 1024 * 1024) {
    const mb = Math.round((n / (1024 * 1024)) * 10) / 10;
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** `.pdf` -> `PDF`, `image/png` -> `PNG`, `image/*` -> `image files`. */
export function formatAllowedType(t: string): string {
  if (t.startsWith('.')) return t.slice(1).toUpperCase();
  const [major, sub] = t.split('/') as [string, string];
  return sub === '*' ? `${major} files` : sub.toUpperCase();
}

const isEmpty = (v: FormAnswerValue): boolean => {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
};

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const NUMBER_RE = /^-?\d+(\.\d+)?$/;
const INVALID = err('invalid_value', 'This answer is not valid.');

function rangeMessage(min: number | undefined, max: number | undefined, kind: 'min' | 'max'): string {
  if (min !== undefined && max !== undefined) return `Enter a number between ${min} and ${max}.`;
  return kind === 'min' ? `Enter a number of at least ${min}.` : `Enter a number of at most ${max}.`;
}

function typeMatches(allowed: string, file: FormFileAnswer): boolean {
  if (allowed.startsWith('.')) {
    const dot = file.name.lastIndexOf('.');
    return dot >= 0 && file.name.slice(dot).toLowerCase() === allowed;
  }
  const type = (file.type ?? '').toLowerCase();
  if (allowed.endsWith('/*')) return type.startsWith(allowed.slice(0, -1));
  return type === allowed;
}

/** One answer against one field. Null when valid. An empty optional field is valid. */
export function validateFieldAnswer(field: FormField, value: FormAnswerValue): FormFieldError | null {
  if (isEmpty(value)) return field.required ? err('required', 'This field is required.') : null;
  switch (field.type) {
    case 'short_text':
    case 'long_text': {
      if (typeof value !== 'string') return INVALID;
      const len = value.trim().length;
      const cap = field.type === 'short_text' ? FORM_LIMITS.shortText : FORM_LIMITS.longText;
      const max = Math.min(field.maxLength ?? cap, cap);
      if (field.minLength !== undefined && len < field.minLength)
        return err('too_short', `Enter at least ${field.minLength} characters.`);
      if (len > max) return err('too_long', `Enter at most ${max} characters.`);
      return null;
    }
    case 'email': {
      if (typeof value !== 'string') return INVALID;
      const v = value.trim();
      return v.length <= 254 && EMAIL_RE.test(v)
        ? null
        : err('invalid_email', 'Enter a valid email address, such as name@example.com.');
    }
    case 'phone': {
      if (typeof value !== 'string') return INVALID;
      const digits = value.trim().replace(/[\s\-.()]/g, '');
      return /^\+?\d{7,15}$/.test(digits)
        ? null
        : err('invalid_phone', 'Enter a valid phone number, such as +27 82 123 4567.');
    }
    case 'number': {
      if (typeof value !== 'number' && typeof value !== 'string') return INVALID;
      const s = typeof value === 'number' ? String(value) : value.trim();
      const n = typeof value === 'number' ? value : Number(s);
      if (!Number.isFinite(n) || (typeof value === 'string' && !NUMBER_RE.test(s)))
        return err('not_a_number', 'Enter a number.');
      if (field.min !== undefined && n < field.min)
        return err('below_min', rangeMessage(field.min, field.max, 'min'));
      if (field.max !== undefined && n > field.max)
        return err('above_max', rangeMessage(field.min, field.max, 'max'));
      return null;
    }
    case 'date': {
      if (typeof value !== 'string') return INVALID;
      const v = value.trim();
      if (!isRealIsoDay(v)) return err('invalid_date', 'Enter a valid date.');
      if (field.min && v < field.min)
        return err('date_before_min', `Pick a date on or after ${formatFormDate(field.min)}.`);
      if (field.max && v > field.max)
        return err('date_after_max', `Pick a date on or before ${formatFormDate(field.max)}.`);
      return null;
    }
    case 'dropdown':
    case 'radio':
      if (typeof value !== 'string') return INVALID;
      return field.options.includes(value) ? null : err('invalid_option', 'Choose one of the options.');
    case 'checkbox': {
      if (!Array.isArray(value) || value.some((x) => typeof x !== 'string')) return INVALID;
      if (new Set(value).size !== value.length || value.some((x) => !field.options.includes(x)))
        return err('invalid_option', 'Choose one of the options.');
      return null;
    }
    case 'file': {
      if (typeof value !== 'object' || Array.isArray(value)) return INVALID;
      const f = value as FormFileAnswer;
      if (typeof f.name !== 'string' || typeof f.size !== 'number' || !Number.isFinite(f.size))
        return INVALID;
      if (!field.allowedTypes.some((t) => typeMatches(t, f)))
        return err(
          'file_type',
          `This file type is not allowed. Allowed: ${field.allowedTypes.map(formatAllowedType).join(', ')}.`,
        );
      if (f.size > field.maxSizeBytes)
        return err(
          'file_too_large',
          `The file is too large (${formatFormBytes(f.size)}). The limit is ${formatFormBytes(field.maxSizeBytes)}.`,
        );
      return null;
    }
  }
}

export interface FormAnswersResult {
  ok: boolean;
  /** By field id. */
  errors: Record<string, FormFieldError>;
  /** Answer keys that are not fields of the form (listed in strict mode only). */
  unknown: string[];
}

/** All answers against a definition. `strict` also rejects answer keys that are not fields. */
export function validateFormAnswers(
  def: FormDefinition,
  answers: Record<string, FormAnswerValue>,
  opts: { strict?: boolean } = {},
): FormAnswersResult {
  const errors: Record<string, FormFieldError> = {};
  for (const f of def.fields) {
    const e = validateFieldAnswer(f, answers[f.id]);
    if (e) errors[f.id] = e;
  }
  const ids = new Set(def.fields.map((f) => f.id));
  const unknown = opts.strict ? Object.keys(answers).filter((k) => !ids.has(k)) : [];
  return { ok: Object.keys(errors).length === 0 && unknown.length === 0, errors, unknown };
}
