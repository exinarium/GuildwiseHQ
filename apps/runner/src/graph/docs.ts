import { sanitizeLabel } from './sanitize.ts';

/**
 * Markdown, deterministically (docs/design/project-graphs.md section 5, step 4): headings and links to files of the same
 * repository. No model reads a document here; the optional semantic pass of the design is not built.
 */
export interface MarkdownFacts {
  headings: Array<{ level: number; text: string; line: number }>;
  links: Array<{ target: string; line: number }>;
}

const MAX_HEADINGS = 400;
const MAX_LINKS = 400;

export function scanMarkdown(content: string): MarkdownFacts {
  const headings: MarkdownFacts['headings'] = [];
  const links: MarkdownFacts['links'] = [];
  const lines = content.split(/\r?\n/);
  let fence: string | null = null;
  let prev = '';
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as string;
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(raw);
    if (f) {
      const mark = (f[1] as string)[0] as string;
      if (fence === null) fence = mark;
      else if (fence === mark) fence = null;
      prev = '';
      continue;
    }
    if (fence !== null) continue;
    const atx = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw);
    if (atx && headings.length < MAX_HEADINGS) {
      const text = sanitizeLabel((atx[2] as string).replace(/[*_`[\]]/g, ''));
      if (text) headings.push({ level: (atx[1] as string).length, text, line: i + 1 });
    } else if (
      /^\s{0,3}(=+|-+)\s*$/.test(raw) &&
      prev.trim() &&
      !/^\s*([-*+]|\d+\.)\s/.test(prev) &&
      headings.length < MAX_HEADINGS
    ) {
      const text = sanitizeLabel(prev.replace(/[*_`[\]]/g, ''));
      if (text) headings.push({ level: raw.trim().startsWith('=') ? 1 : 2, text, line: i });
    }
    const re = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    for (let m = re.exec(raw); m; m = re.exec(raw)) {
      const t = (m[1] as string).split('#')[0]?.split('?')[0] ?? '';
      if (!t || /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('/') || t.startsWith('//')) continue;
      if (links.length < MAX_LINKS) links.push({ target: t, line: i + 1 });
    }
    prev = raw;
  }
  return { headings, links };
}

/** `Getting started` -> `getting-started`. */
export const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'section';
