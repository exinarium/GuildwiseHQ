import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The knowledge of the public landing-page assistant (docs/design/ai-assistant.md, section 2.1), split by topic (R3c): a small
 * always-on index (the curated product facts and one line per help topic) in the cached system prompt, and one chunk per help
 * article (title, summary and the first paragraph of each section) that `topics.ts` picks per question and attaches to the
 * newest visitor message, within a per-request token budget. Built from files in the repository and committed
 * (`src/assistant/pack/index.md`, `pack/topics/<slug>.md`), so the cached prefix is byte-for-byte the same between deploys
 * unless a source changed. A test regenerates them and fails when the committed copy is stale:
 * run `pnpm --filter @aom/server assistant:pack`.
 */

const here = dirname(fileURLToPath(import.meta.url));
/** The repository root when running from the source tree. */
export const REPO_ROOT = join(here, '..', '..', '..', '..');
export const PACK_DIR = join(here, 'pack');
/** The always-on part: the curated product facts and the index of help topics. */
export const INDEX_FILE = join(PACK_DIR, 'index.md');
/** One file per help article, loaded on demand (`topics/<slug>.md`). */
export const TOPICS_DIR = join(PACK_DIR, 'topics');

/** Longest paragraph kept per section: the pack is an outline, the full articles are in the app. */
const SECTION_CHARS = 290;

export interface Article {
  slug: string;
  title: string;
  summary: string;
  order: number;
  sections: Array<{ heading: string; text: string }>;
}

const clean = (s: string): string =>
  s
    .replace(/\r\n?/g, '\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();

function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return `${(end > n * 0.5 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '')).trim()}…`;
}

export function parseArticle(slug: string, raw: string): Article {
  const text = raw.replace(/\r\n?/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  const fm = m?.[1] ?? '';
  const body = m?.[2] ?? text;
  const field = (k: string): string => new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(fm)?.[1]?.trim() ?? '';
  const sections: Article['sections'] = [];
  let cur: { heading: string; lines: string[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const para = cur.lines
      .join('\n')
      .split(/\n\s*\n/)
      .map(clean)
      .find((p) => p.length > 0);
    sections.push({ heading: cur.heading, text: clip(para ?? '', SECTION_CHARS) });
  };
  for (const line of body.split('\n')) {
    const h = /^##\s+(.*?)(?:\s*\{#[^}]*\})?\s*$/.exec(line);
    if (h) {
      flush();
      cur = { heading: clean(h[1] ?? ''), lines: [] };
    } else cur?.lines.push(line);
  }
  flush();
  return {
    slug,
    title: field('title') || slug,
    summary: field('summary'),
    order: Number(field('order')) || 999,
    sections,
  };
}

/**
 * Whether the repository is public. While false, the facts say the code is being released at launch and give no repository
 * address. It is true now that the repository is public; flip it and rebuild the pack (`assistant:pack`); `--open-source-live` builds it for one run.
 */
export const OPEN_SOURCE_LIVE = true;

/** Keeps `{{#oss}}..{{/oss}}` when live and `{{^oss}}..{{/oss}}` when not. */
export function applyOpenSource(text: string, live: boolean): string {
  return text
    .replace(/\{\{#oss\}\}([\s\S]*?)\{\{\/oss\}\}/g, (_m, t: string) => (live ? t : ''))
    .replace(/\{\{\^oss\}\}([\s\S]*?)\{\{\/oss\}\}/g, (_m, t: string) => (live ? '' : t));
}

/** The product facts without the maintainer notes above the first section. */
function productFacts(root: string, live: boolean): string {
  const factsRaw = readFileSync(join(root, 'docs', 'assistant', 'product-facts.md'), 'utf8')
    .replace(/\r\n?/g, '\n')
    .trim();
  return applyOpenSource(factsRaw.slice(Math.max(0, factsRaw.indexOf('\n## ') + 1)), live);
}

/** The help articles, in reading order. */
export function readArticles(root: string = REPO_ROOT): Article[] {
  // The in-app help articles, then topics only the assistant has (docs/assistant/topics/*.md: hosted pricing and the like,
  // which a self-hosted server's Help centre must not show).
  const dirs = [
    join(root, 'apps', 'web', 'src', 'help', 'articles'),
    join(root, 'docs', 'assistant', 'topics'),
  ];
  return dirs
    .flatMap((dir) =>
      readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .map((f) => parseArticle(f.replace(/\.md$/, ''), readFileSync(join(dir, f), 'utf8'))),
    )
    .sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
}

const SUMMARY_IN_INDEX = 140;

/**
 * The always-on text: the facts and the topic index (slug, title, a clipped summary). Deterministic: sorted inputs, LF line ends,
 * no dates. The model sees the topics it could be given in full and can say what it does not know.
 */
export function buildIndexPack(root: string = REPO_ROOT, live: boolean = OPEN_SOURCE_LIVE): string {
  const topics = readArticles(root)
    .map((a) => `- ${a.title}${a.summary ? `: ${clip(a.summary, SUMMARY_IN_INDEX)}` : ''}`)
    .join('\n');
  return `<product_facts>\n${productFacts(root, live)}\n</product_facts>\n\n<help_topics>\nThe in-app help articles. The ones that match the visitor's question are attached to their message as <relevant_help>; do not quote them as a manual.\n\n${topics}\n</help_topics>\n`;
}

/** One chunk per article: what is attached to the visitor's message when the article matches the question. */
export function buildTopicChunk(a: Article): string {
  return [
    `### ${a.title}`,
    a.summary,
    ...a.sections.map((s) => `- ${s.heading}${s.text ? `: ${s.text}` : ''}`),
  ]
    .filter((l) => l !== '')
    .join('\n')
    .concat('\n');
}

/** `{ 'topics/<slug>.md': text }` for every article. */
export function buildTopicFiles(root: string = REPO_ROOT): Record<string, string> {
  return Object.fromEntries(readArticles(root).map((a) => [`${a.slug}.md`, buildTopicChunk(a)]));
}
