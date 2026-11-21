import { z } from 'zod';
import { VideoPostMetaSchema } from '../video/post.ts';
import { VIDEO_DESTINATIONS } from '../video/schedule.ts';
import { VIDEO_FORMATS, VIDEO_KINDS } from '../video/schema.ts';
import { BLOG_ORIGIN_KINDS, SOCIAL_CHANNEL_NETWORKS } from './constants.ts';
import { BlogContentSchema, BlogSlugSchema, ManualBlogContentSchema } from './schema.ts';
import { AnySocialPostContentSchema, ReleaseVersionSchema } from './social-post.ts';

/**
 * The article carry-over bundle (`blog-bundle-export` writes it from an old install's dump, `blog-bundle-import` loads it
 * into a new one; docs/SELF-HOSTING.md "Carry blog articles to a new install"). Every file is strict: an unknown key is
 * refused, so nothing the format does not name (a token, a user id, a script) can ride along.
 */

export const BLOG_BUNDLE_FORMAT = 'guildwise-blog-bundle';
export const BLOG_BUNDLE_VERSION = 1;
/** The files of a version 1 bundle, besides `SHA256SUMS` (which covers all of them). */
export const BLOG_BUNDLE_FILES = [
  'manifest.json',
  'posts.json',
  'releases.json',
  'videos.json',
  'shares.json',
  'REPORT.md',
] as const;
/** The whole bundle may not be larger than this. */
export const BLOG_BUNDLE_MAX_BYTES = 20 * 1024 * 1024;

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const Iso = z.iso.datetime();

export const BundlePostSchema = z.strictObject({
  id: z.uuid(),
  slug: BlogSlugSchema,
  content: BlogContentSchema.or(ManualBlogContentSchema),
  launch: z.boolean(),
  originKind: z.enum(BLOG_ORIGIN_KINDS),
  /** A hand-written article's byline; null on writer posts. */
  authorName: z.string().min(1).max(80).nullable(),
  createdAt: Iso,
  updatedAt: Iso,
  publishedAt: Iso,
  contentHash: Sha256,
});
export type BundlePost = z.infer<typeof BundlePostSchema>;

export const BundleReleaseSchema = z.strictObject({
  id: z.uuid(),
  ref: ReleaseVersionSchema,
  content: AnySocialPostContentSchema,
  createdAt: Iso,
  approvedAt: Iso,
});
export type BundleRelease = z.infer<typeof BundleReleaseSchema>;

export const BundleVideoSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(VIDEO_KINDS),
  format: z.enum(VIDEO_FORMATS),
  ref: z.string().min(1).max(120),
  parentId: z.uuid().nullable(),
  meta: VideoPostMetaSchema,
  /** Exactly the networks the video was sent to (each has a share row in `shares.json`). */
  destinations: z.array(z.enum(VIDEO_DESTINATIONS)).min(1),
  createdAt: Iso,
  approvedAt: Iso,
});
export type BundleVideo = z.infer<typeof BundleVideoSchema>;

/** What a share keeps of the old `detail`: the YouTube facts the public pages and the re-check read, nothing else. */
export const BundleShareDetailSchema = z.strictObject({
  videoId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{6,20}$/)
    .optional(),
  privacy: z.enum(['public', 'unlisted', 'private']).optional(),
  publishAt: Iso.nullable().optional(),
  verifiedAt: Iso.optional(),
  uploadedAt: Iso.optional(),
});
export type BundleShareDetail = z.infer<typeof BundleShareDetailSchema>;

/** One `sent` share: the network already has the post (or video). Unsent rows are never in a bundle. */
export const BundleShareSchema = z.strictObject({
  postId: z.uuid(),
  source: z.enum(['blog', 'social', 'video']),
  network: z.enum(SOCIAL_CHANNEL_NETWORKS),
  externalId: z.string().min(1).max(200),
  url: z.string().max(500).nullable(),
  createdAt: Iso,
  updatedAt: Iso,
  detail: BundleShareDetailSchema,
});
export type BundleShare = z.infer<typeof BundleShareSchema>;

export const BundleManifestSchema = z.strictObject({
  format: z.literal(BLOG_BUNDLE_FORMAT),
  version: z.literal(BLOG_BUNDLE_VERSION),
  createdAt: Iso,
  source: z.strictObject({
    file: z.string().min(1).max(300),
    sha256: Sha256,
    pgVersion: z.string().max(200).nullable(),
  }),
  compared: z
    .strictObject({
      file: z.string().min(1).max(300),
      sha256: Sha256,
      differences: z.array(z.string().max(1000)).max(1000),
    })
    .nullable(),
  counts: z.strictObject({
    posts: z.number().int().nonnegative(),
    releases: z.number().int().nonnegative(),
    videos: z.number().int().nonnegative(),
    shares: z.number().int().nonnegative(),
  }),
  files: z
    .array(
      z.strictObject({
        path: z.enum(BLOG_BUNDLE_FILES).exclude(['manifest.json']),
        bytes: z.number().int().nonnegative(),
        sha256: Sha256,
      }),
    )
    .max(BLOG_BUNDLE_FILES.length),
});
export type BundleManifest = z.infer<typeof BundleManifestSchema>;

export const BundlePostsSchema = z.array(BundlePostSchema).max(10_000);
export const BundleReleasesSchema = z.array(BundleReleaseSchema).max(1_000);
export const BundleVideosSchema = z.array(BundleVideoSchema).max(10_000);
export const BundleSharesSchema = z.array(BundleShareSchema).max(100_000);
