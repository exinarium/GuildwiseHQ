import { describe, expect, it } from 'vitest';
import {
  canonicalFormDefinition,
  DomainEventSchema,
  FORM_FIELD_TYPES,
  type FormDefinition,
  FormDefinitionSchema,
  formDefinitionJsonSchema,
  newFormDefinition,
  newFormField,
  streamId,
  templateProblem,
  validateFormDefinition,
} from '../src/index.ts';

const withFields = (...fields: ReturnType<typeof newFormField>[]): FormDefinition => ({
  ...newFormDefinition('Rental application'),
  fields,
});

describe('form definition', () => {
  it('a new field of every type is valid', () => {
    const fields = FORM_FIELD_TYPES.map((t, i) => newFormField(t, `f_field${i}x`));
    const r = validateFormDefinition(withFields(...fields));
    expect(r.ok).toBe(true);
  });

  it('refuses duplicate field ids and duplicate options', () => {
    const a = newFormField('email', 'f_same0001');
    const r = validateFormDefinition(withFields(a, { ...a, type: 'phone' } as typeof a));
    expect(r.ok).toBe(false);
    const d = { ...newFormField('radio', 'f_radio001'), options: ['Yes', 'yes'] };
    const r2 = validateFormDefinition(withFields(d as ReturnType<typeof newFormField>));
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.issues[0]?.fieldId).toBe('f_radio001');
  });

  it('refuses min above max and unreal dates', () => {
    const num = { ...newFormField('number', 'f_num00001'), min: 5, max: 1 };
    expect(validateFormDefinition(withFields(num as ReturnType<typeof newFormField>)).ok).toBe(false);
    const txt = { ...newFormField('short_text', 'f_txt00001'), minLength: 9, maxLength: 3 };
    expect(validateFormDefinition(withFields(txt as ReturnType<typeof newFormField>)).ok).toBe(false);
    const dt = { ...newFormField('date', 'f_date0001'), min: '2026-02-30' };
    const r = validateFormDefinition(withFields(dt as ReturnType<typeof newFormField>));
    expect(r.ok).toBe(false);
    const dt2 = { ...newFormField('date', 'f_date0002'), min: '2026-05-01', max: '2026-01-01' };
    expect(validateFormDefinition(withFields(dt2 as ReturnType<typeof newFormField>)).ok).toBe(false);
  });

  it('enforces schema limits', () => {
    expect(validateFormDefinition({ ...newFormDefinition(''), fields: [] }).ok).toBe(false);
    const many = Array.from({ length: 101 }, (_, i) =>
      newFormField('email', `f_many${String(i).padStart(4, '0')}`),
    );
    expect(validateFormDefinition(withFields(...many)).ok).toBe(false);
    const file = { ...newFormField('file', 'f_file0001'), maxSizeBytes: 26 * 1024 * 1024 };
    expect(validateFormDefinition(withFields(file as ReturnType<typeof newFormField>)).ok).toBe(false);
    expect(validateFormDefinition('nope').ok).toBe(false);
  });

  it('checks destination templates', () => {
    expect(templateProblem('Forms/{form}/{submission}', 'folder')).toBeNull();
    expect(templateProblem('{{literal}}', 'name')).toBeNull();
    expect(templateProblem('{bogus}', 'name')).toMatch(/not a known key/);
    expect(templateProblem('a/{form', 'folder')).toMatch(/closing/);
    expect(templateProblem('../x', 'folder')).toMatch(/\.\./);
    expect(templateProblem('/abs', 'folder')).toMatch(/slash/);
    expect(templateProblem('a/b', 'name')).toMatch(/slash/);
    const file = newFormField('file', 'f_file0002');
    if (file.type !== 'file') throw new Error('x');
    file.destination.folder = '../escape';
    const r = validateFormDefinition(withFields(file));
    expect(r.ok).toBe(false);
  });

  it('canonical JSON is stable across key order', () => {
    const a = withFields(newFormField('email', 'f_mail0001'));
    const reordered = JSON.parse(JSON.stringify(a));
    const f0 = reordered.fields[0];
    reordered.fields[0] = Object.fromEntries(Object.entries(f0).reverse());
    reordered.settings = Object.fromEntries(Object.entries(reordered.settings).reverse());
    expect(canonicalFormDefinition(FormDefinitionSchema.parse(reordered))).toBe(canonicalFormDefinition(a));
  });

  it('exports a JSON Schema object', () => {
    const s = formDefinitionJsonSchema();
    expect(s.type).toBe('object');
  });

  it('FormVersionSaved is a registered event and the stream id is form-<id>', () => {
    const id = '8f1d2c3a-0000-4000-8000-000000000001';
    expect(streamId.form(id)).toBe(`form-${id}`);
    const r = DomainEventSchema.safeParse({
      type: 'FormVersionSaved',
      payload: {
        formId: id,
        orgId: id,
        version: 1,
        definition: newFormDefinition('x'),
        definitionHash: 'a'.repeat(64),
        by: id,
      },
    });
    expect(r.success).toBe(true);
  });
});
