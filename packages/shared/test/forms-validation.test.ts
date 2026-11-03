import { describe, expect, it } from 'vitest';
import {
  type FormDefinition,
  type FormField,
  newFormDefinition,
  newFormField,
  validateFieldAnswer,
  validateFormAnswers,
} from '../src/index.ts';

const f = (type: Parameters<typeof newFormField>[0], extra: Record<string, unknown> = {}) =>
  ({ ...newFormField(type, 'f_test0001'), ...extra }) as FormField;

describe('validateFieldAnswer', () => {
  it('required and empty', () => {
    for (const v of [undefined, null, '', '   ', []]) {
      expect(validateFieldAnswer(f('short_text', { required: true }), v)?.code).toBe('required');
    }
    expect(validateFieldAnswer(f('short_text'), '')).toBeNull();
    expect(validateFieldAnswer(f('email'), '')).toBeNull();
  });

  it('text length', () => {
    const field = f('short_text', { minLength: 3, maxLength: 5 });
    expect(validateFieldAnswer(field, 'ab')?.code).toBe('too_short');
    expect(validateFieldAnswer(field, 'abcdef')?.message).toBe('Enter at most 5 characters.');
    expect(validateFieldAnswer(field, 'abcd')).toBeNull();
    expect(validateFieldAnswer(f('short_text'), 'x'.repeat(1001))?.code).toBe('too_long');
    expect(validateFieldAnswer(f('long_text'), 'x'.repeat(1001))).toBeNull();
  });

  it('email', () => {
    expect(validateFieldAnswer(f('email'), 'a@b.co')).toBeNull();
    for (const bad of ['a', 'a@b', 'a b@c.com', '@c.com', 'a@.com']) {
      expect(validateFieldAnswer(f('email'), bad)?.code).toBe('invalid_email');
    }
  });

  it('phone', () => {
    expect(validateFieldAnswer(f('phone'), '+27 82 123 4567')).toBeNull();
    expect(validateFieldAnswer(f('phone'), '(021) 555-1234')).toBeNull();
    expect(validateFieldAnswer(f('phone'), '12345')?.code).toBe('invalid_phone');
    expect(validateFieldAnswer(f('phone'), 'abc1234567')?.code).toBe('invalid_phone');
  });

  it('number and range', () => {
    const both = f('number', { min: 1, max: 10 });
    expect(validateFieldAnswer(both, '5')).toBeNull();
    expect(validateFieldAnswer(both, 5.5)).toBeNull();
    expect(validateFieldAnswer(both, '0')?.message).toBe('Enter a number between 1 and 10.');
    expect(validateFieldAnswer(both, '11')?.code).toBe('above_max');
    expect(validateFieldAnswer(both, 'abc')?.code).toBe('not_a_number');
    expect(validateFieldAnswer(both, '1,5')?.code).toBe('not_a_number');
    expect(validateFieldAnswer(f('number', { min: 3 }), '2')?.message).toBe('Enter a number of at least 3.');
    expect(validateFieldAnswer(f('number', { max: 3 }), '4')?.message).toBe('Enter a number of at most 3.');
  });

  it('date and range', () => {
    const d = f('date', { min: '2026-01-01', max: '2026-12-31' });
    expect(validateFieldAnswer(d, '2026-06-15')).toBeNull();
    expect(validateFieldAnswer(d, '2025-12-31')?.message).toBe('Pick a date on or after 1 Jan 2026.');
    expect(validateFieldAnswer(d, '2027-01-01')?.message).toBe('Pick a date on or before 31 Dec 2026.');
    expect(validateFieldAnswer(d, '2026-02-30')?.code).toBe('invalid_date');
    expect(validateFieldAnswer(d, 'tomorrow')?.code).toBe('invalid_date');
  });

  it('dropdown, radio and checkbox', () => {
    expect(validateFieldAnswer(f('dropdown'), 'Option 1')).toBeNull();
    expect(validateFieldAnswer(f('radio'), 'Nope')?.code).toBe('invalid_option');
    expect(validateFieldAnswer(f('checkbox'), ['Option 1', 'Option 2'])).toBeNull();
    expect(validateFieldAnswer(f('checkbox'), ['Option 1', 'Option 1'])?.code).toBe('invalid_option');
    expect(validateFieldAnswer(f('checkbox'), ['Other'])?.code).toBe('invalid_option');
    expect(validateFieldAnswer(f('checkbox', { required: true }), [])?.code).toBe('required');
    expect(validateFieldAnswer(f('radio'), 5)?.code).toBe('invalid_value');
  });

  it('file type and size', () => {
    const file = f('file', { allowedTypes: ['.pdf', 'image/*'], maxSizeBytes: 10 * 1024 * 1024 });
    expect(validateFieldAnswer(file, { name: 'a.PDF', size: 100, type: '' })).toBeNull();
    expect(validateFieldAnswer(file, { name: 'a.bin', size: 100, type: 'image/png' })).toBeNull();
    const bad = validateFieldAnswer(file, { name: 'x.exe', size: 100, type: 'application/x-msdownload' });
    expect(bad?.code).toBe('file_type');
    expect(bad?.message).toBe('This file type is not allowed. Allowed: PDF, image files.');
    const big = validateFieldAnswer(file, { name: 'a.pdf', size: 13 * 1024 * 1024, type: '' });
    expect(big?.message).toBe('The file is too large (13 MB). The limit is 10 MB.');
    expect(validateFieldAnswer(file, 'a.pdf')?.code).toBe('invalid_value');
    expect(validateFieldAnswer(f('file', { required: true }), null)?.code).toBe('required');
  });
});

describe('validateFormAnswers', () => {
  const def: FormDefinition = {
    ...newFormDefinition('Rental'),
    fields: [f('email', { id: 'f_email001', required: true }), f('short_text', { id: 'f_name0001' })],
  };

  it('collects an error per field', () => {
    const r = validateFormAnswers(def, { f_email001: 'nope' });
    expect(r.ok).toBe(false);
    expect(Object.keys(r.errors)).toEqual(['f_email001']);
  });

  it('strict mode lists unknown keys', () => {
    const answers = { f_email001: 'a@b.co', extra: 'x' };
    expect(validateFormAnswers(def, answers).ok).toBe(true);
    const r = validateFormAnswers(def, answers, { strict: true });
    expect(r.ok).toBe(false);
    expect(r.unknown).toEqual(['extra']);
  });
});
