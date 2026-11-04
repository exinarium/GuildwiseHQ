import { describe, expect, it } from 'vitest';
import {
  acceptedUploadExtensions,
  checkUploadHead,
  FORM_UPLOAD_TYPES,
  sanitiseUploadName,
} from '../src/index.ts';

const bytes = (...b: number[]) => new Uint8Array(b);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj');
const ZIP = bytes(0x50, 0x4b, 3, 4, 0, 0, 0, 0);
const MZ = bytes(0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0);
const heic = (brand: string) =>
  new Uint8Array([
    0,
    0,
    0,
    24,
    ...new TextEncoder().encode('ftyp'),
    ...new TextEncoder().encode(brand),
    0,
    0,
    0,
    0,
  ]);

describe('upload types', () => {
  it('has no SVG and no macro-enabled formats', () => {
    for (const bad of ['svg', 'docm', 'xlsm', 'pptm', 'exe', 'html'])
      expect(FORM_UPLOAD_TYPES[bad]).toBeUndefined();
  });

  it('expands MIME patterns and drops what is never accepted', () => {
    const image = acceptedUploadExtensions(['image/*']);
    expect(image).toEqual(expect.arrayContaining(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif']));
    expect(image).not.toContain('svg');
    expect(image).not.toContain('pdf');
    expect(acceptedUploadExtensions(['image/png'])).toEqual(['png']);
    expect(acceptedUploadExtensions(['.PDF', '.pdf'])).toEqual(['pdf']);
    expect(acceptedUploadExtensions(['.exe', '.docm', 'image/svg+xml', 'application/x-msdownload'])).toEqual(
      [],
    );
  });

  it('accepts a file whose first bytes match its extension', () => {
    const all = Object.keys(FORM_UPLOAD_TYPES);
    expect(checkUploadHead('png', PNG, all)).toEqual({ ok: true, contentType: 'image/png' });
    expect(checkUploadHead('pdf', PDF, all)).toMatchObject({ ok: true, contentType: 'application/pdf' });
    expect(checkUploadHead('docx', ZIP, all).ok).toBe(true);
    expect(checkUploadHead('odt', ZIP, all).ok).toBe(true);
    expect(checkUploadHead('heic', heic('heic'), all).ok).toBe(true);
    expect(checkUploadHead('heif', heic('mif1'), all).ok).toBe(true);
    expect(checkUploadHead('txt', new TextEncoder().encode('plain text'), all).ok).toBe(true);
    expect(checkUploadHead('csv', new TextEncoder().encode('a,b\n1,2'), all)).toMatchObject({
      ok: true,
      contentType: 'text/csv; charset=utf-8',
    });
  });

  it('refuses a renamed executable by content, whatever the name says', () => {
    const all = Object.keys(FORM_UPLOAD_TYPES);
    expect(checkUploadHead('pdf', MZ, all)).toEqual({ ok: false, code: 'executable' });
    expect(checkUploadHead('png', bytes(0x7f, 0x45, 0x4c, 0x46, 2, 1), all)).toEqual({
      ok: false,
      code: 'executable',
    });
    expect(checkUploadHead('txt', new TextEncoder().encode('#!/bin/sh\nrm -rf /'), all)).toEqual({
      ok: false,
      code: 'executable',
    });
  });

  it('refuses an executable extension even with harmless content', () => {
    expect(checkUploadHead('exe', PNG, ['exe', 'png'])).toEqual({ ok: false, code: 'executable' });
    expect(checkUploadHead('ps1', PNG, ['png'])).toEqual({ ok: false, code: 'executable' });
  });

  it('refuses content that is not what the extension says, a type the field does not accept, and empty files', () => {
    expect(checkUploadHead('pdf', PNG, ['pdf'])).toEqual({ ok: false, code: 'content_mismatch' });
    expect(checkUploadHead('png', PDF, ['png'])).toEqual({ ok: false, code: 'content_mismatch' });
    expect(checkUploadHead('heic', PNG, ['heic'])).toEqual({ ok: false, code: 'content_mismatch' });
    expect(checkUploadHead('txt', bytes(0x61, 0, 0x62), ['txt'])).toEqual({
      ok: false,
      code: 'content_mismatch',
    });
    expect(checkUploadHead('png', PNG, ['pdf'])).toEqual({ ok: false, code: 'type_not_allowed' });
    expect(checkUploadHead('svg', new TextEncoder().encode('<svg/>'), ['svg'])).toEqual({
      ok: false,
      code: 'type_not_allowed',
    });
    expect(checkUploadHead('png', bytes(), ['png'])).toEqual({ ok: false, code: 'empty' });
  });
});

describe('sanitiseUploadName', () => {
  it('drops directories and control characters and lower-cases the extension', () => {
    expect(sanitiseUploadName('../../etc/passwd.PDF')).toEqual({ base: 'passwd', ext: 'pdf' });
    expect(sanitiseUploadName('C:\\Users\\me\\ID copy.JPG')).toEqual({ base: 'ID copy', ext: 'jpg' });
    expect(sanitiseUploadName('a\u0000b<>.png')).toEqual({ base: 'a_b__', ext: 'png' });
    expect(sanitiseUploadName('noextension')).toEqual({ base: 'noextension', ext: '' });
    expect(sanitiseUploadName('.hidden')).toEqual({ base: 'hidden', ext: '' });
    expect(sanitiseUploadName('').base).toBe('attachment');
  });
});
