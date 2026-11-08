import { z } from 'zod';
import { guideWords, pathWords, scrubGuideText } from './user-guide.ts';

/**
 * The in-app Help articles (`apps/web/src/help/articles/*.md`) for the 'Update Help articles' release prep step: a parser
 * that finds the same headings and anchors as the app's reader (`apps/web/src/help/markdown.ts`), whole-or-nothing
 * section edits addressed by article slug and anchor id, and the checks that keep every anchor and article header intact.
 * Pure: no I/O.
 */

export const DEFAULT_HELP_DIR = 'apps/web/src/help/articles';

// ------------------------------------------------------------------------------------------------------- parse

export interface HelpHeading {
  /** Line index in the whole file. */
  line: number;
  level: 2 | 3;
  raw: string;
  text: string;
  explicitId: string | null;
  /** The id the app gives the heading (explicit, else the slug; a repeat gets -2, -3). */
  id: string;
}

export interface HelpSection {
  heading: HelpHeading;
  bodyStart: number;
  /** The next `##` or `###` heading, or the end of the file. */
  end: number;
}

export interface HelpArticleDoc {
  lines: string[];
  eol: '\n' | '\r\n';
  finalEol: boolean;
  /** Line indexes of the two `---` lines. */
  frontmatter: { start: number; end: number } | null;
  meta: { title?: string; summary?: string; keywords?: string; order?: string };
  headings: HelpHeading[];
  sections: HelpSection[];
}

/** The same as the app's `slugify` (apps/web/src/help/markdown.ts). */
export const helpSlugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section';

/** The app's heading rule (apps/web/src/help/markdown.ts). */
const HEADING = /^(#{2,3})\s+(.*?)(?:\s*\{#([a-z0-9-]+)\})?\s*$/;
/** The app's frontmatter rule. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const FENCE = /^```/;

export function parseHelpArticle(md: string): HelpArticleDoc {
  const eol: '\n' | '\r\n' = md.includes('\r\n') ? '\r\n' : '\n';
  const finalEol = md.endsWith('\n');
  const lines = md.split(/\r?\n/);
  if (finalEol) lines.pop();
  const meta: HelpArticleDoc['meta'] = {};
  let frontmatter: HelpArticleDoc['frontmatter'] = null;
  let bodyStart = 0;
  const m = FRONTMATTER.exec(md);
  if (m) {
    const end = m[0].replace(/\r?\n$/, '').split('\n').length - 1;
    frontmatter = { start: 0, end };
    bodyStart = end + 1;
    for (const line of (m[1] ?? '').split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i <= 0) continue;
      const key = line.slice(0, i).trim();
      if (key === 'title' || key === 'summary' || key === 'keywords' || key === 'order')
        meta[key] = line.slice(i + 1).trim();
    }
  }
  const headings: HelpHeading[] = [];
  const used = new Set<string>();
  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i] as string;
    if (FENCE.test(line)) {
      i++;
      while (i < lines.length && !FENCE.test(lines[i] as string)) i++;
      continue;
    }
    const h = HEADING.exec(line);
    if (!h) continue;
    const text = h[2] as string;
    const base = h[3] ?? helpSlugify(text);
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    headings.push({
      line: i,
      level: (h[1] as string).length as 2 | 3,
      raw: line,
      text,
      explicitId: h[3] ?? null,
      id,
    });
  }
  const sections = headings.map((heading, k) => ({
    heading,
    bodyStart: heading.line + 1,
    end: headings[k + 1]?.line ?? lines.length,
  }));
  return { lines, eol, finalEol, frontmatter, meta, headings, sections };
}

const serialize = (doc: Pick<HelpArticleDoc, 'eol' | 'finalEol'>, lines: string[]): string =>
  lines.join(doc.eol) + (doc.finalEol ? doc.eol : '');

// ------------------------------------------------------------------------------------------------------- edits

const Slug = z
  .string()
  .regex(/^[a-z0-9-]+$/)
  .max(80);
const Id = z
  .string()
  .regex(/^[a-z0-9-]+$/)
  .max(80);
const sources = z.array(z.string().max(80)).max(50).default([]);

/** One edit of the writer's proposal. `article` is a slug, never a path: a write outside the folder cannot be expressed. */
export const HelpEditSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('replace_text'),
    article: Slug,
    section: Id,
    find: z.string().min(1).max(4000),
    replace: z.string().max(4000),
    sources,
  }),
  z.object({
    op: z.literal('append'),
    article: Slug,
    section: Id,
    text: z.string().min(1).max(6000),
    sources,
  }),
  z.object({
    op: z.literal('add_section'),
    article: Slug,
    after: Id,
    title: z.string().min(1).max(120),
    id: Id,
    level: z.union([z.literal(2), z.literal(3)]).optional(),
    body: z.string().min(1).max(8000),
    sources,
  }),
]);
export type HelpEdit = z.infer<typeof HelpEditSchema>;

/** What the writer returns (the JSON file). */
export const HelpProposalSchema = z.object({
  edits: z.array(HelpEditSchema).max(30).default([]),
  covered: z
    .array(z.object({ source: z.string().max(80), article: Slug, section: Id }))
    .max(500)
    .default([]),
  skipped: z
    .array(z.object({ source: z.string().max(80), reason: z.string().max(300) }))
    .max(500)
    .default([]),
  notes: z.array(z.string().max(500)).max(50).default([]),
});
export type HelpProposal = z.infer<typeof HelpProposalSchema>;

export type ApplyHelpOutcome =
  | {
      kind: 'changed';
      /** Only the articles that changed (slug to new content). */
      files: Record<string, string>;
      changed: Array<{ article: string; section: string }>;
      added: Array<{ article: string; section: string; after: string }>;
      duplicates: HelpEdit[];
      /** Per changed article: line ranges [start, end) of the result that this update wrote. */
      written: Record<string, Array<[number, number]>>;
    }
  | { kind: 'unchanged'; duplicates: HelpEdit[] }
  | { kind: 'error'; errors: string[] };

/** Rules of written text: no headings, anchors, header lines, comments or fences. */
function helpTextErrors(what: string, text: string, allowH4: boolean): string[] {
  const errs: string[] = [];
  for (const l of text.split(/\r?\n/)) {
    if (/^#{1,3}( |$)/.test(l) || (!allowH4 && /^#{4}( |$)/.test(l)))
      errs.push(`${what}: a heading line is not allowed here (${JSON.stringify(l.slice(0, 60))})`);
    if (l.includes('{#')) errs.push(`${what}: anchors ({#...}) are not allowed in the text`);
    if (/^---\s*$/.test(l)) errs.push(`${what}: a '---' line is not allowed`);
    if (l.includes('<!--')) errs.push(`${what}: HTML comments are not allowed`);
    if (/^\s*```/.test(l)) errs.push(`${what}: fenced blocks are not allowed`);
  }
  return errs;
}

const splitText = (t: string): string[] => t.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');

const occurrences = (hay: string, needle: string): number => {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
};

/** Trailing blank lines of a body, kept after the new text so the next heading keeps its spacing. */
function splitTrailing(body: string[]): [string[], string[]] {
  let k = body.length;
  while (k > 0 && !(body[k - 1] as string).trim()) k--;
  return [body.slice(0, k), body.slice(k)];
}

/**
 * Applies the edits. An edit already present is a duplicate (a second run changes nothing). Any invalid edit fails the
 * whole update; nothing is half applied. Heading lines and article headers are never rewritten.
 */
export function applyHelpEdits(files: Record<string, string>, edits: readonly HelpEdit[]): ApplyHelpOutcome {
  const errors: string[] = [];
  const duplicates: HelpEdit[] = [];
  const docs = new Map<string, HelpArticleDoc>();
  const docOf = (slug: string): HelpArticleDoc | null => {
    if (!Object.hasOwn(files, slug)) return null;
    let d = docs.get(slug);
    if (!d) {
      d = parseHelpArticle(files[slug] as string);
      docs.set(slug, d);
    }
    return d;
  };
  /** Per article: section heading line -> edited body. */
  const bodies = new Map<string, Map<number, string[]>>();
  /** Per article: original line index -> new lines inserted before it. */
  const inserts = new Map<string, Map<number, string[][]>>();
  const newIds = new Map<string, Set<string>>();
  const changed: Array<{ article: string; section: string }> = [];
  const added: Array<{ article: string; section: string; after: string }> = [];

  edits.forEach((e, i) => {
    const what = `edit ${i + 1} (${e.op})`;
    const doc = docOf(e.article);
    if (!doc) return void errors.push(`${what}: unknown article "${e.article}"`);
    const ref = e.op === 'add_section' ? e.after : e.section;
    const s = doc.sections.find((x) => x.heading.id === ref);
    if (!s) return void errors.push(`${what}: unknown section "${e.article}#${ref}"`);
    const artBodies = bodies.get(e.article) ?? new Map<number, string[]>();
    bodies.set(e.article, artBodies);
    const bodyNow = artBodies.get(s.heading.line) ?? doc.lines.slice(s.bodyStart, s.end);
    if (e.op === 'replace_text') {
      const errs = helpTextErrors(what, e.replace, false);
      if (errs.length) return void errors.push(...errs);
      const text = bodyNow.join('\n');
      const find = e.find.replace(/\r\n/g, '\n');
      const replace = e.replace.replace(/\r\n/g, '\n');
      const n = occurrences(text, find);
      if (n === 0) {
        if (replace && text.includes(replace)) return void duplicates.push(e);
        return void errors.push(`${what}: the text to find is not in ${e.article}#${ref}`);
      }
      if (n > 1) return void errors.push(`${what}: the text to find occurs ${n} times in ${e.article}#${ref}`);
      artBodies.set(s.heading.line, text.replace(find, () => replace).split('\n'));
      if (!changed.some((c) => c.article === e.article && c.section === ref))
        changed.push({ article: e.article, section: ref });
      return;
    }
    if (e.op === 'append') {
      const errs = helpTextErrors(what, e.text, false);
      if (errs.length) return void errors.push(...errs);
      const add = splitText(e.text.trim());
      if (bodyNow.join('\n').includes(add.join('\n'))) return void duplicates.push(e);
      const [core, trailing] = splitTrailing(bodyNow);
      const lead = core.length ? [''] : trailing.length ? [] : [''];
      artBodies.set(s.heading.line, [...core, ...lead, ...add, ...(trailing.length ? trailing : [''])]);
      if (!changed.some((c) => c.article === e.article && c.section === ref))
        changed.push({ article: e.article, section: ref });
      return;
    }
    // add_section
    const title = e.title.trim();
    if (/[\r\n]/.test(e.title) || title.includes('#') || title.includes('{') || !title)
      return void errors.push(`${what}: the title must be one line of text`);
    const errs = helpTextErrors(what, e.body, true);
    if (errs.length) return void errors.push(...errs);
    const existing = doc.headings.find((h) => h.id === e.id);
    if (existing) {
      if (existing.explicitId === e.id && existing.text.trim() === title) return void duplicates.push(e);
      return void errors.push(`${what}: the id "${e.id}" is already used in ${e.article}`);
    }
    const ids = newIds.get(e.article) ?? new Set<string>();
    if (ids.has(e.id)) return void errors.push(`${what}: the id "${e.id}" is already used in ${e.article}`);
    ids.add(e.id);
    newIds.set(e.article, ids);
    const level = e.level ?? s.heading.level;
    let pos = s.end;
    if (level === 2) {
      // a new chapter goes after the last ### child of the section it follows
      const k = doc.sections.indexOf(s);
      for (let j = k + 1; j < doc.sections.length; j++) {
        const next = doc.sections[j] as HelpSection;
        if (next.heading.level === 2) break;
        pos = next.end;
      }
    }
    const block = [`${'#'.repeat(level)} ${title} {#${e.id}}`, '', ...splitText(e.body.trim()), ''];
    const artInserts = inserts.get(e.article) ?? new Map<number, string[][]>();
    artInserts.set(pos, [...(artInserts.get(pos) ?? []), block]);
    inserts.set(e.article, artInserts);
    added.push({ article: e.article, section: e.id, after: ref });
  });
  if (errors.length > 0) return { kind: 'error', errors };
  if (changed.length === 0 && added.length === 0) return { kind: 'unchanged', duplicates };

  const out: Record<string, string> = {};
  const written: Record<string, Array<[number, number]>> = {};
  for (const [slug, doc] of docs) {
    const artBodies = bodies.get(slug) ?? new Map<number, string[]>();
    const artInserts = inserts.get(slug) ?? new Map<number, string[][]>();
    if (artBodies.size === 0 && artInserts.size === 0) continue;
    const res: string[] = [];
    const ranges: Array<[number, number]> = [];
    const bySection = new Map(doc.sections.map((s) => [s.heading.line, s]));
    let i = 0;
    while (i <= doc.lines.length) {
      for (const block of artInserts.get(i) ?? []) {
        const b = [...block];
        if (i === doc.lines.length) {
          // at the end of the file: one blank line before the heading, none after the body
          if (res.length && (res[res.length - 1] as string).trim()) b.unshift('');
          while (b.length && !(b[b.length - 1] as string).trim()) b.pop();
        }
        ranges.push([res.length, res.length + b.length]);
        res.push(...b);
      }
      if (i === doc.lines.length) break;
      const s = bySection.get(i);
      const body = s ? artBodies.get(i) : undefined;
      if (s && body) {
        res.push(doc.lines[i] as string);
        ranges.push([res.length, res.length + body.length]);
        res.push(...body);
        i = s.end;
        continue;
      }
      res.push(doc.lines[i] as string);
      i++;
    }
    // self-check: every heading line of the input is still there, in order
    let k = 0;
    for (const h of doc.headings) {
      while (k < res.length && res[k] !== h.raw) k++;
      if (k >= res.length) return { kind: 'error', errors: [`the update lost the heading "${h.raw}" in ${slug}`] };
      k++;
    }
    const md = serialize(doc, res);
    if (md === files[slug]) continue;
    out[slug] = md;
    written[slug] = ranges.filter(([a, b]) => b > a);
  }
  if (Object.keys(out).length === 0) return { kind: 'unchanged', duplicates };
  return { kind: 'changed', files: out, changed, added, duplicates, written };
}

// ------------------------------------------------------------------------------------------------------- checks

export interface HelpCheckContext {
  /** Per article: lines of `after` written by this update; the link and text checks look only at these. */
  changedRanges?: Record<string, Array<[number, number]>>;
  editedSections?: number;
  addedSections?: number;
  denyList?: readonly string[];
}

const MAX_EDITED = 8;
const MAX_ADDED = 4;
const MAX_SHARE = 0.4;

function articleStructure(slug: string, doc: HelpArticleDoc): string[] {
  const errs: string[] = [];
  if (!doc.frontmatter || doc.meta.title === undefined || doc.meta.order === undefined)
    errs.push(`the header of ${slug} is no longer valid`);
  const seen = new Map<string, number>();
  for (const h of doc.headings)
    if (h.explicitId) seen.set(h.explicitId, (seen.get(h.explicitId) ?? 0) + 1);
  for (const [id, n] of seen) if (n > 1) errs.push(`two headings in ${slug} share the anchor #${id}`);
  return errs;
}

/**
 * Checks an update of the Help articles (slug to content). Problems already in `before` are warnings, not errors.
 * `before = null` checks the articles on their own.
 */
export function checkHelpUpdate(
  before: Record<string, string> | null,
  after: Record<string, string>,
  ctx: HelpCheckContext = {},
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const docs = new Map(Object.entries(after).map(([slug, md]) => [slug, parseHelpArticle(md)]));
  if (before) {
    for (const slug of Object.keys(before))
      if (!Object.hasOwn(after, slug)) errors.push(`the article ${slug} would be removed`);
    for (const slug of Object.keys(after))
      if (!Object.hasOwn(before, slug)) errors.push(`the update would create the article ${slug}`);
  }
  let written = 0;
  for (const [slug, a] of docs) {
    const oldMd = before?.[slug];
    const old = oldMd === undefined ? null : parseHelpArticle(oldMd);
    if (old && oldMd === after[slug]) {
      for (const e of articleStructure(slug, a)) warnings.push(e);
      continue;
    }
    const was = new Set(old ? articleStructure(slug, old) : []);
    for (const e of articleStructure(slug, a)) (was.has(e) ? warnings : errors).push(e);
    if (old) {
      const head = (d: HelpArticleDoc) =>
        d.frontmatter ? d.lines.slice(d.frontmatter.start, d.frontmatter.end + 1).join('\n') : null;
      if (head(old) !== head(a)) errors.push(`the header of ${slug} was changed`);
      // every heading of before is still there, in order, with the same effective id
      const matched = new Set<number>();
      let k = 0;
      for (const h of old.headings) {
        let j = k;
        while (j < a.headings.length && (a.headings[j] as HelpHeading).raw !== h.raw) j++;
        if (j >= a.headings.length) {
          errors.push(`the anchor ${slug}#${h.id} would be removed or renamed`);
          continue;
        }
        const now = a.headings[j] as HelpHeading;
        if (now.id !== h.id) errors.push(`the anchor ${slug}#${h.id} would be removed or renamed`);
        matched.add(j);
        k = j + 1;
      }
      a.headings.forEach((h, j) => {
        if (!matched.has(j) && !h.explicitId) errors.push(`the new section "${h.text}" in ${slug} has no anchor`);
      });
    }
    const ranges = ctx.changedRanges?.[slug] ?? [];
    const wrote = ranges.flatMap(([s, e]) => a.lines.slice(s, e));
    written += wrote.length;
    if (old && wrote.length / Math.max(1, a.lines.length) > MAX_SHARE)
      errors.push(`the update would rewrite too much of ${slug} (${wrote.length} lines)`);
    const ids = new Set(a.headings.map((h) => h.id));
    for (const l of wrote) {
      if (HEADING.test(l)) continue;
      for (const m of l.matchAll(/\/help\/([a-z0-9-]+)(?:#([a-z0-9-]+))?/g)) {
        const target = docs.get(m[1] as string);
        if (!target || (m[2] && !target.headings.some((h) => h.id === m[2])))
          errors.push(`the Help link /help/${m[1]}${m[2] ? `#${m[2]}` : ''} goes nowhere`);
      }
      for (const m of l.matchAll(/\]\(#([a-z0-9-]+)\)/g))
        if (!ids.has(m[1] as string)) errors.push(`the link #${m[1]} in ${slug} goes to no heading`);
      for (const s of scrubGuideText(l, ctx.denyList)) errors.push(`the new text contains ${s}`);
    }
  }
  if ((ctx.editedSections ?? 0) > MAX_EDITED || (ctx.addedSections ?? 0) > MAX_ADDED)
    errors.push(`the update would rewrite too much of the Help articles (${written} lines)`);
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

// ------------------------------------------------------------------------------------------------------- locate

/** Ranked Help sections that describe a feature. A hint for the writer, not a gate. */
export function locateHelpSections(
  docs: Record<string, HelpArticleDoc>,
  feature: { title: string; areas?: string[]; files?: string[]; routes?: string[] },
): Array<{ article: string; section: string; score: number; why: string }> {
  const words = new Set([
    ...guideWords(feature.title),
    ...(feature.areas ?? []).flatMap(pathWords),
    ...(feature.files ?? []).flatMap(pathWords),
  ]);
  const routes = new Set((feature.routes ?? []).map((r) => r.toLowerCase()));
  const scores = new Map<string, { article: string; section: string; score: number; why: Set<string> }>();
  const bump = (article: string, section: string, n: number, why: string): void => {
    const key = `${article}#${section}`;
    const e = scores.get(key) ?? { article, section, score: 0, why: new Set<string>() };
    e.score += n;
    e.why.add(why);
    scores.set(key, e);
  };
  const hits = (text: string): string[] => [...new Set(guideWords(text).filter((w) => words.has(w)))];
  for (const [slug, doc] of Object.entries(docs)) {
    const metaHit = hits([doc.meta.title, doc.meta.summary, doc.meta.keywords].filter(Boolean).join(' '));
    for (const s of doc.sections) {
      if (metaHit.length) bump(slug, s.heading.id, 2 * metaHit.length, `article: ${metaHit.join(', ')}`);
      const h = hits(s.heading.text);
      if (h.length) bump(slug, s.heading.id, 3 * h.length, `heading: ${h.join(', ')}`);
      const body = doc.lines.slice(s.bodyStart, s.end).join('\n');
      const lab = hits([...body.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1]).join(' '));
      if (lab.length) bump(slug, s.heading.id, lab.length, `labels: ${lab.join(', ')}`);
      const rts = [
        ...new Set(
          [...body.matchAll(/`(\/[a-z0-9/_-]+)/gi)]
            .map((m) => (m[1] as string).toLowerCase())
            .filter((r) => routes.has(r)),
        ),
      ];
      if (rts.length) bump(slug, s.heading.id, 2 * rts.length, `routes: ${rts.join(', ')}`);
    }
  }
  // the article words alone do not make a hint: a section needs its own match
  return [...scores.values()]
    .filter((e) => [...e.why].some((w) => !w.startsWith('article:')))
    .map((e) => ({ article: e.article, section: e.section, score: e.score, why: [...e.why].join('; ') }))
    .sort(
      (a, b) =>
        b.score - a.score || a.article.localeCompare(b.article) || a.section.localeCompare(b.section),
    );
}

// ------------------------------------------------------------------------------------------- step input / output

/** `stepInput` of the 'help' step (built by the server). */
export const ReleaseDocsPrepHelpInputSchema = z.object({
  helpDir: z.string().min(1).max(300).default(DEFAULT_HELP_DIR),
  /** Change ids that earlier passed runs of this release dealt with in the Help articles. */
  coveredSources: z.array(z.string().max(80)).max(2000).default([]),
  denyList: z.array(z.string().max(100)).max(200).default([]),
});
export type ReleaseDocsPrepHelpInput = z.infer<typeof ReleaseDocsPrepHelpInputSchema>;

const cap = <T extends z.ZodTypeAny>(t: T) => z.array(t).max(50).default([]);
const outSources = z.array(z.string().max(80)).max(50).default([]);

/** The stored output of the 'help' step for one repository. */
export const ReleaseDocsPrepHelpOutputSchema = z.object({
  status: z.enum(['passed', 'failed']),
  skipped: z.literal('no help articles').optional(),
  nothing: z.string().max(200).optional(),
  changed: cap(
    z.object({
      article: z.string().max(80),
      title: z.string().max(200),
      section: z.string().max(80),
      heading: z.string().max(200),
      sources: outSources,
    }),
  ),
  added: cap(
    z.object({
      article: z.string().max(80),
      title: z.string().max(200),
      section: z.string().max(80),
      heading: z.string().max(200),
      after: z.string().max(80),
      sources: outSources,
    }),
  ),
  covered: cap(z.object({ source: z.string().max(80), article: z.string().max(80), section: z.string().max(80) })),
  skippedChanges: cap(z.object({ source: z.string().max(80), reason: z.string().max(300) })),
  duplicates: z.number().int().nonnegative().default(0),
  errors: cap(z.string().max(500)),
  warnings: cap(z.string().max(500)),
  notes: cap(z.string().max(500)),
});
export type ReleaseDocsPrepHelpOutput = z.infer<typeof ReleaseDocsPrepHelpOutputSchema>;

/** Every change id the output says was dealt with (for the next run's `coveredSources`). */
export function helpOutputSources(output: unknown): string[] {
  const p = ReleaseDocsPrepHelpOutputSchema.safeParse(output);
  if (!p.success) return [];
  const o = p.data;
  return [
    ...o.changed.flatMap((c) => c.sources),
    ...o.added.flatMap((c) => c.sources),
    ...o.covered.map((c) => c.source),
    ...o.skippedChanges.map((c) => c.source),
  ];
}
