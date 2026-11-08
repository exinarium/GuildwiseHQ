import { newFormField } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { buildAnswersHtml, buildAnswersJson } from '../src/public-forms/answers-doc.ts';

const fields = [
  newFormField('short_text', 'full_name', 'Full name'),
  newFormField('long_text', 'notes', 'Notes <b>'),
  newFormField('checkbox', 'pets', 'Pets'),
  newFormField('file', 'id_copy', 'ID copy'),
];
const input = (answers: Record<string, unknown>) => ({
  submissionId: '0b3e7c64-5d0a-4a52-9f43-1f0f6a1d2b11',
  submittedAt: new Date('2026-11-04T09:12:44Z'),
  form: { id: 'f', title: 'Rental <application>', version: 3 },
  client: { reference: 'CL-1042', linkId: 'l'.repeat(22) },
  fields,
  answers,
  files: [
    {
      id: 'id_copy',
      label: 'ID copy',
      name: 'id.pdf',
      size: 182233,
      sha256: 'a'.repeat(64),
      contentType: 'application/pdf',
      stored: { connectionId: 'c', path: 'Forms/x/id.pdf', providerId: undefined },
    },
  ],
});

describe('answers file', () => {
  it('JSON has the documented shape: answers by field id with label and type, files with references', () => {
    const j = JSON.parse(buildAnswersJson(input({ full_name: 'Ann', notes: '', pets: ['cat', 'dog'] })));
    expect(j.v).toBe(1);
    expect(j.submission).toEqual({
      id: '0b3e7c64-5d0a-4a52-9f43-1f0f6a1d2b11',
      submittedAt: '2026-11-04T09:12:44.000Z',
      form: { id: 'f', title: 'Rental <application>', version: 3 },
    });
    expect(j.client).toEqual({ reference: 'CL-1042', linkId: 'l'.repeat(22) });
    expect(j.answers).toEqual([
      { id: 'full_name', label: 'Full name', type: 'short_text', value: 'Ann' },
      { id: 'notes', label: 'Notes <b>', type: 'long_text', value: null },
      { id: 'pets', label: 'Pets', type: 'checkbox', value: ['cat', 'dog'] },
    ]);
    expect(j.files[0]).toMatchObject({ id: 'id_copy', size: 182233, stored: { path: 'Forms/x/id.pdf' } });
  });

  it('client is null for the anonymous public address', () => {
    const j = JSON.parse(buildAnswersJson({ ...input({}), client: null }));
    expect(j.client).toBeNull();
  });

  it('HTML escapes every value, has no script and carries its own restrictive policy', () => {
    const html = buildAnswersHtml(
      input({
        full_name: '<script>alert("x")</script> & "q" \'s\'',
        notes: 'line1\nline2',
        pets: ['<img src=x onerror=1>'],
      }),
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &quot;q&quot; &#39;s&#39;',
    );
    expect(html).toContain('line1<br>line2');
    expect(html).toContain('Rental &lt;application&gt;');
    expect(html).toContain('Notes &lt;b&gt;');
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'`);
    // the upload is listed by name and place, never embedded
    expect(html).toContain('Forms/x/id.pdf');
    expect(html).not.toMatch(/<(iframe|object|embed|link|img)\b/i);
  });

  it('has print styling for the PDF copy: A4 page, wrapping long words, plain-text direction, no script', () => {
    const html = buildAnswersHtml(input({ full_name: 'x' }));
    expect(html).toContain('@page{size:A4');
    expect(html).toContain('overflow-wrap:anywhere');
    expect(html).toContain('unicode-bidi:plaintext');
    expect(html).toContain('@media print');
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/url\(|@import/i);
  });
});
