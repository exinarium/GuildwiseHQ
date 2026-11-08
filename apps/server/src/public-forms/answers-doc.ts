import type { FormDefinition, FormField } from '@aom/shared';

/** One uploaded file as the answers file lists it (where it was stored, never what it contains). */
export interface AnswersDocFile {
  id: string;
  label: string;
  name: string;
  size: number;
  sha256: string;
  contentType: string;
  stored: { connectionId: string; path: string; providerId?: string | undefined };
}

export interface AnswersDocInput {
  submissionId: string;
  submittedAt: Date;
  form: { id: string; title: string; version: number };
  client: { reference: string; linkId: string } | null;
  fields: readonly FormField[];
  answers: Record<string, unknown>;
  files: readonly AnswersDocFile[];
}

const textOf = (v: unknown): string | number | string[] | null => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v.trim() === '' ? null : v;
  if (typeof v === 'number') return v;
  if (Array.isArray(v)) return v.length ? v.map(String) : null;
  return null;
};

/** The record of truth: `v: 1`, the answers by field id with their label and type, and the files with their references. */
export function buildAnswersJson(i: AnswersDocInput): string {
  const doc = {
    v: 1,
    submission: {
      id: i.submissionId,
      submittedAt: i.submittedAt.toISOString(),
      form: i.form,
    },
    client: i.client,
    answers: i.fields
      .filter((f) => f.type !== 'file')
      .map((f) => ({ id: f.id, label: f.label, type: f.type, value: textOf(i.answers[f.id]) })),
    files: i.files,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c] as string);

const bytes = (n: number): string =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/**
 * A readable copy of the same record: static HTML, every value escaped, no script, no external resource, and its own
 * policy (`default-src 'none'`). Uploaded files are listed, never embedded.
 */
export function buildAnswersHtml(i: AnswersDocInput): string {
  const rows = i.fields
    .filter((f) => f.type !== 'file')
    .map((f) => {
      const v = textOf(i.answers[f.id]);
      const shown = v === null ? '—' : Array.isArray(v) ? v.join(', ') : String(v);
      return `<tr><th scope="row">${escapeHtml(f.label)}</th><td>${escapeHtml(shown).replace(/\n/g, '<br>')}</td></tr>`;
    })
    .join('\n');
  const files = i.files.length
    ? `<h2>Files</h2>\n<table>\n${i.files
        .map(
          (f) =>
            `<tr><th scope="row">${escapeHtml(f.label)}</th><td>${escapeHtml(f.name)} (${bytes(f.size)})<br><small>${escapeHtml(f.stored.path)}</small></td></tr>`,
        )
        .join('\n')}\n</table>`
    : '';
  const client = i.client ? `<p>Client reference: ${escapeHtml(i.client.reference)}</p>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(i.form.title)}</title>
<style>body{font-family:system-ui,"Noto Sans","Liberation Sans",Arial,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem;color:#111}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #ddd;padding:.5rem;text-align:left;vertical-align:top;overflow-wrap:anywhere;word-break:break-word}th{width:35%}td,th,h1,p{unicode-bidi:plaintext}@page{size:A4;margin:16mm 14mm}@media print{body{max-width:none;margin:0;padding:0}tr{break-inside:auto}h1,h2{break-after:avoid}}</style>
</head>
<body>
<h1>${escapeHtml(i.form.title)}</h1>
<p>Submitted ${escapeHtml(i.submittedAt.toISOString())} (version ${i.form.version}, submission ${escapeHtml(i.submissionId.slice(0, 8))})</p>
${client}
<table>
${rows}
</table>
${files}
</body>
</html>
`;
}

export type { FormDefinition };
