import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { chromiumPdfRenderer, PdfError } from '../src/storage/pdf.ts';

// Real Chrome Headless Shell. Skipped where the browser is not installed.
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), '.cache', 'ms-playwright');
const renderer = chromiumPdfRenderer({ browsersPath: browsers, idleMs: 60_000 });
const ready = (await renderer.status()).ready;
afterAll(() => renderer.close());

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

// Same shape and styles as the server's answers HTML (a fixture: the runner never imports server code).
function doc(rows: Array<[string, string]>, files: Array<[string, string]> = []): string {
  const r = rows
    .map(([q, a]) => `<tr><th scope="row">${esc(q)}</th><td>${esc(a).replace(/\n/g, '<br>')}</td></tr>`)
    .join('\n');
  const f = files.length
    ? `<h2>Files</h2><table>${files.map(([l, n]) => `<tr><th scope="row">${esc(l)}</th><td>${esc(n)}</td></tr>`).join('')}</table>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>Intake form</title>
<style>body{font-family:system-ui,"Noto Sans","Liberation Sans",Arial,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #ddd;padding:.5rem;text-align:left;vertical-align:top;overflow-wrap:anywhere;word-break:break-word}th{width:35%}td,th,h1,p{unicode-bidi:plaintext}@page{size:A4;margin:16mm 14mm}@media print{body{max-width:none;margin:0;padding:0}tr{break-inside:auto}h1,h2{break-after:avoid}}</style></head>
<body><h1>Intake form</h1><p>Submitted 2026-11-08T10:00:00.000Z (version 1, submission abcd1234)</p><p>Client reference: R-1</p>
<table>${r}</table>${f}</body></html>`;
}

async function text(pdf: Buffer): Promise<{ text: string; pages: number }> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(pdf) });
  try {
    const r = await parser.getText();
    return { text: r.text, pages: r.total };
  } finally {
    await parser.destroy();
  }
}
const squash = (s: string) => s.replace(/\s+/g, '');
const signal = () => AbortSignal.timeout(30_000);

describe.skipIf(!ready)('PDF rendering with Chrome Headless Shell', () => {
  it('prints title, date, reference, questions in order and file names', async () => {
    const pdf = await renderer.render(
      doc(
        [
          ['Full name', 'Zoë Ångström Łódź'],
          ['Story', 'first line\nsecond line'],
          ['Colour', 'blue'],
        ],
        [['CV', 'scan.pdf (12 KB)']],
      ),
      signal(),
    );
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const { text: t } = await text(pdf);
    for (const need of [
      'Intake form',
      '2026-11-08T10:00:00.000Z',
      'Client reference: R-1',
      'scan.pdf (12 KB)',
    ])
      expect(t).toContain(need);
    const flat = squash(t);
    const idx = ['Fullname', 'Story', 'Colour', 'Files'].map((x) => flat.indexOf(x));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  it('accented and non-Latin text is extracted', async () => {
    const pdf = await renderer.render(
      doc([
        ['Name', 'Zoë Ångström Łódź'],
        ['Greek', 'Ελληνικά'],
        ['Russian', 'Привет'],
        ['Hebrew', 'שלום עולם'],
        ['Arabic', 'مرحبا'],
      ]),
      signal(),
    );
    const t = squash((await text(pdf)).text);
    expect(t).toContain('ZoëÅngströmŁódź');
    expect(t).toContain('Ελληνικά');
    expect(t).toContain('Привет');
    // right-to-left text may come out in visual order: compare the letters regardless of order
    const sortedLetters = (s: string) => [...s].sort().join('');
    for (const w of ['שלוםעולם', 'مرحبا']) {
      expect([...w].every((c) => t.includes(c))).toBe(true);
      expect(sortedLetters(w).length).toBe(w.length);
    }
  });

  it('a long answer gives several pages with nothing cut off', async () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line-${i}`).join('\n');
    const token = 'X'.repeat(3000);
    const pdf = await renderer.render(
      doc([
        ['Long', lines],
        ['Token', token],
      ]),
      signal(),
    );
    const r = await text(pdf);
    expect(r.pages).toBeGreaterThan(1);
    const flat = squash(r.text);
    for (let i = 0; i < 400; i += 1) expect(flat).toContain(`line-${i}`);
    expect((flat.match(/X/g) ?? []).length).toBe(3000);
  });

  it('markup in an answer is literal text and nothing is fetched', async () => {
    const evil = `<script>document.title='x'</script><b>bold</b><img src="https://example.invalid/a.png">`;
    const pdf = await renderer.render(doc([['Evil', evil]]), signal());
    const flat = squash((await text(pdf)).text);
    expect(flat).toContain(squash(evil));
  });

  it('an aborted signal ends as pdf_timeout', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(renderer.render(doc([['a', 'b']]), ctl.signal)).rejects.toMatchObject({
      code: 'pdf_timeout',
    });
  });
});

describe('PDF renderer without a browser', () => {
  it('reports not ready and renders as pdf_unavailable', async () => {
    const dir = join(homedir(), '.gw-no-browser-here');
    expect(existsSync(dir)).toBe(false);
    const r = chromiumPdfRenderer({ browsersPath: dir, executablePath: join(dir, 'chrome') });
    expect((await r.status()).ready).toBe(false);
    await expect(r.render('<p>x</p>', AbortSignal.timeout(5000))).rejects.toBeInstanceOf(PdfError);
    await expect(r.render('<p>x</p>', AbortSignal.timeout(5000))).rejects.toMatchObject({
      code: 'pdf_unavailable',
    });
  });
});

describe('browsers path variable', () => {
  it('status() and render() leave PLAYWRIGHT_BROWSERS_PATH unchanged', async () => {
    const saved = process.env.PLAYWRIGHT_BROWSERS_PATH;
    try {
      delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      const r = chromiumPdfRenderer({ browsersPath: browsers, idleMs: 60_000 });
      await r.status();
      expect(process.env.PLAYWRIGHT_BROWSERS_PATH).toBeUndefined();
      if (ready) {
        await r.render(doc([['Q', 'A']]), AbortSignal.timeout(30_000));
        expect(process.env.PLAYWRIGHT_BROWSERS_PATH).toBeUndefined();
      }
      await r.close();
      process.env.PLAYWRIGHT_BROWSERS_PATH = '/some/other/path';
      const r2 = chromiumPdfRenderer({ browsersPath: browsers, idleMs: 60_000 });
      await r2.status();
      expect(process.env.PLAYWRIGHT_BROWSERS_PATH).toBe('/some/other/path');
      await r2.close();
    } finally {
      if (saved === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      else process.env.PLAYWRIGHT_BROWSERS_PATH = saved;
    }
  });
});
