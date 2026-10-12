import { cleanUntrustedText } from '@aom/shared';

/**
 * Inbound mail is untrusted (docs/design/workflow-builder.md D9): only text is stored. HTML is turned into plain text
 * here (tags dropped, scripts and styles removed with their content, entities decoded); links are never fetched or
 * followed, and the URL of a link stays visible as text so a reader sees where it goes.
 */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  hellip: '...',
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  copy: '(c)',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e.startsWith('#')) {
      const n =
        e[1]?.toLowerCase() === 'x' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 31 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Plain text from an HTML body. Never throws; unknown markup is dropped. */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head|title|noscript|iframe|object|embed|template|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    // an unclosed script/style swallows the rest: drop from the open tag on
    .replace(/<(script|style|iframe|object|embed)\b[\s\S]*$/gi, ' ');
  // Keep the target of a link visible: <a href="https://x">text</a> -> text (https://x)
  s = s.replace(
    /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_m, a, b, c, text) => {
      const href = String(a ?? b ?? c ?? '').trim();
      const label = String(text)
        .replace(/<[^>]*>/g, '')
        .trim();
      return /^https?:\/\//i.test(href) && href !== label ? `${label} (${href})` : label || href;
    },
  );
  s = s
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote|ul|ol)\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]*>/g, ' ');
  s = decodeEntities(s);
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Single-line header text: control characters out, whitespace collapsed, capped. */
export const headerText = (s: string | null | undefined, max: number): string =>
  cleanUntrustedText(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** Body text: the plain part when there is one, else the HTML as text; cleaned and capped. */
export function bodyText(
  text: string | null | undefined,
  html: string | null | undefined,
  max: number,
): { text: string; truncated: boolean } {
  const base = text?.trim() ? text : html ? htmlToText(html) : '';
  const clean = cleanUntrustedText(base)
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  return clean.length > max
    ? { text: clean.slice(0, max), truncated: true }
    : { text: clean, truncated: false };
}
