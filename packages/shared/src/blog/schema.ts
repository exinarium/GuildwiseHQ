import { z } from 'zod';
import { BLOG_COVER_KEYS, BLOG_LIMITS, BLOG_TAG_KEYS } from './constants.ts';

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
  social: z
    .object({
      facebookText: z.string().max(500).optional(),
      linkedinText: z.string().max(700).optional(),
      xText: z.string().max(250).optional(),
      blueskyText: z.string().max(270).optional(),
    })
    .default({}),
  aiDisclosure: z
    .object({ model: z.string().max(120).optional(), agentName: z.string().max(120).optional() })
    .default({}),
});
export type BlogContent = z.infer<typeof BlogContentSchema>;
