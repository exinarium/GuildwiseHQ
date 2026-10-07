import { GLOSSARY } from './glossary.ts';
import { type Block, blockText, type Frontmatter, parseBlocks, parseFrontmatter } from './markdown.ts';

export interface Section {
  id: string;
  title: string;
  /** Plain text of the section (its sub-sections included), for search. */
  text: string;
}

export interface Article extends Frontmatter {
  slug: string;
  blocks: Block[];
  /** The `##` and `###` headings, for the contents list. */
  headings: Array<{ id: string; text: string; level: 2 | 3 }>;
  /** Plain text of the part before the first heading, then one entry per `##` section. */
  intro: string;
  sections: Section[];
}

/** Reserved by the help routes: an article may not use these slugs. */
export const RESERVED_SLUGS = ['contact', 'requests', 'glossary'];

// Bundled at build time: no request leaves the app (the CSP allows none).
const FILES = import.meta.glob('./articles/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export function buildArticle(slug: string, src: string): Article {
  const { meta, body } = parseFrontmatter(src);
  const blocks = parseBlocks(body);
  const headings = blocks.flatMap((b) => (b.t === 'h' ? [{ id: b.id, text: b.text, level: b.level }] : []));
  const sections: Section[] = [];
  const introParts: string[] = [];
  let cur: { id: string; title: string; parts: string[] } | null = null;
  for (const b of blocks) {
    if (b.t === 'h' && b.level === 2) {
      if (cur) sections.push({ id: cur.id, title: cur.title, text: cur.parts.join(' ') });
      cur = { id: b.id, title: b.text, parts: [] };
    } else if (cur) cur.parts.push(blockText(b));
    else introParts.push(blockText(b));
  }
  if (cur) sections.push({ id: cur.id, title: cur.title, text: cur.parts.join(' ') });
  return { ...meta, slug, blocks, headings, intro: introParts.join(' '), sections };
}

export const ARTICLES: Article[] = Object.entries(FILES)
  .map(([path, src]) => buildArticle(/([^/]+)\.md$/.exec(path)?.[1] ?? path, src))
  .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));

export const articleBySlug = (slug: string): Article | undefined => ARTICLES.find((a) => a.slug === slug);

/** The Help centre of the current area: platform administrators have their own, outside the work shell. */
export const helpBase = (pathname: string): string =>
  pathname.startsWith('/platform') ? '/platform/help' : '/help';

/** `slug` or `slug#anchor` to a path under the help base. */
export const helpPath = (ref: string, base = '/help'): string => `${base}/${ref}`;

export interface SearchHit {
  kind: 'article' | 'glossary';
  /** Path to open, anchor included. */
  to: string;
  title: string;
  /** The section (or the article for a glossary term) the hit is in. */
  where: string;
  snippet: string;
  score: number;
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

function snippetOf(text: string, words: string[]): string {
  const low = norm(text);
  const at = Math.min(...words.map((w) => low.indexOf(w)).filter((i) => i >= 0), Number.MAX_SAFE_INTEGER);
  if (at === Number.MAX_SAFE_INTEGER) return text.slice(0, 140);
  const start = Math.max(0, at - 50);
  const end = Math.min(text.length, at + 110);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

/** Client-side search over the articles and the glossary. Every word must match somewhere in the entry. */
export function searchHelp(query: string, articles: Article[] = ARTICLES): SearchHit[] {
  const words = norm(query)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) return [];
  const hits: SearchHit[] = [];
  const score = (parts: Array<{ text: string; weight: number }>): number | null => {
    let total = 0;
    for (const w of words) {
      let best = 0;
      for (const p of parts) {
        const t = norm(p.text);
        const i = t.indexOf(w);
        if (i < 0) continue;
        const wordStart = i === 0 || !/[a-z0-9]/.test(t[i - 1] as string);
        best += p.weight * (wordStart ? 1 : 0.5) + Math.min(3, t.split(w).length - 2);
      }
      if (best === 0) return null;
      total += best;
    }
    return total;
  };
  for (const a of articles) {
    const head = score([
      { text: a.title, weight: 12 },
      { text: a.keywords.join(' '), weight: 8 },
      { text: a.summary, weight: 4 },
      { text: a.intro, weight: 1 },
    ]);
    if (head !== null)
      hits.push({
        kind: 'article',
        to: helpPath(a.slug),
        title: a.title,
        where: 'Article',
        snippet: a.summary || snippetOf(a.intro, words),
        score: head + 5,
      });
    for (const s of a.sections) {
      const sc = score([
        { text: s.title, weight: 9 },
        { text: s.text, weight: 1 },
        { text: `${a.title} ${a.keywords.join(' ')}`, weight: 1 },
      ]);
      if (sc !== null)
        hits.push({
          kind: 'article',
          to: helpPath(`${a.slug}#${s.id}`),
          title: s.title,
          where: a.title,
          snippet: snippetOf(s.text || s.title, words),
          score: sc,
        });
    }
  }
  for (const g of GLOSSARY) {
    const sc = score([
      { text: g.term, weight: 14 },
      { text: (g.aka ?? []).join(' '), weight: 8 },
      { text: g.definition, weight: 2 },
    ]);
    if (sc !== null)
      hits.push({
        kind: 'glossary',
        to: `/help/glossary#${glossaryId(g.term)}`,
        title: g.term,
        where: 'Glossary',
        snippet: g.definition,
        score: sc + 3,
      });
  }
  return hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, 30);
}

export const glossaryId = (term: string): string => `term-${norm(term).replace(/[^a-z0-9]+/g, '-')}`;
