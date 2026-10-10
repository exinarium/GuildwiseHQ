import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The knowledge pack of the public landing-page assistant (docs/design/ai-assistant.md, section 2.1): the curated
 * product facts plus a condensed outline of every help article (title, summary and the first paragraph of each
 * section). It is built from files in the repository and committed (`src/assistant/pack/public-pack.md`), so the
 * model's cached prefix is byte-for-byte the same between deploys unless a source changed. A test regenerates it and
 * fails when the committed copy is stale: run `pnpm --filter @aom/server assistant:pack`.
 */

const here = dirname(fileURLToPath(import.meta.url));
/** The repository root when running from the source tree. */
export const REPO_ROOT = join(here, '..', '..', '..', '..');
export const PACK_FILE = join(here, 'pack', 'public-pack.md');

/** Longest paragraph kept per section: the pack is an outline, the full articles are in the app. */
const SECTION_CHARS = 320;

interface Article {
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

/** The pack text for a repository checkout at `root`. Deterministic: sorted inputs, LF line ends, no dates. */
export function buildPublicPack(root: string = REPO_ROOT): string {
  const factsRaw = readFileSync(join(root, 'docs', 'assistant', 'product-facts.md'), 'utf8')
    .replace(/\r\n?/g, '\n')
    .trim();
  // Maintainer notes sit above the first section; the model gets only the facts.
  const facts = factsRaw.slice(Math.max(0, factsRaw.indexOf('\n## ') + 1));
  const dir = join(root, 'apps', 'web', 'src', 'help', 'articles');
  const articles = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => parseArticle(f.replace(/\.md$/, ''), readFileSync(join(dir, f), 'utf8')))
    .sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
  const outline = articles
    .map((a) =>
      [
        `### ${a.title}`,
        a.summary,
        ...a.sections.map((s) => `- ${s.heading}${s.text ? `: ${s.text}` : ''}`),
      ].join('\n'),
    )
    .join('\n\n');
  return `<product_facts>\n${facts}\n</product_facts>\n\n<help_outline>\nAn outline of the in-app help articles, to answer how things work. Do not quote it as a manual.\n\n${outline}\n</help_outline>\n`;
}
