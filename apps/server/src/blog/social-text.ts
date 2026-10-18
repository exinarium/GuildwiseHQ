/** Caption fitting for X and Bluesky. Pure functions, unit-tested. */

/** X counts every URL as 23 characters whatever its length. */
export const X_LIMIT = 280;
export const X_URL_LEN = 23;
export const BLUESKY_LIMIT = 300;

const segmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/** User-perceived characters (code points when `Intl.Segmenter` is missing). */
export function graphemes(s: string): string[] {
  return segmenter ? Array.from(segmenter.segment(s), (x) => x.segment) : Array.from(s);
}

/** Cuts to `max` graphemes, ending in an ellipsis when something was removed. */
export function fitCaption(caption: string, max: number): string {
  const text = caption.trim().replace(/\s+/g, ' ');
  const g = graphemes(text);
  if (g.length <= max) return text;
  if (max <= 1) return g.slice(0, Math.max(0, max)).join('');
  return `${g
    .slice(0, max - 1)
    .join('')
    .trimEnd()}…`;
}

/** `caption link` for X: the caption is cut so that caption + space + 23 fits in 280. */
export function xTweetText(caption: string, link: string): string {
  return `${fitCaption(caption, X_LIMIT - 1 - X_URL_LEN)} ${link}`;
}

export interface BlueskyText {
  text: string;
  facets: Array<{
    index: { byteStart: number; byteEnd: number };
    features: Array<{ $type: 'app.bsky.richtext.facet#link'; uri: string }>;
  }>;
}

/** `caption link` within 300 graphemes (the whole link counts), plus the link facet with UTF-8 byte offsets. */
export function blueskyPost(caption: string, link: string): BlueskyText {
  const room = BLUESKY_LIMIT - 1 - graphemes(link).length;
  const head = `${fitCaption(caption, Math.max(0, room))} `;
  const byteStart = Buffer.byteLength(head, 'utf8');
  return {
    text: `${head}${link}`,
    facets: [
      {
        index: { byteStart, byteEnd: byteStart + Buffer.byteLength(link, 'utf8') },
        features: [{ $type: 'app.bsky.richtext.facet#link', uri: link }],
      },
    ],
  };
}
