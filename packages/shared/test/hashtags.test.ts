import { describe, expect, it } from 'vitest';
import {
  buildHashtags,
  composeCaption,
  defaultVideoCaption,
  graphemeCount,
  HASHTAG_POOLS,
  HASHTAG_RE,
  HashtagPoolInputSchema,
  hashtagRun,
  NO_HASHTAG_POOLS,
  resolveHashtagPools,
  SOCIAL_LIMITS,
  SocialCaptionsSchema,
  topicalTagRange,
  VIDEO_CAPTION_LIMITS,
} from '../src/index.ts';

const POOLS = { standing: ['OpenSource', 'Free', 'SelfHosted'], popular: ['AI', 'DevOps', 'Tech'] };
const isStanding = (t: string) => POOLS.standing.includes(t);
const isPopular = (t: string) => POOLS.popular.includes(t);

describe('buildHashtags', () => {
  it('puts the topical tags first, then one standing and one popular tag', () => {
    const tags = buildHashtags({ topical: ['GitWorktrees', 'Pnpm'], pools: POOLS, max: 4, seed: 'a' });
    expect(tags.slice(0, 2)).toEqual(['GitWorktrees', 'Pnpm']);
    expect(tags.slice(2).filter(isStanding)).toHaveLength(1);
    expect(tags.slice(2).filter(isPopular)).toHaveLength(1);
  });

  it('keeps a slot for a standing and a popular tag whenever the maximum allows three or more', () => {
    for (const max of [3, 5, 8]) {
      const tags = buildHashtags({
        topical: ['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'g7', 'h8'],
        pools: POOLS,
        max,
        seed: 's',
      });
      expect(tags).toHaveLength(max);
      expect(tags.some(isStanding)).toBe(true);
      expect(tags.some(isPopular)).toBe(true);
      expect(tags.slice(0, max - 2)).toEqual(
        ['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'g7', 'h8'].slice(0, max - 2),
      );
    }
    // below three the topical tags come first
    expect(buildHashtags({ topical: ['a1', 'b2'], pools: POOLS, max: 2, seed: 's' })).toEqual(['a1', 'b2']);
    expect(buildHashtags({ topical: ['a1'], pools: POOLS, max: 2, seed: 's' })).toHaveLength(2);
  });

  it('de-duplicates case-insensitively, drops invalid tags and the `#`', () => {
    const tags = buildHashtags({
      topical: ['#opensource', 'OpenSource', 'not valid', '9lives', 'x', 'AI'],
      pools: { standing: ['OpenSource', 'Free'], popular: ['ai', 'DevOps'] },
      max: 6,
      seed: 'dup',
    });
    expect(tags.map((t) => t.toLowerCase())).toEqual([...new Set(tags.map((t) => t.toLowerCase()))]);
    expect(tags.slice(0, 2)).toEqual(['opensource', 'AI']);
    expect(tags).toContain('Free');
    expect(tags).toContain('DevOps');
    expect(tags.every((t) => HASHTAG_RE.test(t))).toBe(true);
  });

  it('never goes above the maximum, and takes at most two tags of each pool', () => {
    const tags = buildHashtags({ topical: [], pools: POOLS, max: 8, seed: 'cap' });
    expect(tags).toHaveLength(4);
    expect(tags.filter(isStanding)).toHaveLength(2);
    expect(tags.filter(isPopular)).toHaveLength(2);
    expect(buildHashtags({ topical: ['a1', 'b2'], pools: POOLS, max: 0, seed: 'x' })).toEqual([]);
  });

  it('is deterministic: the same seed gives the same tags, other seeds rotate the pools', () => {
    const big = { standing: HASHTAG_POOLS.standing, popular: HASHTAG_POOLS.popular };
    const one = (seed: string) => buildHashtags({ topical: ['Topic'], pools: big, max: 5, seed });
    expect(one('git-worktrees')).toEqual(one('git-worktrees'));
    const seen = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((s) => one(s).slice(1).join(' ')));
    expect(seen.size).toBeGreaterThan(1);
  });

  it('an empty pool turns that kind of tag off; no pools gives the topical tags only', () => {
    const tags = buildHashtags({
      topical: ['a1'],
      pools: { standing: [], popular: ['AI'] },
      max: 5,
      seed: 's',
    });
    expect(tags).toEqual(['a1', 'AI']);
    expect(
      buildHashtags({ topical: ['a1', 'b2', 'c3', 'd4'], pools: NO_HASHTAG_POOLS, max: 3, seed: 's' }),
    ).toEqual(['a1', 'b2', 'c3']);
  });

  it('fits a character room: pool tags are dropped first, then topical ones', () => {
    const full = buildHashtags({ topical: ['Topical'], pools: POOLS, max: 3, seed: 'r' });
    expect(full).toHaveLength(3);
    const first = full[0] as string;
    const second = full[1] as string;
    // room for the topical tag and the first pool tag only
    const tight = buildHashtags({
      topical: ['Topical'],
      pools: POOLS,
      max: 3,
      seed: 'r',
      room: hashtagRun([first, second]),
    });
    expect(tight).toEqual([first, second]);
    expect(
      buildHashtags({ topical: ['Topical'], pools: POOLS, max: 3, seed: 'r', room: hashtagRun([first]) }),
    ).toEqual(['Topical']);
    expect(buildHashtags({ topical: ['Topical'], pools: POOLS, max: 3, seed: 'r', room: 3 })).toEqual([]);
  });
});

describe('network maxima', () => {
  it('raised where the network allows; Instagram stays at 5, YouTube unchanged', () => {
    expect(SOCIAL_LIMITS.facebook.tags[1]).toBe(5);
    expect(SOCIAL_LIMITS.linkedin.tags[1]).toBe(8);
    expect(SOCIAL_LIMITS.x.tags[1]).toBe(3);
    expect(SOCIAL_LIMITS.bluesky.tags[1]).toBe(3);
    expect(VIDEO_CAPTION_LIMITS.tiktok.tags[1]).toBe(8);
    expect(VIDEO_CAPTION_LIMITS.instagram.tags[1]).toBe(5);
    expect(VIDEO_CAPTION_LIMITS.youtube.tags[1]).toBe(15);
  });
  it('asks the model for topical tags only: the pools keep two slots', () => {
    expect(topicalTagRange(SOCIAL_LIMITS.linkedin.tags)).toEqual([3, 6]);
    expect(topicalTagRange(SOCIAL_LIMITS.x.tags)).toEqual([1, 1]);
    expect(topicalTagRange(SOCIAL_LIMITS.facebook.tags)).toEqual([0, 3]);
    expect(topicalTagRange([1, 2])).toEqual([1, 2]);
  });
  it('the schema accepts the new maxima and refuses one more', () => {
    const tags = (n: number) => Array.from({ length: n }, (_, i) => `tag${i}`);
    expect(SocialCaptionsSchema.safeParse({ hashtags: { linkedin: tags(8) } }).success).toBe(true);
    expect(SocialCaptionsSchema.safeParse({ hashtags: { linkedin: tags(9) } }).success).toBe(false);
    expect(SocialCaptionsSchema.safeParse({ xText: 'Hi', hashtags: { x: tags(3) } }).success).toBe(true);
    expect(SocialCaptionsSchema.safeParse({ xText: 'Hi', hashtags: { x: tags(4) } }).success).toBe(false);
  });
});

describe('pools as settings', () => {
  it('unset is the default, a list is used as it is (cleaned), an empty list is off', () => {
    expect(resolveHashtagPools({})).toEqual({
      standing: [...HASHTAG_POOLS.standing],
      popular: [...HASHTAG_POOLS.popular],
    });
    expect(resolveHashtagPools({ standing: ['#Libre', 'libre', 'bad tag', 3], popular: [] })).toEqual({
      standing: ['Libre'],
      popular: [],
    });
    expect(resolveHashtagPools({ standing: 'nonsense', popular: null })).toEqual({
      standing: [...HASHTAG_POOLS.standing],
      popular: [...HASHTAG_POOLS.popular],
    });
  });
  it('validates what the owner types', () => {
    expect(HashtagPoolInputSchema.safeParse(['#OpenSource', 'Free']).success).toBe(true);
    expect(HashtagPoolInputSchema.safeParse(['two words']).success).toBe(false);
    expect(HashtagPoolInputSchema.safeParse([]).success).toBe(true);
  });
  it('every default tag is a valid hashtag', () => {
    expect([...HASHTAG_POOLS.standing, ...HASHTAG_POOLS.popular].every((t) => HASHTAG_RE.test(t))).toBe(true);
  });
});

describe('defaultVideoCaption', () => {
  const meta = {
    title: 'Run your agents in git worktrees',
    description: 'One branch per agent, no collisions.',
    hashtags: ['#GitWorktrees', '#Agents', '#DevTools', '#Pnpm', '#Testing'],
  };
  it('per destination: the video hashtags first, pool tags added, at most the maximum', () => {
    for (const dest of ['facebook', 'instagram', 'x', 'linkedin', 'bluesky', 'tiktok'] as const) {
      const c = defaultVideoCaption(dest, meta, POOLS);
      const max = VIDEO_CAPTION_LIMITS[dest].tags[1];
      expect(c.tags.length).toBeLessThanOrEqual(max);
      expect(c.tags[0]).toBe('GitWorktrees');
      expect(c.tags.some(isStanding)).toBe(true);
      expect(c.tags.some(isPopular)).toBe(true);
    }
    expect(defaultVideoCaption('instagram', meta, POOLS).tags).toHaveLength(5);
    expect(defaultVideoCaption('tiktok', meta, POOLS).tags).toHaveLength(8); // 5 own, then pool tags up to the maximum
    expect(defaultVideoCaption('x', meta, POOLS).text).toBe(meta.title);
  });
  it('without pools only the video hashtags are used', () => {
    expect(defaultVideoCaption('instagram', meta, NO_HASHTAG_POOLS).tags).toEqual([
      'GitWorktrees',
      'Agents',
      'DevTools',
      'Pnpm',
      'Testing',
    ]);
  });
  it('X and Bluesky: the title and the tags still fit the limit', () => {
    const long = { ...meta, title: 'T'.repeat(100) };
    for (const dest of ['x', 'bluesky'] as const) {
      const c = defaultVideoCaption(dest, long, POOLS);
      const composed = composeCaption(dest, c.text, c.tags);
      expect(graphemeCount(composed.text)).toBeLessThanOrEqual(VIDEO_CAPTION_LIMITS[dest].total);
      expect(composed.text.startsWith('T'.repeat(100))).toBe(true); // the title is not cut for the tags
    }
  });
});
