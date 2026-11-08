import { describe, expect, it } from 'vitest';
import { q } from './helpers/db.ts';
import { PDF, usePublicFormsWorld } from './helpers/public-forms.ts';
import { ok } from './helpers/world.ts';

const one = async (sql: string, params?: unknown[]) => (await q(sql, params))[0] as Record<string, any>;

const pf = usePublicFormsWorld({
  AOM_FORMS_IP_BURST: '100000',
  AOM_FORMS_IP_PER_MIN: '100000',
  AOM_FORMS_IP_SUBMIT_BURST: '1000',
  AOM_FORMS_IP_SUBMITS_PER_HOUR: '100000',
});

const SECRET = 'PDF-ANSWER-SENTINEL-Quirke-5521';
const answers = { full_name: SECRET };
const files = [{ field: 'id_copy', name: 'a.pdf', bytes: PDF }];

const pdfNotices = async () =>
  q(`SELECT title, body, data FROM desk_items WHERE subkind='form_pdf_missing' ORDER BY created_at`);

describe('the PDF copy of the answers', () => {
  it('only the html write asks for a PDF; the reference is kept and goes into FormSubmitted', async () => {
    pf.stub.pdf = 'ok';
    const { formId, publicId } = await pf.published(pf.definition('Pdf form'));
    const link = await ok<any>(
      pf.api('POST', `/api/forms/${formId}/client-links`, { reference: 'R-9' }),
      201,
    );
    const token = /#c=(.+)$/.exec(link.url)?.[1] as string;
    const from = pf.stub.derives().length;
    const s = await pf.submit(publicId, answers, files, token);
    expect(s.complete?.status).toBe(200);
    const seen = pf.stub.derives().slice(from);
    expect(seen.filter((d) => d.derive)).toEqual([{ ext: 'html', derive: { pdf: true } }]);
    const row = await one('SELECT answers_refs FROM form_submissions WHERE id=$1', [s.sid]);
    expect(row.answers_refs.pdf).toMatchObject({ contentType: 'application/pdf' });
    expect(row.answers_refs.pdf.path).toMatch(/\.pdf$/);
    expect(row.answers_refs.pdfError).toBeUndefined();
    const ev = await one(
      `SELECT payload FROM events WHERE type='FormSubmitted' AND payload->>'submissionId'=$1`,
      [s.sid],
    );
    expect(ev.payload.answers).toHaveLength(3);
    expect(ev.payload.answers[2].contentType).toBe('application/pdf');
    expect(await pdfNotices()).toEqual([]);
    // the desk list shows the copy
    const base = row.answers_refs.html.path.replace(/\.html$/, '');
    expect(row.answers_refs.pdf.path).toBe(`${base}.pdf`);
  });

  it.each(['none', 'pdf_unavailable', 'pdf_failed', 'pdf_timeout', 'pdf_write_failed'] as const)(
    'when the copy is missing (%s) the submission still completes and the desk gets one notice without answers',
    async (mode) => {
      pf.stub.pdf = mode;
      const { publicId } = await pf.published(pf.definition(`No pdf ${mode}`));
      const before = (await pdfNotices()).length;
      const s = await pf.submit(publicId, answers, files);
      expect(s.complete?.status).toBe(200);
      const written = pf.stub.files().map((f) => f.path);
      expect(written.some((p) => p.endsWith('.json'))).toBe(true);
      expect(written.some((p) => p.endsWith('.html'))).toBe(true);
      const row = await one('SELECT status, answers_refs FROM form_submissions WHERE id=$1', [s.sid]);
      expect(row.status).toBe('complete');
      expect(row.answers_refs.pdf).toBeUndefined();
      const notices = await pdfNotices();
      expect(notices).toHaveLength(before + 1);
      const n = notices.at(-1) as Record<string, any>;
      expect(JSON.stringify(n)).not.toContain(SECRET);
      expect(n.title).toContain(`No pdf ${mode}`);
      expect(n.data.reason).toBe(mode === 'none' ? 'pdf_unavailable' : mode);
      // a second complete call changes nothing: still one notice
      await pf.post(
        `/api/public/forms/${publicId}/submissions/${s.sid}/complete`,
        { answers },
        { 'x-upload-token': s.token },
      );
      expect(await pdfNotices()).toHaveLength(before + 1);
    },
  );

  it('a retry after a json failure still gives one notice and one FormSubmitted', async () => {
    pf.stub.pdf = 'pdf_failed';
    const { publicId } = await pf.published(pf.definition('Pdf retry'));
    const before = (await pdfNotices()).length;
    pf.stub.failWhen = (o) =>
      o.ext === 'json' ? { code: 'unavailable', message: 'gone', retryable: true } : null;
    const s = await pf.submit(publicId, answers, files);
    expect(s.complete?.status).not.toBe(200);
    expect(await pdfNotices()).toHaveLength(before);
    pf.stub.failWhen = () => null;
    const again = await pf.post(
      `/api/public/forms/${publicId}/submissions/${s.sid}/complete`,
      { answers },
      { 'x-upload-token': s.token },
    );
    expect(again.status).toBe(200);
    expect(await pdfNotices()).toHaveLength(before + 1);
  });
});
