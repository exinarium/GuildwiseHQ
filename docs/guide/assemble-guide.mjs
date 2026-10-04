#!/usr/bin/env node
// Builds guide.html from the parts in parts/: head.html (the CSS), cover.html, an automatic table of contents made from
// the h2 and h3 headings of the chapters, the "How to read this guide" box and the chapter files (ch01.html ... ch15.html;
// chapter 3 is ch03a.html + ch03b.html). Edit the parts, then run this script and build-guide.mjs.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const P = (f) => fs.readFileSync(path.join(here, 'parts', f), 'utf8');
const chapters = [];
for (let n = 1; n <= 15; n++) {
  const id = String(n).padStart(2, '0');
  const files = fs.existsSync(path.join(here, 'parts', `ch${id}.html`)) ? [`ch${id}.html`] : [`ch${id}a.html`, `ch${id}b.html`];
  chapters.push(files.map(P).join('\n'));
}
const body = chapters
  .join('\n\n')
  .replace(/<figure(?![^>]*chat)([^>]*)>(\s*<img src="assets\/(?:chat-[\w-]+|m-chat)\.jpg")/g, (_m, a, b) => `<figure${a.includes('class=') ? a : `${a} class="chat"`}>${b}`);

// Tall pictures were cut in two by prepare-assets.mjs (ID.jpg and ID-b.jpg): the lower half follows as its own figure.
const withB = fs.readdirSync(path.join(here, 'assets')).filter((f) => f.endsWith('-b.jpg')).map((f) => f.replace('-b.jpg', ''));
let bodyB = body;
for (const id of withB) {
  if (bodyB.includes(`assets/${id}-b.jpg`)) continue;
  const re = new RegExp(`(<figure[^>]*>\\s*<img src="assets/${id}\\.jpg"[^>]*>\\s*<figcaption>)([\\s\\S]*?)(</figcaption>\\s*</figure>)`);
  bodyB = bodyB.replace(re, (m, a, cap, c) => `${m}\n${a.replace(`${id}.jpg`, `${id}-b.jpg`)}${cap.replace(/\s*\(([^()]*)\)\s*$/, ' (continued: lower part, $1)')}${c}`);
}
const toc = [];
for (const m of bodyB.matchAll(/<h2><span class="mk">TOCMARK_(s\d+)_<\/span>([\s\S]*?)<\/h2>|<h3 id="(s\d+-\d+)"[^>]*><span class="mk">TOCMARK_\w+_<\/span>([\s\S]*?)<\/h3>/g)) {
  if (m[1]) toc.push(`    <a class="l1" href="#${m[1]}" data-id="${m[1]}"><span class="t">${m[2]}</span><span class="dots"></span><span class="pg"></span></a>`);
  else toc.push(`    <a class="l2" href="#${m[3]}" data-id="${m[3]}"><span class="t">${m[4]}</span><span class="dots"></span><span class="pg"></span></a>`);
}

const tocSection = `
<!-- ============================ TOC ============================ -->
<section>
  <h2 style="margin-top:0">Contents</h2>
  <nav class="toc" id="toc">
${toc.join('\n')}
  </nav>
  <div class="callout" style="margin-top:12px"><b class="t">How to read this guide</b>
    Chapters 1, 13 and 14 are the short version: what was built, what was decided and what you still need to do. Chapters 3 to 9 show every screen of the running app with the rules behind it, so you can review the behavior without opening the app. Chapters 10 to 12 are the technical handover. Purple boxes are business rules, amber boxes are things to watch, red boxes are actions for you, green boxes are verified results.</div>
  <div class="callout warn"><b class="t">About the screenshots</b>
    Every screenshot was taken from the real app running locally with a fake demo organization (<code>@demo.local</code>, <code>example.com</code>). The agents in the demo run on the mock runtime, a scripted stand-in for Claude Code that costs no tokens and never touches a real service, so agent replies, shift logs and handoff notes in the pictures read "[mock] ..." or "mock build round 1". Real agents write real work. No real Claude session, GitHub or Jira was used.</div>
</section>
`;
const extraCss = `<style>
  /* additions for this guide: tall pictures (forms, chat drawers, phone-width pages) are limited so a page holds more than one figure */
  figure img { max-height: 150mm; }
  figure.tall img { max-height: 210mm; }
  figure.chat img { max-height: 100mm; }
</style>
`;
const html = `${P('head.html').replace(/<body>\s*$/, `${extraCss}</head>\n<body>`)}\n${P('cover.html')}\n${tocSection}\n${bodyB}\n</body>\n</html>\n`;
fs.writeFileSync(path.join(here, 'guide.html'), html);
console.log(`guide.html: ${(html.length / 1024).toFixed(0)} KB, ${toc.length} contents entries, ${(html.match(/<figure/g) ?? []).length} figures`);
const missing = [...html.matchAll(/src="assets\/([\w-]+\.jpg)"/g)].map((m) => m[1]).filter((f) => !fs.existsSync(path.join(here, 'assets', f)));
if (missing.length) console.warn('MISSING images:', [...new Set(missing)].join(', '));
