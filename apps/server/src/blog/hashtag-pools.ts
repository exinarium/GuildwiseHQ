import { HASHTAG_POOL_KEYS, type HashtagPools, resolveHashtagPools } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { rows } from '../db/sql.ts';

/**
 * The standing and popular hashtag pools in force: the platform settings `blog_writer_hashtags_standing` and
 * `blog_writer_hashtags_popular` (edited in the blog writer's settings), else the defaults. An empty list is kept: it
 * turns that kind of tag off.
 */
export async function hashtagPools(ctx: Ctx): Promise<HashtagPools> {
  const found = await rows(ctx.pool, 'SELECT key, value FROM platform_settings WHERE key = ANY($1::text[])', [
    [HASHTAG_POOL_KEYS.standing, HASHTAG_POOL_KEYS.popular],
  ]);
  const value = (key: string) => found.find((r) => r.key === key)?.value;
  return resolveHashtagPools({
    standing: value(HASHTAG_POOL_KEYS.standing),
    popular: value(HASHTAG_POOL_KEYS.popular),
  });
}
