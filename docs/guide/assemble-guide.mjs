#!/usr/bin/env node
// Builds guide.html from docs/USER-GUIDE.md (the single source of the text), parts/head.html (the CSS) and
// parts/cover.html (the cover). It also writes the table of contents into USER-GUIDE.md (between the
// `<!-- toc -->` and `<!-- /toc -->` markers) so the Markdown file and the PDF always agree.
//
// Figures are written in the Markdown as `![Caption](guide/assets/name.jpg)` on a line of their own; they work on
// GitHub and in the PDF. Callouts are blockquotes that start with a bold label: Tip, Good to know, Watch out,
// In the app, Before you start.
//
// Usage: node docs/guide/assemble-guide.mjs   (then node docs/guide/build-guide.mjs)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MD = path.join(here, '..', 'USER-GUIDE.md');
const part = (f) => fs.readFileSync(path.join(here, 'parts', f), 'utf8');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const slug = (h) =>
  h
    .toLowerCase()
    .replace(/[`*]/g, '')
    .replace(/[^a-z0-9 _-]/g, '')
    .trim()
    .replace(/ /g, '-');

/** Inline Markdown: code, bold, italic, links. */
function inline(text) {
  const codes = [];
  let t = text.replace(/`([^`]+)`/g, (_m, c) => {
    codes.push(`<code>${esc(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  t = esc(t)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,:;!?]|$)/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return t.replace(/\u0000(\d+)\u0000/g, (_m, i) => codes[Number(i)]);
}

const CALLOUT = {
  tip: 'ok',
  'good to know': '',
  'watch out': 'warn',
  'in the app': 'rule',
  'before you start': 'todo',
};

const lines = fs.readFileSync(MD, 'utf8').split('\n');
const out = [];
const toc = []; // {level, id, text, mdSlug}
let chapter = 0;
let section = 0;
let i = 0;

function renderList(start, ordered) {
  // collect the list block: items start with "- " or "N. " at the base indent; deeper indented lines continue or nest
  const items = [];
  let j = start;
  const itemRe = ordered ? /^(\d+)\.\s+(.*)$/ : /^-\s+(.*)$/;
  while (j < lines.length) {
    const l = lines[j];
    const m = itemRe.exec(l);
    if (m) {
      items.push({ text: ordered ? m[2] : m[1], sub: [] });
      j++;
    } else if (/^\s{2,}-\s+/.test(l) && items.length) {
      items.at(-1).sub.push(l.replace(/^\s+-\s+/, ''));
      j++;
    } else if (/^\s{2,}\S/.test(l) && items.length) {
      items.at(-1).text += ` ${l.trim()}`;
      j++;
    } else break;
  }
  const tag = ordered ? 'ol' : 'ul';
  const html = items
    .map(
      (it) =>
        `<li>${inline(it.text)}${it.sub.length ? `<ul>${it.sub.map((s) => `<li>${inline(s)}</li>`).join('')}</ul>` : ''}</li>`,
    )
    .join('');
  return { html: `<${tag}>${html}</${tag}>`, next: j };
}

function renderTable(start) {
  const rows = [];
  let j = start;
  while (j < lines.length && lines[j].startsWith('|')) {
    rows.push(lines[j]);
    j++;
  }
  const cells = (r) =>
    r
      .replace(/^\||\|$/g, '')
      .split(/(?<!\\)\|/)
      .map((c) => c.trim().replace(/\\\|/g, '|'));
  const head = cells(rows[0]);
  const body = rows.slice(2).map(cells);
  const html = `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body
    .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
  return { html, next: j };
}

let title = '';
let tagline = '';
while (i < lines.length) {
  const l = lines[i];
  if (l.startsWith('<!-- toc -->')) {
    out.push('<!--TOC-->');
    while (i < lines.length && !lines[i].startsWith('<!-- /toc -->')) i++;
    i++;
    continue;
  }
  if (/^<!--/.test(l)) {
    i++;
    continue;
  }
  let m;
  if ((m = /^# (.*)$/.exec(l))) {
    title = m[1];
    i++;
    continue;
  }
  if ((m = /^## (.*)$/.exec(l))) {
    chapter++;
    section = 0;
    const id = `s${chapter}`;
    toc.push({ level: 2, id, text: m[1], mdSlug: slug(m[1]) });
    out.push(`<section class="chapter" id="${id}"><h2><span class="mk">TOCMARK_${id}_</span>${inline(m[1])}</h2>`);
    // close the previous chapter section
    if (chapter > 1) out.splice(out.length - 1, 0, '</section>');
    i++;
    continue;
  }
  if ((m = /^### (.*)$/.exec(l))) {
    section++;
    const id = `s${chapter}-${section}`;
    toc.push({ level: 3, id, text: m[1], mdSlug: slug(m[1]) });
    out.push(`<h3 id="${id}"><span class="mk">TOCMARK_s${chapter}x${section}_</span>${inline(m[1])}</h3>`);
    i++;
    continue;
  }
  if ((m = /^#### (.*)$/.exec(l))) {
    out.push(`<h4>${inline(m[1])}</h4>`);
    i++;
    continue;
  }
  if ((m = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(l))) {
    const src = m[2].replace(/^guide\//, '');
    const cls = /^assets\/(?:m-|chat-|login|invite|dlg-|contact|palette)/.test(src) ? ' class="small"' : '';
    out.push(`<figure${cls}><img src="${src}" alt="${esc(m[1])}"><figcaption>${inline(m[1])}</figcaption></figure>`);
    i++;
    continue;
  }
  if (l.startsWith('>')) {
    const block = [];
    while (i < lines.length && lines[i].startsWith('>')) {
      block.push(lines[i].replace(/^>\s?/, ''));
      i++;
    }
    const text = block.join(' ');
    const lm = /^\*\*([^*]+?):?\*\*:?\s*(.*)$/.exec(text);
    const key = lm ? lm[1].toLowerCase() : '';
    const kind = key in CALLOUT ? CALLOUT[key] : '';
    if (lm && key in CALLOUT) out.push(`<div class="callout ${kind}"><b class="t">${esc(lm[1])}</b>${inline(lm[2].charAt(0).toUpperCase() + lm[2].slice(1))}</div>`);
    else out.push(`<div class="callout">${inline(text)}</div>`);
    continue;
  }
  if (l.startsWith('|')) {
    const r = renderTable(i);
    out.push(r.html);
    i = r.next;
    continue;
  }
  if (/^-\s+/.test(l)) {
    const r = renderList(i, false);
    out.push(r.html);
    i = r.next;
    continue;
  }
  if (/^\d+\.\s+/.test(l)) {
    const r = renderList(i, true);
    out.push(r.html);
    i = r.next;
    continue;
  }
  if (l.trim() === '') {
    i++;
    continue;
  }
  // a paragraph: until a blank line or a block start
  const para = [l];
  i++;
  while (i < lines.length && lines[i].trim() !== '' && !/^(#|>|\||- |\d+\. |!\[|<!--)/.test(lines[i])) {
    para.push(lines[i]);
    i++;
  }
  const text = para.join(' ');
  if (!tagline && /^\*[^*]+\*$/.test(text)) {
    tagline = text.replace(/\*/g, '');
    continue;
  }
  out.push(`<p>${inline(text)}</p>`);
}
out.push('</section>');

// ---- the table of contents: Markdown (GitHub anchors) and PDF
const tocMd = toc
  .map((t) => `${t.level === 2 ? '' : '  '}- [${t.text}](#${t.mdSlug})`)
  .join('\n');
let md = fs.readFileSync(MD, 'utf8');
md = md.replace(/<!-- toc -->[\s\S]*?(<!-- \/toc -->|(?=\n## ))/, `<!-- toc -->\n**Contents**\n\n${tocMd}\n\n<!-- /toc -->\n`);
fs.writeFileSync(MD, md);

const tocHtml = toc
  .map(
    (t) =>
      `    <a class="l${t.level === 2 ? 1 : 2}" href="#${t.id}" data-id="${t.id}"><span class="t">${inline(t.text)}</span><span class="dots"></span><span class="pg"></span></a>`,
  )
  .join('\n');
const tocSection = `
<section class="tocpage">
  <h2 style="margin-top:0">Contents</h2>
  <nav class="toc" id="toc">
${tocHtml}
  </nav>
</section>
<section class="about">
  <div class="callout"><b class="t">About the screenshots</b>
    Every picture is a real screenshot of Guildwise HQ running locally with a fake demo organization (<code>@demo.local</code>, <code>example.com</code>). The agents in the demo run on a scripted stand-in for Claude, so their messages and logs read "[mock] ..." and nothing real (no Claude session, GitHub or Jira) was used. Real agents write real work.</div>
</section>`;

const body = out.join('\n');
const htmlBody = body.replace('<!--TOC-->', '');
const cover = part('cover.html');
const html = `${part('head.html')}\n${cover}\n${tocSection}\n${htmlBody}\n</body>\n</html>\n`;
fs.writeFileSync(path.join(here, 'guide.html'), html);
console.log(
  `guide.html: ${(html.length / 1024).toFixed(0)} KB, ${toc.length} contents entries, ${(html.match(/<figure/g) ?? []).length} figures`,
);
const missing = [...html.matchAll(/src="assets\/([\w-]+\.jpg)"/g)]
  .map((m2) => m2[1])
  .filter((f) => !fs.existsSync(path.join(here, 'assets', f)));
if (missing.length) {
  console.warn('MISSING images:', [...new Set(missing)].join(', '));
  process.exitCode = process.argv.includes('--allow-missing') ? 0 : 1;
}
void title;
void tagline;
