import { type FormField, newFormField } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import {
  duplicateField,
  insertField,
  moveField,
  newFieldId,
  normaliseFileType,
  removeField,
  updateField,
} from '../lib/formBuilder.ts';

const mk = (id: string, label = id): FormField => ({ ...newFormField('short_text', id), label });
const ids = (fs: readonly FormField[]) => fs.map((f) => f.id);

describe('form builder list helpers', () => {
  const base = [mk('f_aaaaaaaa'), mk('f_bbbbbbbb'), mk('f_cccccccc')];

  it('inserts at a position, clamps, and appends by default', () => {
    expect(ids(insertField(base, mk('f_new00001'), 1))).toEqual([
      'f_aaaaaaaa',
      'f_new00001',
      'f_bbbbbbbb',
      'f_cccccccc',
    ]);
    expect(ids(insertField(base, mk('f_new00001')))).toEqual([
      'f_aaaaaaaa',
      'f_bbbbbbbb',
      'f_cccccccc',
      'f_new00001',
    ]);
    expect(ids(insertField(base, mk('f_new00001'), -5))[0]).toBe('f_new00001');
    expect(ids(insertField(base, mk('f_new00001'), 99)).at(-1)).toBe('f_new00001');
    expect(base).toHaveLength(3);
  });

  it('moves a field like the project rank list does', () => {
    expect(ids(moveField(base, 'f_aaaaaaaa', 2))).toEqual(['f_bbbbbbbb', 'f_cccccccc', 'f_aaaaaaaa']);
    expect(ids(moveField(base, 'f_cccccccc', 0))).toEqual(['f_cccccccc', 'f_aaaaaaaa', 'f_bbbbbbbb']);
    expect(moveField(base, 'f_aaaaaaaa', 0)).toBe(base);
    expect(moveField(base, 'f_aaaaaaaa', 3)).toBe(base);
    expect(moveField(base, 'missing', 1)).toBe(base);
  });

  it('duplicates after the original with a new id and a copy label, without sharing options', () => {
    const radio = { ...newFormField('radio', 'f_radio001'), label: 'Pets' } as FormField;
    const out = duplicateField([radio, mk('f_zzzzzzzz')], 'f_radio001', 'f_radio002');
    expect(ids(out)).toEqual(['f_radio001', 'f_radio002', 'f_zzzzzzzz']);
    expect(out[1]?.label).toBe('Pets (copy)');
    if (out[1]?.type === 'radio' && out[0]?.type === 'radio') {
      out[1].options.push('x');
      expect(out[0].options).toHaveLength(2);
    }
  });

  it('removes and updates by id', () => {
    expect(ids(removeField(base, 'f_bbbbbbbb'))).toEqual(['f_aaaaaaaa', 'f_cccccccc']);
    expect(updateField(base, mk('f_bbbbbbbb', 'Changed'))[1]?.label).toBe('Changed');
  });

  it('makes unique valid ids', () => {
    const a = newFieldId();
    expect(a).toMatch(/^f_[a-z0-9]{8}$/);
    expect(newFieldId([a])).not.toBe(a);
  });

  it('normalises file types', () => {
    expect(normaliseFileType('PDF')).toBe('.pdf');
    expect(normaliseFileType('.Docx')).toBe('.docx');
    expect(normaliseFileType('image/*')).toBe('image/*');
    expect(normaliseFileType('not a type!')).toBeNull();
    expect(normaliseFileType('')).toBeNull();
  });
});
