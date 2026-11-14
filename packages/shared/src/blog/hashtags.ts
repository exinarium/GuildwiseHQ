import { z } from 'zod';
import { HASHTAG_RE } from './constants.ts';
import { cleanTags, graphemeCount } from './social-text.ts';

/**
 * Hashtags beyond the item's own: two pools the owner edits (platform settings `blog_writer_hashtags_standing` and
 * `blog_writer_hashtags_popular`), added to the topical tags the model writes by `buildHashtags`. Tags are stored without
 * the `#`.
 * - `standing`: what the product always is (open source, free, self-hosted).
 * - `popular`: a curated, evergreen list of widely used tags of the product's field. Deliberately not called "trending":
 *   nothing here reads live trends; the owner updates the list.
 */
export interface HashtagPools {
  standing: readonly string[];
  popular: readonly string[];
}

export const HASHTAG_POOLS: HashtagPools = {
  standing: ['OpenSource', 'Free', 'FreeSoftware', 'SelfHosted', 'FOSS'],
  popular: [
    'AI',
    'Automation',
    'DevOps',
    'Tech',
    'Productivity',
    'AIAgents',
    'GenerativeAI',
    'MachineLearning',
    'Programming',
    'SoftwareDevelopment',
  ],
};

/** No pool tags at all (an empty pool turns that kind of tag off). */
export const NO_HASHTAG_POOLS: HashtagPools = { standing: [], popular: [] };

/** The platform settings that hold the pools. Unset: the defaults above; an empty list: that kind is off. */
export const HASHTAG_POOL_KEYS = {
  standing: 'blog_writer_hashtags_standing',
  popular: 'blog_writer_hashtags_popular',
} as const;

/** Tags per pool the owner may keep. */
export const HASHTAG_POOL_MAX = 30;

/** One pool as typed by the owner: words, a leading `#` allowed (it is dropped when stored). */
export const HashtagPoolInputSchema = z
  .array(
    z
      .string()
      .trim()
      .regex(
        /^[#＃]?[\p{L}][\p{L}\p{N}_]{1,49}$/u,
        'a hashtag is one word: letters, digits and underscores, starting with a letter',
      ),
  )
  .max(HASHTAG_POOL_MAX);

export const HashtagPoolsSchema = z.object({
  standing: z.array(z.string()).max(HASHTAG_POOL_MAX),
  popular: z.array(z.string()).max(HASHTAG_POOL_MAX),
});

/** A pool as stored: no `#`, valid words only, no duplicates (case-insensitive), in order. */
export const cleanPool = (tags: readonly string[]): string[] =>
  cleanTags(tags).filter((t) => HASHTAG_RE.test(t));

/** The pools in force from the stored setting values: a missing (or malformed) value is the default, a list is used as it is. */
export function resolveHashtagPools(stored: { standing?: unknown; popular?: unknown }): HashtagPools {
  const pick = (v: unknown, fallback: readonly string[]): string[] =>
    Array.isArray(v) ? cleanPool(v.filter((x): x is string => typeof x === 'string')) : [...fallback];
  return {
    standing: pick(stored.standing, HASHTAG_POOLS.standing),
    popular: pick(stored.popular, HASHTAG_POOLS.popular),
  };
}

/** FNV-1a: a small, stable string hash (the same seed always picks the same pool tags). */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The pool rotated so that it starts at a place chosen by the seed. */
function rotated(pool: readonly string[], seed: string): string[] {
  const list = cleanPool(pool);
  if (!list.length) return list;
  const start = hash(seed) % list.length;
  return [...list.slice(start), ...list.slice(0, start)];
}

/** Graphemes of ` #a #b` (a space and the `#` before each tag), as the captions count them. */
export const hashtagRun = (tags: readonly string[]): number =>
  tags.reduce((n, t) => n + 2 + graphemeCount(t), 0);

export interface BuildHashtagsInput {
  /** The item's own tags (the model's), most important first. A leading `#` is dropped. */
  topical: readonly string[];
  /** Standing and popular pools (default: none). */
  pools?: HashtagPools | undefined;
  /** The network's maximum. */
  max: number;
  /** What the rotation is derived from (a slug, a version, a title): the same seed gives the same tags. */
  seed: string;
  /**
   * Characters the text leaves for the tag run (` #a #b`), for networks where the text and the tags share one limit
   * (X, Bluesky): `total - text`. Pool tags are kept only while the run fits it (the text is never cut for a pool tag);
   * a slot a dropped pool tag frees goes back to a topical tag. Topical tags are never dropped here: they follow the
   * composer's rule (`composeCaption`: the text is cut for them, and they go only when it would be left with almost
   * no room).
   */
  room?: number | undefined;
  /** At most this many tags from each pool (default 2). */
  perPool?: number;
}

/**
 * The hashtags of one post on one network, without `#`: the topical tags first, then standing and popular tags
 * alternately (each pool rotated by the seed), de-duplicated case-insensitively, valid against `HASHTAG_RE`, trimmed to
 * `max`. When `max` is 3 or more, a slot is kept for one standing and one popular tag (when that pool is not empty), so
 * the topical tags get `max - 2`. Pure and deterministic.
 */
export function buildHashtags(o: BuildHashtagsInput): string[] {
  const max = Math.max(0, Math.floor(o.max));
  const pools = o.pools ?? NO_HASHTAG_POOLS;
  const perPool = Math.max(0, o.perPool ?? 2);
  const standing = rotated(pools.standing, `standing:${o.seed}`);
  const popular = rotated(pools.popular, `popular:${o.seed}`);
  const topical = cleanPool(o.topical);
  const reserve = max >= 3 && perPool > 0 ? (standing.length ? 1 : 0) + (popular.length ? 1 : 0) : 0;
  const out = topical.slice(0, Math.max(0, max - reserve));
  const has = (t: string) => out.some((x) => x.toLowerCase() === t.toLowerCase());
  const queues = [standing, popular];
  const taken = [0, 0];
  let progress = true;
  while (out.length < max && progress) {
    progress = false;
    for (let k = 0; k < queues.length && out.length < max; k++) {
      const q = queues[k] as string[];
      if ((taken[k] as number) >= perPool) continue;
      // the next tag of this pool that is not there yet
      while (q.length && has(q[0] as string)) q.shift();
      const next = q.shift();
      if (next === undefined) continue;
      out.push(next);
      taken[k] = (taken[k] as number) + 1;
      progress = true;
    }
  }
  if (o.room === undefined) return out;
  const room = o.room;
  const pool = out.slice(Math.min(topical.length, Math.max(0, max - reserve)));
  const isDup = (t: string) => pool.some((x) => x.toLowerCase() === t.toLowerCase());
  const withTopical = () => [...topical.filter((t) => !isDup(t)).slice(0, max - pool.length), ...pool];
  let fitted = withTopical();
  while (pool.length && hashtagRun(fitted) > room) {
    pool.pop();
    fitted = withTopical();
  }
  return fitted;
}

/**
 * How many topical tags to ask the model for on a network whose maximum is `max`: the pools take up to two of the
 * slots (`buildHashtags`), so asking for more would only have them dropped.
 */
export function topicalTagRange(tags: readonly [number, number]): [number, number] {
  const hi = tags[1] >= 3 ? tags[1] - 2 : tags[1];
  return [Math.min(tags[0], hi), hi];
}
