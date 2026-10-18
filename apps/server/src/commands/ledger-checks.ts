/**
 * Cheap, deterministic checks run when a standing order is saved (Lean Team v3, section 10): a near-duplicate of a live
 * order, and a possible contradiction (same subject, opposing instruction). Pure functions over text; the caller decides
 * what to do with the result and records the decision.
 */

const STOP = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'are',
  'you',
  'your',
  'all',
  'any',
  'can',
  'has',
  'have',
  'was',
  'were',
  'will',
  'would',
  'should',
  'must',
  'shall',
  'from',
  'into',
  'than',
  'then',
  'when',
  'what',
  'which',
  'who',
  'how',
  'its',
  'it',
  'not',
  'but',
  'use',
  'via',
  'per',
  'each',
  'every',
  'out',
  'one',
  'only',
  'also',
  'such',
  'they',
  'them',
  'their',
  'there',
  'these',
  'those',
  'being',
  'been',
  'does',
  'did',
  'done',
  'etc',
  'agents',
  'agent',
  'order',
]);

/** Words that flip an instruction (a prohibition) and the ones that confirm it. */
const NEGATIVE =
  /\b(never|do not|don't|dont|must not|mustn't|should not|shouldn't|cannot|can't|avoid|without|stop|no longer|forbidden|not allowed)\b/i;
const POSITIVE =
  /\b(always|must|should|required|require|ensure|need to|needs to|do|ask|wait|run|start|create|use|check)\b/i;

/** Very small stemmer: plural, -ing, -ed, -ly and a trailing e go ("facing", "faced" and "faces" all become "fac"). */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('ly')) w = w.slice(0, -2);
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/**
 * Lowercase content words (3+ characters), without stop words (articles included) and negation cues. Hyphens, slashes
 * and underscores separate words ("user-facing" is "user facing"), and words are stemmed, so trivial variants match.
 */
export function contentTokens(text: string): Set<string> {
  const words =
    text
      .toLowerCase()
      .replace(/[-_/]+/g, ' ')
      .match(/[a-z0-9]{3,}/g) ?? [];
  return new Set(
    words
      .filter(
        (w) => !STOP.has(w) && !['never', 'dont', 'avoid', 'without', 'stop', 'cannot', 'always'].includes(w),
      )
      .map(stem),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** The share of the smaller set that the larger one contains. */
export function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.min(a.size, b.size);
}

export interface OrderText {
  id: string;
  title: string;
  body: string;
}

const ARTICLES = new Set(['a', 'an', 'the']);
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !ARTICLES.has(w))
    .join(' ');

/** A near-duplicate: the same title once normalised, or nearly the same words in title and text together. */
export function isNearDuplicate(
  a: Pick<OrderText, 'title' | 'body'>,
  b: Pick<OrderText, 'title' | 'body'>,
): boolean {
  if (norm(a.title) === norm(b.title) && norm(a.title).length > 0) return true;
  const ta = contentTokens(`${a.title} ${a.body}`);
  const tb = contentTokens(`${b.title} ${b.body}`);
  if (Math.min(ta.size, tb.size) < 3) return norm(a.body) === norm(b.body);
  return jaccard(ta, tb) >= 0.7 || (containment(ta, tb) >= 0.9 && Math.min(ta.size, tb.size) >= 5);
}

export function findNearDuplicate<T extends OrderText>(
  candidate: Pick<OrderText, 'title' | 'body'>,
  live: T[],
): T | undefined {
  return live.find((o) => isNearDuplicate(candidate, o));
}

/** +1 an instruction to do, -1 an instruction not to, 0 no cue. Two cues of the same kind cancel out per sentence. */
export function polarity(text: string): -1 | 0 | 1 {
  const sentences = text.split(/[.;\n]+/).filter((s) => s.trim());
  let neg = 0;
  let pos = 0;
  for (const s of sentences) {
    if (NEGATIVE.test(s)) neg++;
    else if (POSITIVE.test(s)) pos++;
  }
  if (neg > 0 && pos === 0) return -1;
  if (pos > 0 && neg === 0) return 1;
  return 0;
}

/**
 * Possible contradiction: the two orders talk about the same thing (several shared content words, mostly the title's)
 * and one forbids what the other asks for. A heuristic: it flags for a human, it never blocks a save.
 */
export function contradicts(
  a: Pick<OrderText, 'title' | 'body'>,
  b: Pick<OrderText, 'title' | 'body'>,
): boolean {
  const pa = polarity(`${a.title}. ${a.body}`);
  const pb = polarity(`${b.title}. ${b.body}`);
  if (pa === 0 || pb === 0 || pa === pb) return false;
  const ta = contentTokens(`${a.title} ${a.body}`);
  const tb = contentTokens(`${b.title} ${b.body}`);
  let shared = 0;
  for (const x of ta) if (tb.has(x)) shared++;
  return shared >= 2 && jaccard(ta, tb) >= 0.2;
}

export function findContradictions<T extends OrderText>(
  candidate: Pick<OrderText, 'title' | 'body'>,
  live: T[],
): T[] {
  return live.filter((o) => contradicts(candidate, o));
}
