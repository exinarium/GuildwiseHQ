import type { FormField } from '@aom/shared';

/** A new field id: `f_` plus 8 base36 characters, not used by any field in `taken`. */
export function newFieldId(taken: readonly string[] = []): string {
  for (;;) {
    let s = '';
    while (s.length < 8) s += Math.floor(Math.random() * 36).toString(36);
    const id = `f_${s}`;
    if (!taken.includes(id)) return id;
  }
}

/** The fields with `field` inserted at position `at` (clamped to the ends; default: the end). */
export function insertField(fields: readonly FormField[], field: FormField, at?: number): FormField[] {
  const i = at === undefined ? fields.length : Math.max(0, Math.min(at, fields.length));
  const next = fields.slice();
  next.splice(i, 0, field);
  return next;
}

/** The fields after moving `id` to position `to` (0-based; the same semantics as the project rank list). */
export function moveField(fields: readonly FormField[], id: string, to: number): FormField[] {
  const from = fields.findIndex((f) => f.id === id);
  if (from < 0 || to < 0 || to >= fields.length || from === to) return fields as FormField[];
  const next = fields.slice();
  const [f] = next.splice(from, 1);
  next.splice(to, 0, f as FormField);
  return next;
}

/** A copy of the field placed right after it, with a new id and "(copy)" on the label. */
export function duplicateField(fields: readonly FormField[], id: string, newId: string): FormField[] {
  const i = fields.findIndex((f) => f.id === id);
  if (i < 0) return fields as FormField[];
  const src = fields[i] as FormField;
  const copy = {
    ...structuredClone(src),
    id: newId,
    label: `${src.label} (copy)`.slice(0, 200),
  } as FormField;
  return insertField(fields, copy, i + 1);
}

export function removeField(fields: readonly FormField[], id: string): FormField[] {
  return fields.filter((f) => f.id !== id);
}

/** Replaces one field (matched by id) with its edited version. */
export function updateField(fields: readonly FormField[], next: FormField): FormField[] {
  return fields.map((f) => (f.id === next.id ? next : f));
}

export const FIELD_DRAG_TYPE = 'application/x-form-field-type';

/** The file types offered as chips in the property panel. */
export const FILE_TYPE_GROUPS: ReadonlyArray<{ label: string; types: readonly string[] }> = [
  { label: 'PDF', types: ['.pdf'] },
  { label: 'Images (jpg, jpeg, png, heic)', types: ['.jpg', '.jpeg', '.png', '.heic'] },
  { label: 'Word (doc, docx)', types: ['.doc', '.docx'] },
  { label: 'Excel (xls, xlsx)', types: ['.xls', '.xlsx'] },
];

/** `pdf`, `.PDF`, `image/png` -> a normalised allowed type, or null when it cannot be one. */
export function normaliseFileType(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (/^[a-z]+\/([a-z0-9.+-]+|\*)$/.test(s)) return s;
  const ext = s.startsWith('.') ? s.slice(1) : s;
  return /^[a-z0-9]{1,10}$/.test(ext) ? `.${ext}` : null;
}
