import { describe, expect, it } from 'vitest';
import {
  CLIENT_LINK_TOKEN_RE,
  checkPublicAnswers,
  type FormDefinition,
  FormDefinitionSchema,
  newFormDefinition,
  newFormField,
  PUBLIC_FORM_ID_RE,
  publicFormView,
} from '../src/index.ts';

const CONN = '0b3e7c64-5d0a-4a52-9f43-1f0f6a1d2b11';
const def = (): FormDefinition => {
  const d = newFormDefinition('Rental application');
  d.settings.answersDestination.connectionId = CONN;
  const name = newFormField('short_text', 'full_name', 'Full name');
  name.required = true;
  const id = newFormField('file', 'id_copy', 'ID copy');
  if (id.type === 'file') {
    id.required = true;
    id.allowedTypes = ['image/png', '.pdf'];
    id.maxSizeBytes = 1000;
    id.destination.connectionId = CONN;
  }
  d.fields = [name, id, newFormField('email', 'email_addr', 'Email')];
  return d;
};
const file = (over: Record<string, unknown> = {}) => ({
  field: 'id_copy',
  index: 0,
  name: 'id.pdf',
  size: 500,
  sha256: 'a'.repeat(64),
  ...over,
});

describe('checkPublicAnswers', () => {
  it('accepts valid answers with a file of an accepted type', () => {
    expect(checkPublicAnswers(def(), { full_name: 'Ann', email_addr: 'a@b.co' }, [file()])).toEqual({
      ok: true,
    });
  });

  it('ignores the browser: only the extension we know decides, never a claimed content type', () => {
    // a .exe named like a PDF by the browser is still an .exe
    const r = checkPublicAnswers(def(), { full_name: 'Ann' }, [file({ name: 'setup.exe' })]);
    expect(r).toEqual({ ok: false, errors: [{ field: 'id_copy', code: 'file_type' }] });
  });

  it('applies a MIME rule against OUR type: image/png accepts a .png and refuses a .jpg', () => {
    const d = def();
    const f = d.fields[1];
    if (f?.type === 'file') f.allowedTypes = ['image/png'];
    expect(checkPublicAnswers(d, { full_name: 'Ann' }, [file({ name: 'x.png' })]).ok).toBe(true);
    expect(checkPublicAnswers(d, { full_name: 'Ann' }, [file({ name: 'x.jpg' })])).toEqual({
      ok: false,
      errors: [{ field: 'id_copy', code: 'file_type' }],
    });
  });

  it('reports size, missing required fields and unknown keys by field and code only', () => {
    const r = checkPublicAnswers(def(), { extra: 'x' }, [file({ size: 5000 })]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual(
      expect.arrayContaining([
        { field: 'id_copy', code: 'file_too_large' },
        { field: 'full_name', code: 'required' },
        { field: 'extra', code: 'unknown_field' },
      ]),
    );
    for (const e of r.errors) expect(Object.keys(e).sort()).toEqual(['code', 'field']);
  });

  it('a required file that is missing is required; a file for a text field is not expected', () => {
    expect(checkPublicAnswers(def(), { full_name: 'Ann' }, [])).toEqual({
      ok: false,
      errors: [{ field: 'id_copy', code: 'required' }],
    });
    const r = checkPublicAnswers(def(), { full_name: 'Ann' }, [file(), file({ field: 'full_name' })]);
    expect(r).toEqual({ ok: false, errors: [{ field: 'full_name', code: 'file_not_expected' }] });
  });

  it('a file answer smuggled in the text answers is ignored', () => {
    const r = checkPublicAnswers(
      def(),
      { full_name: 'Ann', id_copy: { name: 'a.pdf', size: 1, type: 'application/pdf' } },
      [],
    );
    expect(r).toEqual({ ok: false, errors: [{ field: 'id_copy', code: 'required' }] });
  });

  it('an unknown key is echoed only as a short, id-shaped string', () => {
    const r = checkPublicAnswers(def(), { full_name: 'Ann', '<script>alert(1)</script>': 'x' }, [file()]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.field).toMatch(/^[a-z0-9_]+$/i);
  });
});

describe('publicFormView', () => {
  it('hides every storage destination and the logo id, and still parses as a form', () => {
    const d = def();
    d.settings.logo = { imageId: '8f1c1c3a-1c7b-4b53-b0b0-0f7c1d2e3a4b', alt: 'Logo' };
    const v = publicFormView(d);
    const text = JSON.stringify(v);
    expect(text).not.toContain(CONN);
    expect(text).not.toContain('Forms/{form}');
    expect(text).not.toContain('8f1c1c3a');
    expect(v.settings.logo).toMatchObject({ alt: 'Logo' });
    expect(FormDefinitionSchema.safeParse(v).success).toBe(true);
    expect(v.fields.map((f) => f.label)).toEqual(['Full name', 'ID copy', 'Email']);
  });
});

describe('public id and link token formats', () => {
  it('match what the server makes', () => {
    expect(PUBLIC_FORM_ID_RE.test('A'.repeat(22))).toBe(true);
    expect(PUBLIC_FORM_ID_RE.test('A'.repeat(21))).toBe(false);
    expect(PUBLIC_FORM_ID_RE.test(`${'A'.repeat(21)}/`)).toBe(false);
    expect(CLIENT_LINK_TOKEN_RE.test(`v1.${'a'.repeat(22)}.1abcde.${'b'.repeat(43)}`)).toBe(true);
    expect(CLIENT_LINK_TOKEN_RE.test(`v2.${'a'.repeat(22)}.1abcde.${'b'.repeat(43)}`)).toBe(false);
  });
});
