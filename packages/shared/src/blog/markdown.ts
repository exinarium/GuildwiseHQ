/**
 * The restricted Markdown of the blog (docs/design/blog-prd.md section 10). One parser for the server (public pages,
 * feed), the Help > Blog reader and the review preview, so all of them show identical output.
 *
 * No raw HTML is ever accepted: the source becomes an AST made only of the allow-listed nodes below, and `renderHtml`
 * escapes every text. Links must be http(s) or a same-site path (`/...`); anything else is shown as plain text.
 */

export type MdInline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; c: MdInline[] }
  | { t: 'em'; c: MdInline[] }
  | { t: 'link'; href: string; c: MdInline[] };

export type MdBlock =
  | { t: 'h'; level: 2 | 3 | 4; id: string; text: string }
  | { t: 'p'; c: MdInline[] }
  | { t: 'ul'; items: MdInline[][] }
  | { t: 'ol'; items: MdInline[][] }
  | { t: 'quote'; c: MdInline[] }
  | { t: 'code'; v: string; lang?: string }
  | { t: 'table'; head: MdInline[][]; rows: MdInline[][][] };

export const mdSlug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section';

/** A link target the blog accepts: an absolute http(s) URL or a path on this site. */
export function safeHref(href: string): string | null {
  const h = href.trim();
  if (/^https?:\/\/[^\s<>"']+$/i.test(h)) {
    try {
      const u = new URL(h);
      return u.protocol === 'http:' || u.protocol === 'https:' ? h : null;
    } catch {
      return null;
    }
  }
  if (/^\/(?!\/)[^\s<>"']*$/.test(h)) return h;
  return null;
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))/;

export function parseMdInline(s: string): MdInline[] {
  const out: MdInline[] = [];
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
    else if (tok.startsWith('**')) out.push({ t: 'strong', c: parseMdInline(tok.slice(2, -2)) });
    else if (tok.startsWith('*')) out.push({ t: 'em', c: parseMdInline(tok.slice(1, -1)) });
    else {
      const l = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
      if (l) {
        const href = safeHref(l[2] as string);
        const c = parseMdInline(l[1] as string);
        if (href) out.push({ t: 'link', href, c });
        else out.push(...c);
      }
    }
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}

export const mdInlineText = (c: MdInline[]): string =>
  c.map((i) => (i.t === 'text' || i.t === 'code' ? i.v : mdInlineText(i.c))).join('');

const splitRow = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((x) => x.trim());
const isSep = (line: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

export function parseMarkdown(body: string): MdBlock[] {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  const used = new Set<string>();
  let i = 0;
  const para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ t: 'p', c: parseMdInline(para.join(' ')) });
    para.length = 0;
  };
  while (i < lines.length) {
    const line = lines[i] as string;
    const fence = /^```\s*([a-z0-9+-]*)\s*$/i.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i] as string)) code.push(lines[i++] as string);
      i++;
      blocks.push({ t: 'code', v: code.join('\n'), ...(fence[1] ? { lang: fence[1].toLowerCase() } : {}) });
      continue;
    }
    const h = /^(#{2,4})\s+(.*?)\s*$/.exec(line);
    if (h) {
      flush();
      const text = h[2] as string;
      const base = mdSlug(text);
      let id = base;
      for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
      used.add(id);
      blocks.push({ t: 'h', level: (h[1] as string).length as 2 | 3 | 4, id, text });
      i++;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isSep(lines[i + 1] as string)) {
      flush();
      const head = splitRow(line).map(parseMdInline);
      i += 2;
      const trs: MdInline[][][] = [];
      while (i < lines.length && (lines[i] as string).includes('|') && (lines[i] as string).trim()) {
        trs.push(splitRow(lines[i] as string).map(parseMdInline));
        i++;
      }
      blocks.push({ t: 'table', head, rows: trs });
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
      blocks.push({ t: ordered ? 'ol' : 'ul', items: items.map(parseMdInline) });
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] as string))
        q.push((lines[i++] as string).replace(/^>\s?/, ''));
      blocks.push({ t: 'quote', c: parseMdInline(q.join(' ')) });
      continue;
    }
    if (!line.trim()) flush();
    else para.push(line.trim());
    i++;
  }
  flush();
  return blocks;
}

export function mdBlockText(b: MdBlock): string {
  switch (b.t) {
    case 'h':
      return b.text;
    case 'p':
    case 'quote':
      return mdInlineText(b.c);
    case 'ul':
    case 'ol':
      return b.items.map(mdInlineText).join(' ');
    case 'code':
      return b.v;
    case 'table':
      return [...b.head, ...b.rows.flat()].map(mdInlineText).join(' ');
  }
}

export const markdownText = (src: string): string => parseMarkdown(src).map(mdBlockText).join('\n');

/** Words of the body, for the reading time. */
export const wordCount = (src: string): number => (markdownText(src).match(/\S+/g) ?? []).length;
export const readingMinutes = (words: number): number => Math.max(1, Math.round(words / 220));

export const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

function inlineHtml(c: MdInline[]): string {
  return c
    .map((i) => {
      switch (i.t) {
        case 'text':
          return escapeHtml(i.v);
        case 'code':
          return `<code>${escapeHtml(i.v)}</code>`;
        case 'strong':
          return `<strong>${inlineHtml(i.c)}</strong>`;
        case 'em':
          return `<em>${inlineHtml(i.c)}</em>`;
        case 'link': {
          const ext = /^https?:/i.test(i.href);
          return `<a href="${escapeHtml(i.href)}"${ext ? ' rel="nofollow noopener noreferrer" target="_blank"' : ''}>${inlineHtml(i.c)}</a>`;
        }
        default:
          return '';
      }
    })
    .join('');
}

export function renderMarkdownHtml(src: string): string {
  return parseMarkdown(src)
    .map((b) => {
      switch (b.t) {
        case 'h':
          return `<h${b.level} id="${escapeHtml(b.id)}">${escapeHtml(b.text)}</h${b.level}>`;
        case 'p':
          return `<p>${inlineHtml(b.c)}</p>`;
        case 'quote':
          return `<blockquote><p>${inlineHtml(b.c)}</p></blockquote>`;
        case 'ul':
        case 'ol':
          return `<${b.t}>${b.items.map((x) => `<li>${inlineHtml(x)}</li>`).join('')}</${b.t}>`;
        case 'code':
          return `<pre><code>${escapeHtml(b.v)}</code></pre>`;
        case 'table':
          return `<div class="table-wrap"><table><thead><tr>${b.head.map((x) => `<th>${inlineHtml(x)}</th>`).join('')}</tr></thead><tbody>${b.rows
            .map((r) => `<tr>${r.map((x) => `<td>${inlineHtml(x)}</td>`).join('')}</tr>`)
            .join('')}</tbody></table></div>`;
        default:
          return '';
      }
    })
    .join('\n');
}

/** Every link target in the body (for the content checks). */
export function markdownLinks(src: string): string[] {
  const out: string[] = [];
  const walk = (c: MdInline[]) => {
    for (const i of c) {
      if (i.t === 'link') {
        out.push(i.href);
        walk(i.c);
      } else if (i.t === 'strong' || i.t === 'em') walk(i.c);
    }
  };
  for (const b of parseMarkdown(src)) {
    if (b.t === 'p' || b.t === 'quote') walk(b.c);
    else if (b.t === 'ul' || b.t === 'ol') for (const it of b.items) walk(it);
    else if (b.t === 'table') for (const c of [...b.head, ...b.rows.flat()]) walk(c);
  }
  return out;
}
