import { z } from 'zod';

/**
 * The user guide (docs/USER-GUIDE.md): parse it, locate the sections that describe a feature, apply proposed section
 * edits and check the result. Pure, no file system.
 *
 * Rules kept by construction: a heading line is never rewritten, a number is never changed, a new section gets its
 * number from the code (4.28a after 4.28 when 4.29 follows; 4.31 after the last section 4.30 of the chapter), and the
 * contents block is rendered exactly as docs/guide/assemble-guide.mjs writes it.
 */

export const DEFAULT_GUIDE_PATH = 'docs/USER-GUIDE.md';

export interface GuideHeading {
  /** 0-based line index. */
  line: number;
  level: 2 | 3 | 4;
  /** The exact heading line; never rewritten. */
  raw: string;
  /** The heading text after the hashes. */
  text: string;
  /** '4', '4.28', '4.28a'; appendices and unnumbered headings: null. */
  number: string | null;
  /** The text after the number. */
  title: string;
  slug: string;
}

export interface GuideSection {
  heading: GuideHeading;
  /** Its `##` parent (itself for a chapter). */
  chapter: GuideHeading;
  /** Body lines [bodyStart, end); end is the next `##` or `###` heading (or the end of the file). */
  bodyStart: number;
  end: number;
}

export interface GuideDoc {
  lines: string[];
  eol: '\n' | '\r\n';
  finalEol: boolean;
  toc: { start: number; end: number } | null;
  headings: GuideHeading[];
  sections: GuideSection[];
}

/** The slug of assemble-guide.mjs (GitHub style). */
export const guideSlug = (h: string): string =>
  h
    .toLowerCase()
    .replace(/[`*]/g, '')
    .replace(/[^a-z0-9 _-]/g, '')
    .trim()
    .replace(/ /g, '-');

const CHAPTER_NO = /^(\d+)\.\s+(.*)$/;
const SECTION_NO = /^(\d+)\.(\d+)([a-z]?)\s+(.*)$/;

function heading(line: number, raw: string): GuideHeading | null {
  const m = /^(#{2,4}) (.*)$/.exec(raw);
  if (!m) return null;
  const level = (m[1] as string).length as 2 | 3 | 4;
  const text = m[2] as string;
  let number: string | null = null;
  let title = text;
  if (level === 2) {
    const c = CHAPTER_NO.exec(text);
    if (c) {
      number = c[1] as string;
      title = c[2] as string;
    }
  } else if (level === 3) {
    const s = SECTION_NO.exec(text);
    if (s) {
      number = `${s[1]}.${s[2]}${s[3]}`;
      title = s[4] as string;
    }
  }
  return { line, level, raw, text, number, title, slug: guideSlug(text) };
}

export function parseGuide(md: string): GuideDoc {
  const eol: '\n' | '\r\n' = md.includes('\r\n') ? '\r\n' : '\n';
  const finalEol = md.endsWith(eol);
  const lines = md.split(eol);
  if (finalEol) lines.pop();
  let toc: GuideDoc['toc'] = null;
  const start = lines.findIndex((l) => l.startsWith('<!-- toc -->'));
  if (start >= 0) {
    const end = lines.findIndex((l, i) => i > start && l.startsWith('<!-- /toc -->'));
    if (end > start) toc = { start, end };
  }
  const headings: GuideHeading[] = [];
  lines.forEach((l, i) => {
    if (toc && i >= toc.start && i <= toc.end) return;
    const h = heading(i, l);
    if (h) headings.push(h);
  });
  const top = headings.filter((h) => h.level <= 3);
  const sections: GuideSection[] = [];
  let chapter: GuideHeading | null = null;
  top.forEach((h, k) => {
    if (h.level === 2) chapter = h;
    sections.push({
      heading: h,
      chapter: chapter ?? h,
      bodyStart: h.line + 1,
      end: top[k + 1]?.line ?? lines.length,
    });
  });
  return { lines, eol, finalEol, toc, headings, sections };
}

/** One line per chapter and section ("4.28 Releases (31 lines)"), for the prompt. */
export function guideOutline(doc: GuideDoc): string {
  return doc.sections
    .map((s) => `${s.heading.level === 3 ? '  ' : ''}${s.heading.text} (${s.end - s.bodyStart} lines)`)
    .join('\n');
}

/** The contents block, byte-identical to what assemble-guide.mjs writes between the markers. */
export function renderGuideToc(doc: GuideDoc): string {
  const md = doc.headings
    .filter((h) => h.level <= 3)
    .map((h) => `${h.level === 2 ? '' : '  '}- [${h.text}](#${h.slug})`)
    .join(doc.eol);
  return ['<!-- toc -->', '**Contents**', '', md, '', '<!-- /toc -->'].join(doc.eol);
}

// ------------------------------------------------------------------------------------------------------- locate

const STOP = new Set(
  'the and for with from that this into when then than what your have will page step steps shows show list make adds add use uses update updates fix fixes new more only each per also does done'.split(
    ' ',
  ),
);

const stem = (w: string): string => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w);

/** Lower-case word stems of length >= 4 (camel case and paths split). */
export function guideWords(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w))
    .map(stem);
}

const PATH_NOISE = new Set(
  'apps src web server runner packages shared components component pages page index test tests spec docs lib api queries'.split(
    ' ',
  ),
);

function pathWords(path: string): string[] {
  const parts = path.replace(/\.[a-z0-9]+$/i, '').split('/');
  return parts.flatMap((p) => guideWords(p)).filter((w) => !PATH_NOISE.has(w));
}

const SECTION_REF = /(?<![\w.])(\d{1,2}\.\d{1,2}[a-z]?)(?![\w.]?\d)/g;

/** Section map rows (Appendix A): sidebar label words -> the section numbers named in the row. */
function sectionMap(doc: GuideDoc): Array<{ words: string[]; numbers: string[] }> {
  const map = doc.sections.find((s) => /section map/i.test(s.heading.title));
  if (!map) return [];
  const out: Array<{ words: string[]; numbers: string[] }> = [];
  for (const l of doc.lines.slice(map.bodyStart, map.end)) {
    if (!l.startsWith('|')) continue;
    const label = /\*\*([^*]+)\*\*/.exec(l)?.[1];
    if (!label) continue;
    const numbers = [...l.matchAll(SECTION_REF)].map((m) => m[1] as string);
    if (numbers.length > 0) out.push({ words: guideWords(label), numbers });
  }
  return out;
}

/** Ranked sections that describe a feature. A hint for the writer, not a gate. */
export function locateSections(
  doc: GuideDoc,
  feature: { title: string; areas?: string[]; files?: string[]; routes?: string[] },
): Array<{ section: string; score: number; why: string }> {
  const words = new Set([
    ...guideWords(feature.title),
    ...(feature.areas ?? []).flatMap(pathWords),
    ...(feature.files ?? []).flatMap(pathWords),
  ]);
  const routes = new Set((feature.routes ?? []).map((r) => r.toLowerCase()));
  const scores = new Map<string, { score: number; why: Set<string> }>();
  const bump = (text: string, n: number, why: string): void => {
    const e = scores.get(text) ?? { score: 0, why: new Set<string>() };
    e.score += n;
    e.why.add(why);
    scores.set(text, e);
  };
  const byNumber = new Map(
    doc.sections.filter((s) => s.heading.level === 3 && s.heading.number).map((s) => [s.heading.number, s]),
  );
  for (const s of doc.sections) {
    if (s.heading.level !== 3) continue;
    const hit = guideWords(s.heading.title).filter((w) => words.has(w));
    if (hit.length > 0) bump(s.heading.text, 3 * hit.length, `heading: ${hit.join(', ')}`);
    const body = doc.lines.slice(s.bodyStart, s.end).join('\n');
    const labels = [...body.matchAll(/\*\*([^*]+)\*\*/g)].flatMap((m) => guideWords(m[1] as string));
    const lab = [...new Set(labels.filter((w) => words.has(w)))];
    if (lab.length > 0) bump(s.heading.text, lab.length, `labels: ${lab.join(', ')}`);
    const rts = [...body.matchAll(/`(\/[a-z0-9/_-]+)/gi)].map((m) => (m[1] as string).toLowerCase());
    const rh = [...new Set(rts.filter((r) => routes.has(r)))];
    if (rh.length > 0) bump(s.heading.text, rh.length, `routes: ${rh.join(', ')}`);
  }
  for (const row of sectionMap(doc)) {
    const hit = row.words.filter((w) => words.has(w));
    if (hit.length === 0) continue;
    for (const n of row.numbers) {
      const s = byNumber.get(n);
      if (s) bump(s.heading.text, 3 * hit.length, `section map: ${hit.join(', ')}`);
    }
  }
  return [...scores.entries()]
    .map(([section, e]) => ({ section, score: e.score, why: [...e.why].join('; ') }))
    .sort((a, b) => b.score - a.score || a.section.localeCompare(b.section));
}

// -------------------------------------------------------------------------------------------------------- edits

export const GuideEditSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('replace_text'),
    section: z.string().min(1).max(200),
    find: z.string().min(1).max(4000),
    replace: z.string().max(4000),
    sources: z.array(z.string().max(80)).max(50).default([]),
  }),
  z.object({
    op: z.literal('append'),
    section: z.string().min(1).max(200),
    text: z.string().min(1).max(6000),
    sources: z.array(z.string().max(80)).max(50).default([]),
  }),
  z.object({
    op: z.literal('add_section'),
    after: z.string().min(1).max(200),
    title: z.string().min(1).max(120),
    body: z.string().min(1).max(12000),
    sources: z.array(z.string().max(80)).max(50).default([]),
  }),
]);
export type GuideEdit = z.infer<typeof GuideEditSchema>;

/** What the writer returns (a JSON file). */
export const GuideProposalSchema = z.object({
  edits: z.array(GuideEditSchema).max(40).default([]),
  covered: z
    .array(z.object({ source: z.string().max(80), section: z.string().max(200) }))
    .max(500)
    .default([]),
  skipped: z
    .array(z.object({ source: z.string().max(80), reason: z.string().max(300) }))
    .max(500)
    .default([]),
  notes: z.array(z.string().max(500)).max(50).default([]),
});
export type GuideProposal = z.infer<typeof GuideProposalSchema>;

export type ApplyGuideOutcome =
  | {
      kind: 'changed';
      md: string;
      /** Heading text of the sections edited ('4.28 Releases'). */
      changed: string[];
      added: Array<{ section: string; after: string }>;
      duplicates: GuideEdit[];
      /** Line ranges [start, end) of the result that this update wrote. */
      written: Array<[number, number]>;
    }
  | { kind: 'unchanged'; duplicates: GuideEdit[] }
  | { kind: 'error'; errors: string[] };

const CALLOUT_LABELS = ['Tip', 'Good to know', 'Watch out', 'In the app', 'Before you start'];
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Body and text rules of written Markdown. */
function textErrors(what: string, text: string, allowH4: boolean): string[] {
  const errs: string[] = [];
  for (const l of text.split(/\r?\n/)) {
    if (/^#{1,3}( |$)/.test(l) || (!allowH4 && /^#{4}( |$)/.test(l)))
      errs.push(`${what}: a heading line is not allowed here (${JSON.stringify(l.slice(0, 60))})`);
    if (l.includes('<!--')) errs.push(`${what}: HTML comments are not allowed`);
    if (/^\s*```/.test(l)) errs.push(`${what}: fenced blocks are not allowed`);
    if (/^!\[/.test(l)) errs.push(`${what}: figures are not added by this update`);
    const c = /^> \*\*([^*]+?):?\*\*/.exec(l);
    if (c && !CALLOUT_LABELS.includes((c[1] as string).replace(/:$/, '')))
      errs.push(`${what}: unknown callout label "${c[1]}"`);
  }
  return errs;
}

/** Find one section by number ('4.28', also '4.28 Releases') or by its exact title. */
function resolve(doc: GuideDoc, ref: string): GuideSection | string {
  const r = ref.trim();
  const lead = /^(\d+\.\d+[a-z]?)(\s|$)/.exec(r)?.[1];
  const level3 = doc.sections.filter((s) => s.heading.level === 3);
  let found = lead ? level3.filter((s) => s.heading.number === lead) : [];
  if (found.length === 0)
    found = level3.filter((s) => norm(s.heading.title) === norm(r) || norm(s.heading.text) === norm(r));
  if (found.length === 0) return `unknown section "${ref}"`;
  if (found.length > 1) return `ambiguous section "${ref}"`;
  return found[0] as GuideSection;
}

const numKey = (n: string): [number, number, string] => {
  const m = /^(\d+)\.(\d+)([a-z]?)$/.exec(n);
  return m ? [Number(m[1]), Number(m[2]), m[3] as string] : [0, 0, ''];
};
const cmpNum = (a: string, b: string): number => {
  const [a1, a2, a3] = numKey(a);
  const [b1, b2, b3] = numKey(b);
  return a1 - b1 || a2 - b2 || (a3 < b3 ? -1 : a3 > b3 ? 1 : 0);
};

interface NewSection {
  number: string | null;
  title: string;
  body: string[];
  after: string;
}

/**
 * Applies the edits. Edits that are already in the guide are dropped as duplicates (a second run changes nothing).
 * Any invalid edit fails the whole update; nothing is half applied.
 */
export function applyGuideEdits(md: string, edits: readonly GuideEdit[]): ApplyGuideOutcome {
  const doc = parseGuide(md);
  const errors: string[] = [];
  const duplicates: GuideEdit[] = [];
  const bodies = new Map<number, string[]>(); // section heading line -> edited body
  const inserts = new Map<number, NewSection[]>(); // anchor section heading line -> new sections after it
  const edited = new Set<number>();
  const bodyOf = (s: GuideSection): string[] =>
    bodies.get(s.heading.line) ?? doc.lines.slice(s.bodyStart, s.end);
  const chapterNumbers = new Map<number, string[]>();
  for (const s of doc.sections)
    if (s.heading.level === 3 && s.heading.number) {
      const list = chapterNumbers.get(s.chapter.line) ?? [];
      list.push(s.heading.number);
      chapterNumbers.set(s.chapter.line, list);
    }
  const titles = new Set(doc.headings.filter((h) => h.level <= 3).map((h) => norm(h.title)));
  const slugs = new Set(doc.headings.map((h) => h.slug));

  const applyOne = (e: GuideEdit, i: number): void => {
    const what = `edit ${i + 1} (${e.op})`;
    if (e.op === 'add_section') {
      const s = resolve(doc, e.after);
      if (typeof s === 'string') return void errors.push(`${what}: ${s}`);
      if (/^\d+(\.\d+[a-z]?)?\.?\s/.test(e.title.trim()))
        return void errors.push(
          `${what}: the title must not carry a number; the number is chosen by the update`,
        );
      if (/[\r\n]/.test(e.title) || e.title.includes('#'))
        return void errors.push(`${what}: the title must be one line of text`);
      const errs = textErrors(what, e.body, true);
      if (errs.length) return void errors.push(...errs);
      if (titles.has(norm(e.title))) return void duplicates.push(e);
      let number: string | null = null;
      let anchor = s;
      const own = s.heading.number;
      if (own) {
        const [c, n] = numKey(own);
        const list = chapterNumbers.get(s.chapter.line) ?? [];
        const later = list.some((x) => cmpNum(x, own) > 0);
        if (!later) number = `${c}.${n + 1}`;
        else {
          const base = `${c}.${n}`;
          const letters = list.filter((x) => x.startsWith(base) && /[a-z]$/.test(x) && numKey(x)[1] === n);
          const max = letters
            .map((x) => x.slice(-1))
            .sort()
            .at(-1);
          const next = max ? String.fromCharCode(max.charCodeAt(0) + 1) : 'a';
          if (next > 'z') return void errors.push(`${what}: no free letter after ${base}z`);
          number = `${base}${next}`;
          // after the last existing section of this base
          const sibs = doc.sections.filter(
            (x) =>
              x.chapter.line === s.chapter.line &&
              x.heading.number &&
              numKey(x.heading.number)[0] === c &&
              numKey(x.heading.number)[1] === n,
          );
          anchor = sibs.at(-1) ?? s;
        }
        list.push(number);
        chapterNumbers.set(s.chapter.line, list);
      }
      const text = number ? `${number} ${e.title.trim()}` : e.title.trim();
      if (slugs.has(guideSlug(text)))
        return void errors.push(`${what}: the heading "${text}" would clash with an existing anchor`);
      slugs.add(guideSlug(text));
      titles.add(norm(e.title));
      const list = inserts.get(anchor.heading.line) ?? [];
      list.push({ number, title: e.title.trim(), body: e.body.trim().split(/\r?\n/), after: s.heading.text });
      inserts.set(anchor.heading.line, list);
      return;
    }
    const s = resolve(doc, e.section);
    if (typeof s === 'string') return void errors.push(`${what}: ${s}`);
    const body = bodyOf(s);
    const joined = body.join('\n');
    if (e.op === 'replace_text') {
      if (e.find === e.replace) return void errors.push(`${what}: replace equals find`);
      const errs = textErrors(what, e.replace, false);
      if (errs.length) return void errors.push(...errs);
      const count = joined.split(e.find).length - 1;
      if (count === 0) {
        if (e.replace && joined.includes(e.replace)) return void duplicates.push(e);
        return void errors.push(`${what}: the text to replace is not in ${s.heading.text}`);
      }
      if (count > 1)
        return void errors.push(`${what}: the text to replace occurs ${count} times in ${s.heading.text}`);
      bodies.set(s.heading.line, joined.replace(e.find, () => e.replace).split('\n'));
      edited.add(s.heading.line);
      return;
    }
    // append
    const errs = textErrors(what, e.text, false);
    if (errs.length) return void errors.push(...errs);
    if (norm(joined).includes(norm(e.text))) return void duplicates.push(e);
    let core = body.length;
    while (core > 0 && (body[core - 1] as string).trim() === '') core--;
    const trailing = body.slice(core);
    let at = core;
    const isApp = (l: string | undefined): boolean => !!l && l.startsWith('> **In the app:**');
    while (at > 0 && (isApp(body[at - 1]) || ((body[at - 1] as string).trim() === '' && isApp(body[at - 2]))))
      at--;
    while (at < core && (body[at] as string).trim() === '') at++;
    const before = body.slice(0, at);
    while (before.length > 0 && (before.at(-1) as string).trim() === '') before.pop();
    const after = body.slice(at, core);
    const text = e.text.trim().split(/\r?\n/);
    bodies.set(s.heading.line, [
      ...before,
      ...(before.length ? [''] : []),
      ...text,
      ...(after.length ? ['', ...after] : []),
      ...(trailing.length ? trailing : ['']),
    ]);
    edited.add(s.heading.line);
  };
  for (const [i, e] of edits.entries()) applyOne(e, i);
  if (errors.length > 0) return { kind: 'error', errors };
  if (bodies.size === 0 && inserts.size === 0) return { kind: 'unchanged', duplicates };

  // Rebuild: everything before the first section, then each section's heading and body, then its new sections.
  const out: string[] = [];
  const written: Array<[number, number]> = [];
  const changed: string[] = [];
  const added: Array<{ section: string; after: string }> = [];
  const first = doc.sections[0]?.heading.line ?? doc.lines.length;
  out.push(...doc.lines.slice(0, first));
  for (const s of doc.sections) {
    out.push(doc.lines[s.heading.line] as string);
    const orig = doc.lines.slice(s.bodyStart, s.end);
    const body = bodies.get(s.heading.line);
    if (body) {
      // the lines that differ, as one range (prefix and suffix that stayed are not counted)
      let a = 0;
      while (a < orig.length && a < body.length && orig[a] === body[a]) a++;
      let b = 0;
      while (
        b < orig.length - a &&
        b < body.length - a &&
        orig[orig.length - 1 - b] === body[body.length - 1 - b]
      )
        b++;
      written.push([out.length + a, out.length + body.length - b]);
      out.push(...body);
      if (edited.has(s.heading.line) && !changed.includes(s.heading.text)) changed.push(s.heading.text);
    } else out.push(...orig);
    const news = (inserts.get(s.heading.line) ?? []).slice();
    news.sort((x, y) => (x.number && y.number ? cmpNum(x.number, y.number) : 0));
    for (const n of news) {
      if (out.length > 0 && (out.at(-1) as string).trim() !== '') out.push('');
      const text = n.number ? `${n.number} ${n.title}` : n.title;
      const start = out.length;
      out.push(`### ${text}`, '', ...n.body, '');
      written.push([start, out.length]);
      added.push({ section: text, after: n.after });
    }
  }
  // re-render the contents block
  let result = out;
  const parsed = parseGuide(out.join(doc.eol) + (doc.finalEol ? doc.eol : ''));
  if (parsed.toc) {
    const toc = renderGuideToc(parsed).split(doc.eol);
    const delta = toc.length - (parsed.toc.end - parsed.toc.start + 1);
    result = [...out.slice(0, parsed.toc.start), ...toc, ...out.slice(parsed.toc.end + 1)];
    const at = parsed.toc.start;
    for (const w of written)
      if (w[0] > at) {
        w[0] += delta;
        w[1] += delta;
      }
  }
  const text = result.join(doc.eol) + (doc.finalEol ? doc.eol : '');
  if (text === md) return { kind: 'unchanged', duplicates };
  // Self-check: every heading of the input is there, unchanged and in order.
  const afterRaws = parseGuide(text).headings.map((h) => h.raw);
  let k = 0;
  for (const h of doc.headings) {
    while (k < afterRaws.length && afterRaws[k] !== h.raw) k++;
    if (k >= afterRaws.length)
      return { kind: 'error', errors: ['internal: edit would change text outside the named sections'] };
    k++;
  }
  return { kind: 'changed', md: text, changed, added, duplicates, written };
}

// ------------------------------------------------------------------------------------------------------- checks

export interface GuideCheckContext {
  /** Whether a figure path (as written in the guide, relative to the guide's folder) exists. */
  assetExists: (relPath: string) => boolean;
  /** Only when the repository has the in-app Help articles. */
  helpRef?: (slug: string, id: string | null) => boolean;
  /** Lines of `after` written by this update; the reference, help and text checks look only at these. */
  changedRanges?: Array<[number, number]>;
  editedSections?: number;
  addedSections?: number;
  denyList?: readonly string[];
}

const MAX_EDITED = 6;
const MAX_ADDED = 4;
const MAX_SHARE = 0.25;
const NOT_KEYS = new Set(['UTF', 'ISO', 'SHA', 'ES', 'HTTP', 'TLS', 'RFC', 'WCAG', 'COVID', 'MP', 'H']);

/** Problems in text this update wrote: ticket keys, commit ids, secrets and deny-listed terms. */
export function scrubGuideText(text: string, denyList: readonly string[] = []): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9]+)-\d+\b/g))
    if (!NOT_KEYS.has(m[1] as string)) out.push(`a ticket key ("${m[0]}")`);
  for (const m of text.matchAll(/\b[0-9a-f]{7,40}\b/g))
    if (/\d/.test(m[0]) && /[a-f]/.test(m[0])) out.push(`a commit id ("${m[0]}")`);
  if (
    /\b(ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{10,}|\bsk-[A-Za-z0-9-]{16,}|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY/.test(
      text,
    )
  )
    out.push('something that looks like a secret');
  const low = text.toLowerCase();
  for (const t of denyList)
    if (t.trim() && low.includes(t.trim().toLowerCase())) out.push(`the term "${t.trim()}"`);
  return out;
}

function structural(doc: GuideDoc, ctx: GuideCheckContext): string[] {
  const errs: string[] = [];
  const seen = new Map<string, number>();
  for (const h of doc.headings)
    if (h.level <= 3 && h.number) seen.set(h.number, (seen.get(h.number) ?? 0) + 1);
  for (const [n, c] of seen) if (c > 1) errs.push(`section number ${n} is used ${c} times`);
  const byChapter = new Map<number, string[]>();
  for (const s of doc.sections)
    if (s.heading.level === 3 && s.heading.number) {
      const l = byChapter.get(s.chapter.line) ?? [];
      l.push(s.heading.number);
      byChapter.set(s.chapter.line, l);
    }
  for (const list of byChapter.values()) {
    for (let i = 1; i < list.length; i++)
      if (cmpNum(list[i - 1] as string, list[i] as string) >= 0)
        errs.push(`section ${list[i]} comes after ${list[i - 1]}`);
    const bases = new Map<string, string[]>();
    for (const n of list) {
      const m = /^(\d+\.\d+)([a-z])$/.exec(n);
      if (m) bases.set(m[1] as string, [...(bases.get(m[1] as string) ?? []), m[2] as string]);
    }
    for (const [base, letters] of bases)
      letters.sort().forEach((l, i) => {
        if (l !== String.fromCharCode(97 + i))
          errs.push(`section letters of ${base} have a gap before ${base}${l}`);
      });
  }
  const slugs = new Map<string, number>();
  for (const h of doc.headings) if (h.level <= 3) slugs.set(h.slug, (slugs.get(h.slug) ?? 0) + 1);
  for (const [s, c] of slugs) if (c > 1) errs.push(`two headings share the anchor #${s}`);
  doc.lines.forEach((l) => {
    for (const m of l.matchAll(/\]\(#([^)\s]+)\)/g))
      if (!slugs.has(m[1] as string)) errs.push(`the link #${m[1]} goes to no heading`);
    const f = /^!\[[^\]]*\]\(([^)\s]+)\)\s*$/.exec(l);
    if (f && !/^https?:/.test(f[1] as string) && !ctx.assetExists(f[1] as string))
      errs.push(`the figure ${f[1]} does not exist`);
  });
  if (doc.toc) {
    const now = doc.lines.slice(doc.toc.start, doc.toc.end + 1).join(doc.eol);
    if (now !== renderGuideToc(doc)) errs.push('the contents block does not match the headings');
  }
  return errs;
}

/**
 * Structure and link checks of an updated guide. Problems that were already in `before` are warnings, not errors.
 * `before = null` checks one file on its own.
 */
export function checkGuideUpdate(
  before: string | null,
  after: string,
  ctx: GuideCheckContext,
): { errors: string[]; warnings: string[] } {
  const a = parseGuide(after);
  const errors: string[] = [];
  const warnings: string[] = [];
  const old = before === null ? null : parseGuide(before);
  if (old) {
    const raws = a.headings.map((h) => h.raw);
    let k = 0;
    for (const h of old.headings) {
      while (k < raws.length && raws[k] !== h.raw) k++;
      if (k >= raws.length) {
        errors.push(`the heading "${h.raw}" was changed, moved or removed`);
        break;
      }
      k++;
    }
  }
  const was = new Set(old ? structural(old, ctx) : []);
  for (const e of structural(a, ctx)) (was.has(e) ? warnings : errors).push(e);

  const ranges = ctx.changedRanges ?? [];
  const wrote = ranges.flatMap(([s, e]) => a.lines.slice(s, e));
  const numbers = new Set(a.headings.filter((h) => h.number).map((h) => h.number as string));
  const chapters = new Set(
    a.headings.filter((h) => h.level === 2 && h.number).map((h) => h.number as string),
  );
  for (const l of wrote) {
    if (/^#{2,4} /.test(l)) continue;
    for (const m of l.matchAll(SECTION_REF))
      if (!numbers.has(m[1] as string))
        errors.push(`the text refers to section ${m[1]}, which does not exist`);
    for (const m of l.matchAll(/\bchapter (\d+)\b/gi))
      if (!chapters.has(m[1] as string))
        errors.push(`the text refers to chapter ${m[1]}, which does not exist`);
    for (const m of l.matchAll(/\/help\/([a-z0-9-]+)(?:#([a-z0-9-]+))?/g)) {
      if (!ctx.helpRef) warnings.push(`the Help link /help/${m[1]} could not be checked`);
      else if (!ctx.helpRef(m[1] as string, m[2] ?? null))
        errors.push(`the Help link /help/${m[1]}${m[2] ? `#${m[2]}` : ''} goes nowhere`);
    }
    for (const s of scrubGuideText(l, ctx.denyList)) errors.push(`the new text contains ${s}`);
  }
  const share = wrote.length / Math.max(1, a.lines.length);
  if (share > MAX_SHARE || (ctx.editedSections ?? 0) > MAX_EDITED || (ctx.addedSections ?? 0) > MAX_ADDED)
    errors.push(`the update would rewrite too much of the guide (${wrote.length} lines)`);
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

// ------------------------------------------------------------------------------------------- step input / output

/** `stepInput` of the 'guide' step (built by the server). */
export const ReleaseDocsPrepGuideInputSchema = z.object({
  guidePath: z.string().min(1).max(300).default(DEFAULT_GUIDE_PATH),
  /** Change ids (card:<KEY>, merge:<sha>, commit:<sha>) that earlier passed runs of this release dealt with. */
  coveredSources: z.array(z.string().max(80)).max(2000).default([]),
  denyList: z.array(z.string().max(100)).max(200).default([]),
});
export type ReleaseDocsPrepGuideInput = z.infer<typeof ReleaseDocsPrepGuideInputSchema>;

const cap = <T extends z.ZodTypeAny>(t: T) => z.array(t).max(50).default([]);

/** The stored output of the 'guide' step for one repository. */
export const ReleaseDocsPrepGuideOutputSchema = z.object({
  status: z.enum(['passed', 'failed']),
  skipped: z.literal('no user guide').optional(),
  nothing: z.string().max(200).optional(),
  changed: cap(
    z.object({ section: z.string().max(200), sources: z.array(z.string().max(80)).max(50).default([]) }),
  ),
  added: cap(
    z.object({
      section: z.string().max(200),
      after: z.string().max(200),
      sources: z.array(z.string().max(80)).max(50).default([]),
    }),
  ),
  covered: cap(z.object({ source: z.string().max(80), section: z.string().max(200) })),
  skippedChanges: cap(z.object({ source: z.string().max(80), reason: z.string().max(300) })),
  duplicates: z.number().int().nonnegative().default(0),
  pdf: z.enum(['rebuilt', 'no change', 'no PDF build']).default('no change'),
  errors: cap(z.string().max(500)),
  warnings: cap(z.string().max(500)),
  notes: cap(z.string().max(500)),
});
export type ReleaseDocsPrepGuideOutput = z.infer<typeof ReleaseDocsPrepGuideOutputSchema>;

/** Every change id the output says was dealt with (for the next run's `coveredSources`). */
export function guideOutputSources(output: unknown): string[] {
  const p = ReleaseDocsPrepGuideOutputSchema.safeParse(output);
  if (!p.success) return [];
  const o = p.data;
  return [
    ...o.changed.flatMap((c) => c.sources),
    ...o.added.flatMap((c) => c.sources),
    ...o.covered.map((c) => c.source),
    ...o.skippedChanges.map((c) => c.source),
  ];
}
