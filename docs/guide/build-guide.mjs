#!/usr/bin/env node
// Builds Guildwise-HQ-User-Guide.pdf from guide.html with Playwright Chromium.
// Uses the Playwright and pdf-parse packages of the e2e workspace package (pnpm install; pnpm --filter @aom/e2e exec playwright install chromium).
// Usage: node docs/guide/build-guide.mjs [--out <file.pdf>]
//
// The table of contents gets real page numbers in a two-pass build: every heading carries an invisible marker
// (TOCMARK_<id>_); the PDF text is searched for the markers and the page numbers are written into the contents, then the
// PDF is rendered again (repeated until the numbers are stable).
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const e2eRequire = createRequire(path.join(repo, 'e2e/package.json'));
const { chromium } = e2eRequire('@playwright/test');
const pdfParse = e2eRequire('pdf-parse/lib/pdf-parse.js');

const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? path.resolve(process.argv[outArg + 1]) : path.join(here, 'Guildwise-HQ-User-Guide.pdf');

const footer = `<div style="width:100%;font-family:'Geist','Liberation Sans',Arial,sans-serif;font-size:7.5pt;color:#6b7280;padding:0 15mm;display:flex;justify-content:space-between;">
  <span>Guildwise HQ &middot; User Guide &middot; 7 October 2026</span>
  <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;

const render = (page) => page.pdf({
  format: 'A4', printBackground: true, displayHeaderFooter: true,
  headerTemplate: '<span></span>', footerTemplate: footer,
  margin: { top: '16mm', bottom: '18mm', left: '15mm', right: '15mm' },
  preferCSSPageSize: true,
  scale: 0.9,
});

const pageTexts = async (buf) => {
  const texts = [];
  await pdfParse(buf, {
    pagerender: async (pageData) => {
      const content = await pageData.getTextContent();
      const text = content.items.map((i) => i.str).join('');
      texts.push(text);
      return text;
    },
  });
  return texts;
};

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(path.join(here, 'guide.html')).href, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const entries = await page.$$eval('#toc a[data-id]', (as) => as.map((a) => ({ id: a.dataset.id, text: a.querySelector('.t').textContent })));
  const ids = entries.map((e) => e.id);

  let pdf;
  let previous = '';
  for (let pass = 1; pass <= 4; pass++) {
    pdf = await render(page);
    const texts = await pageTexts(pdf);
    const numbers = {};
    const squash = (t) => t.replace(/\s+/g, '');
    let from = 0;
    for (const { id, text } of entries) {
      // chapters carry an invisible marker; sections are found by their heading text, searching forward
      let idx = id.includes('-') ? -1 : texts.findIndex((t) => t.includes(`TOCMARK_${id}_`));
      if (idx < 0) idx = texts.findIndex((t, n) => n >= from && squash(t).includes(squash(text)));
      if (idx >= 0) from = idx;
      numbers[id] = idx >= 0 ? String(idx + 1) : '?';
    }
    const key = JSON.stringify(numbers);
    console.log(`pass ${pass}: ${texts.length} pages`);
    if (key === previous) break;
    previous = key;
    await page.evaluate((nums) => {
      for (const a of document.querySelectorAll('#toc a[data-id]')) a.querySelector('.pg').textContent = nums[a.dataset.id];
    }, numbers);
  }
  const missing = Object.entries(JSON.parse(previous)).filter(([, v]) => v === '?');
  if (missing.length) console.warn('TOC markers not found:', missing.map(([k]) => k).join(', '));
  fs.writeFileSync(OUT, pdf);
  console.log(`wrote ${OUT} (${(pdf.length / 1024 / 1024).toFixed(2)} MB)`);
} finally {
  await browser.close();
}
