import { SOCIAL_LIMITS, type SocialNetwork } from './constants.ts';

/**
 * Caption composition for the four networks. Pure functions shared by the server (what is posted) and the web editor
 * (the counter and the exact preview), so what the editor shows is what goes out.
 */

/** X counts every URL as 23 characters whatever its length. */
// TODO: X weighs characters, not graphemes (an emoji or a CJK character counts 2). Counting graphemes can under-count such text;
// switch to the twitter-text weighting if captions with many of them hit the limit.
export const X_LIMIT = 280;
export const X_URL_LEN = 23;
export const BLUESKY_LIMIT = 300;
/** A link of exactly the 23 characters X counts, for previews that have no real link yet. */
export const X_LINK_SAMPLE = 'https://example.com/abc';
/** Hashtags are kept only while the text keeps at least this many graphemes (or all of its own). */
const MIN_TEXT_ROOM = 40;

const segmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/** User-perceived characters (code points when `Intl.Segmenter` is missing). */
export function graphemes(s: string): string[] {
  return segmenter ? Array.from(segmenter.segment(s), (x) => x.segment) : Array.from(s);
}
export const graphemeCount = (s: string): number => graphemes(s).length;

const collapse = (s: string): string => s.trim().replace(/\s+/g, ' ');

/** Cuts to `max` graphemes, ending in an ellipsis when something was removed. */
export function fitCaption(caption: string, max: number): string {
  const text = collapse(caption);
  const g = graphemes(text);
  if (g.length <= max) return text;
  if (max <= 1) return g.slice(0, Math.max(0, max)).join('');
  return `${g
    .slice(0, max - 1)
    .join('')
    .trimEnd()}…`;
}

/** Tags as stored: no `#`, no duplicates (case-insensitive), in order. */
export function cleanTags(tags: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags ?? []) {
    const t = raw.trim().replace(/^[#＃]/, '');
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

/** The tags the text does not already carry inline (an older caption may end in `#AI`). */
function tagsNotInText(
  text: string,
  tags: readonly string[],
  norm: (t: string) => string = (t) => t,
): string[] {
  const inline = new Set(
    (text.match(/[#＃][\p{L}\p{N}_]+/gu) ?? []).map((m) => norm(m.slice(1)).toLowerCase()),
  );
  return cleanTags(tags.map(norm)).filter((t) => !inline.has(t.toLowerCase()));
}

/** Graphemes of ` #a #b` (a space and the `#` before each tag). */
const tagRun = (tags: readonly string[]): number => tags.reduce((n, t) => n + 2 + graphemeCount(t), 0);

export interface BlueskyFacet {
  index: { byteStart: number; byteEnd: number };
  features: Array<
    | { $type: 'app.bsky.richtext.facet#tag'; tag: string }
    | { $type: 'app.bsky.richtext.facet#link'; uri: string }
  >;
}
export interface ComposedCaption {
  text: string;
  /** Bluesky only; UTF-8 byte offsets. */
  facets: BlueskyFacet[];
}

/** The most tags that still leave the text room: tags are dropped from the END only, and only when needed. */
function keepTags(text: string, tags: string[], total: number): string[] {
  const own = graphemeCount(text);
  for (let k = tags.length; k > 0; k--) {
    const room = total - tagRun(tags.slice(0, k));
    if (room >= Math.min(own, MIN_TEXT_ROOM)) return tags.slice(0, k);
  }
  return [];
}

/**
 * LinkedIn's "little text" format reserves `\ | { } @ [ ] ( ) < > # * _ ~`; each must be escaped with a backslash to be
 * plain text. A `#` that starts a word stays unescaped: that is how a hashtag is written in `commentary`.
 */
export function escapeLittleText(s: string): string {
  // A word-starting `#tag` is a hashtag: kept, with its underscores dropped like the tag line's (`\_` would split it).
  return s.replace(/([#＃][\p{L}][\p{L}\p{N}_]*)|[\\|{}@[\]()<>*_~#]/gu, (m, tag?: string) =>
    tag ? tag.replaceAll('_', '') : `\\${m}`,
  );
}

/**
 * The text that is posted on `network`.
 * - X: `text #a #b link`, at most 280 with the link counted as 23. The text is cut first so the tags survive; tags are
 *   dropped from the end only when the text would be left with almost no room.
 * - Bluesky: `text #a #b`, at most 300 graphemes, NO link in the text (the external embed card carries it), with a
 *   `#tag` facet per tag.
 * - LinkedIn: the escaped text, a blank line, then `#a #b` (underscores dropped: LinkedIn hashtags are one word).
 * - Facebook: the text, a blank line, then `#a #b`.
 */
export function composeCaption(
  network: SocialNetwork,
  text: string,
  tags: readonly string[] = [],
  link = '',
): ComposedCaption {
  // LinkedIn hashtags are one word without underscores: normalise first, so `foo_bar` and `foobar` are one tag
  const extra = tagsNotInText(text, tags, network === 'linkedin' ? (t) => t.replaceAll('_', '') : undefined);
  if (network === 'x' || network === 'bluesky') {
    const total = SOCIAL_LIMITS[network].total;
    const body = collapse(text);
    const kept = keepTags(body, extra, total);
    const head = fitCaption(body, total - tagRun(kept));
    const run = kept.map((t) => ` #${t}`).join('');
    if (network === 'x') return { text: `${head}${run}${link ? ` ${link}` : ''}`, facets: [] };
    const enc = new TextEncoder();
    const facets: BlueskyFacet[] = [];
    let prefix = head;
    for (const t of kept) {
      prefix += ' ';
      const byteStart = enc.encode(prefix).length;
      prefix += `#${t}`;
      facets.push({
        index: { byteStart, byteEnd: enc.encode(prefix).length },
        features: [{ $type: 'app.bsky.richtext.facet#tag', tag: t }],
      });
    }
    return { text: `${head}${run}`, facets };
  }
  const body = text.replace(/\r\n?/g, '\n').trim();
  if (network === 'linkedin') {
    const tagLine = extra.map((t) => `#${t}`).join(' ');
    return { text: `${escapeLittleText(body)}${tagLine ? `\n\n${tagLine}` : ''}`, facets: [] };
  }
  const tagLine = extra.map((t) => `#${t}`).join(' ');
  return { text: `${body}${tagLine ? `\n\n${tagLine}` : ''}`, facets: [] };
}

/** What the network counts for this composed text: X counts the link as 23 whatever its length. */
export function captionLength(network: SocialNetwork, composed: string, link = ''): number {
  const n = graphemeCount(composed);
  return network === 'x' && link ? n - graphemeCount(link) + X_URL_LEN : n;
}

/** `caption #tags link` for X, cut so that it fits in 280. */
export function xTweetText(caption: string, link: string, tags: readonly string[] = []): string {
  return composeCaption('x', caption, tags, link).text;
}
