import { z } from 'zod';
import {
  BLOG_COVER_KEYS,
  BLOG_LIMITS,
  BLOG_TAG_KEYS,
  HASHTAG_RE,
  SOCIAL_LIMITS,
  SOCIAL_NETWORKS,
  type SocialNetwork,
} from './constants.ts';
import { cleanTags, graphemeCount } from './social-text.ts';

/** `^[a-z0-9]+(-[a-z0-9]+)*$`, 3-80 chars. */
export const BlogSlugSchema = z
  .string()
  .min(3)
  .max(80)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase letters, digits and single dashes');

const httpUrl = z
  .string()
  .max(2000)
  .refine((u) => {
    try {
      const x = new URL(u);
      return x.protocol === 'http:' || x.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'must be an http(s) URL');

export const BlogSourceSchema = z.object({
  title: z.string().min(1).max(200),
  url: httpUrl,
  accessedAt: z.string().max(40).optional(),
});

/** One hashtag as typed: a leading `#` is dropped, the rest must be a word (letters, digits, underscore). */
export const HashtagSchema = z
  .string()
  .trim()
  .transform((t) => t.replace(/^[#＃]/, ''))
  .pipe(
    z
      .string()
      .regex(HASHTAG_RE, 'a hashtag is one word: letters, digits and underscores, starting with a letter'),
  );

/** Hashtags per network, stored without `#`. Counts are capped by `SOCIAL_LIMITS` (the minimum is only a goal). */
export const SocialHashtagsSchema = z
  .object({
    facebook: z.array(HashtagSchema).max(SOCIAL_LIMITS.facebook.tags[1]),
    linkedin: z.array(HashtagSchema).max(SOCIAL_LIMITS.linkedin.tags[1]),
    x: z.array(HashtagSchema).max(SOCIAL_LIMITS.x.tags[1]),
    bluesky: z.array(HashtagSchema).max(SOCIAL_LIMITS.bluesky.tags[1]),
  })
  .partial()
  .refine((h) => Object.values(h).every((l) => !l || cleanTags(l).length === l.length), {
    message: 'duplicate hashtag',
  });

/**
 * The caption of each network. `hashtags` is optional: a caption written before it existed carries its tags inline and
 * is posted as it is. X and Bluesky: the caption and its hashtags must fit `SOCIAL_LIMITS.<network>.total` together.
 */
export const SocialCaptionsSchema = z
  .object({
    facebookText: z.string().max(SOCIAL_LIMITS.facebook.text).optional(),
    linkedinText: z.string().max(SOCIAL_LIMITS.linkedin.text).optional(),
    xText: z.string().max(1000).optional(),
    blueskyText: z.string().max(2000).optional(),
    hashtags: SocialHashtagsSchema.optional(),
  })
  .superRefine((c, ctx) => {
    for (const [network, key] of [
      ['x', 'xText'],
      ['bluesky', 'blueskyText'],
    ] as const) {
      const text = c[key];
      if (text === undefined) continue;
      const tags = cleanTags(c.hashtags?.[network]);
      const used =
        graphemeCount(text.trim().replace(/\s+/g, ' ')) + tags.reduce((n, t) => n + 2 + graphemeCount(t), 0);
      const max = SOCIAL_LIMITS[network].total;
      if (used > max)
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${network === 'x' ? 'X' : 'Bluesky'} caption with its hashtags is ${used} characters; the limit is ${max}`,
        });
    }
  });
export type SocialCaptions = z.infer<typeof SocialCaptionsSchema>;
/** Fewer hashtags than the network's goal (a hint for editors and the writer, not an error). */
export function hashtagShortfalls(c: SocialCaptions): SocialNetwork[] {
  return SOCIAL_NETWORKS.filter((n) => (c.hashtags?.[n]?.length ?? 0) < SOCIAL_LIMITS[n].tags[0]);
}

export const BlogContentSchema = z.object({
  slug: BlogSlugSchema,
  title: z.string().min(BLOG_LIMITS.titleMin).max(BLOG_LIMITS.titleMax),
  summary: z.string().min(BLOG_LIMITS.summaryMin).max(BLOG_LIMITS.summaryMax),
  bodyMarkdown: z.string().min(BLOG_LIMITS.bodyMin).max(BLOG_LIMITS.bodyMax),
  coverImage: z.object({
    defaultKey: z.enum(BLOG_COVER_KEYS),
    alt: z.string().min(5).max(200),
  }),
  tags: z.array(z.enum(BLOG_TAG_KEYS)).min(1).max(BLOG_LIMITS.tagsMax),
  sources: z.array(BlogSourceSchema).max(BLOG_LIMITS.sourcesMax).default([]),
  seo: z
    .object({
      metaTitle: z.string().max(60).optional(),
      metaDescription: z.string().max(160).optional(),
      canonicalUrl: httpUrl.optional(),
      noindex: z.boolean().optional(),
    })
    .default({}),
  social: SocialCaptionsSchema.default({}),
  aiDisclosure: z
    .object({ model: z.string().max(120).optional(), agentName: z.string().max(120).optional() })
    .default({}),
});
export type BlogContent = z.infer<typeof BlogContentSchema>;
