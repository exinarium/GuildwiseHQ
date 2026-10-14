/** A small markdown reader for the help articles: headings with {#anchors}, paragraphs, lists, quotes, code, inline marks. */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] };

export type Block =
  | { t: 'h'; level: 2 | 3; id: string; text: string }
  | { t: 'p'; c: Inline[] }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'ol'; items: Inline[][] }
  | { t: 'quote'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][] };

export interface Frontmatter {
  title: string;
  summary: string;
  keywords: string[];
  order: number;
}

export const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section';

export function parseFrontmatter(src: string): { meta: Frontmatter; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  const raw: Record<string, string> = {};
  for (const line of (m?.[1] ?? '').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) raw[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const list = (raw.keywords ?? '')
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  return {
    meta: {
      title: raw.title ?? 'Untitled',
      summary: raw.summary ?? '',
      keywords: list,
      order: Number.parseInt(raw.order ?? '999', 10) || 999,
    },
    body: m ? src.slice(m[0].length) : src,
  };
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))/;

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let rest = s;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push({ t: 'text', v: rest });
      break;
    }
    if (m.index > 0) out.push({ t: 'text', v: rest.slice(0, m.index) });
    const tok = m[0];
    if (tok.startsWith('`')) out.push({ t: 'code', v: tok.slice(1, -1) });
    else if (tok.startsWith('**')) out.push({ t: 'strong', c: parseInline(tok.slice(2, -2)) });
    else if (tok.startsWith('*')) out.push({ t: 'em', c: parseInline(tok.slice(1, -1)) });
    else {
      const l = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
      if (l) out.push({ t: 'link', href: l[2] as string, c: parseInline(l[1] as string) });
    }
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}

export const inlineText = (c: Inline[]): string =>
  c.map((i) => (i.t === 'text' || i.t === 'code' ? i.v : inlineText(i.c))).join('');

export function parseBlocks(body: string): Block[] {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  const used = new Set<string>();
  let i = 0;
  const para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ t: 'p', c: parseInline(para.join(' ')) });
    para.length = 0;
  };
  while (i < lines.length) {
    const line = lines[i] as string;
    if (/^```/.test(line)) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i] as string)) code.push(lines[i++] as string);
      i++;
      blocks.push({ t: 'code', v: code.join('\n') });
      continue;
    }
    const h = /^(#{2,3})\s+(.*?)(?:\s*\{#([a-z0-9-]+)\})?\s*$/.exec(line);
    if (h) {
      flush();
      const text = h[2] as string;
      let id = h[3] ?? slugify(text);
      for (let n = 2; used.has(id); n++) id = `${h[3] ?? slugify(text)}-${n}`;
      used.add(id);
      blocks.push({ t: 'h', level: (h[1] as string).length as 2 | 3, id, text });
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const re = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*]\s+(.*)$/;
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i] as string;
        const mm = re.exec(l);
        if (mm) items.push(mm[1] as string);
        else if (/^\s+\S/.test(l) && items.length) items[items.length - 1] += ` ${l.trim()}`;
        else break;
        i++;
      }
      blocks.push({ t: ordered ? 'ol' : 'ul', items: items.map(parseInline) });
      continue;
    }
    // A pipe table: a header row, a separator row (`| --- | --- |`), then body rows.
    if (/^\s*\|/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      flush();
      const cells = (l: string) =>
        l
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => parseInline(c.trim()));
      const head = cells(line);
      i += 2;
      const body: Inline[][][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i] as string)) body.push(cells(lines[i++] as string));
      blocks.push({ t: 'table', head, rows: body });
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] as string))
        q.push((lines[i++] as string).replace(/^>\s?/, ''));
      blocks.push({ t: 'quote', c: parseInline(q.join(' ')) });
      continue;
    }
    if (!line.trim()) flush();
    else para.push(line.trim());
    i++;
  }
  flush();
  return blocks;
}

/** Plain text of a block, for search. */
export function blockText(b: Block): string {
  switch (b.t) {
    case 'h':
      return b.text;
    case 'p':
    case 'quote':
      return inlineText(b.c);
    case 'ul':
    case 'ol':
      return b.items.map(inlineText).join(' ');
    case 'code':
      return b.v;
    case 'table':
      return [b.head, ...b.rows].map((r) => r.map(inlineText).join(' ')).join(' ');
  }
}
