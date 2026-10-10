import { z } from 'zod';
import { BLOG_API_SCOPES, BLOG_STATUSES, BLOG_WRITER, SOCIAL_NETWORKS } from '../blog/constants.ts';
import { BlogContentSchema, BlogSlugSchema } from '../blog/schema.ts';
import { IsoTime } from './common.ts';

/** The blog and its agent API (docs/design/blog-prd.md, docs/BLOG-API.md). */

export const BlogStatusSchema = z.enum(BLOG_STATUSES);
export const BlogApiScopeSchema = z.enum(BLOG_API_SCOPES);
export const SocialNetworkSchema = z.enum(SOCIAL_NETWORKS);

export const BlogShareSchema = z.object({
  network: SocialNetworkSchema,
  status: z.enum(['pending', 'sent', 'failed', 'skipped']),
  attempts: z.number().int(),
  externalId: z.string().nullable(),
  url: z.string().nullable(),
  error: z.string().nullable(),
  nextAttemptAt: IsoTime.nullable(),
});
export type BlogShare = z.infer<typeof BlogShareSchema>;

export const BlogPostSchema = BlogContentSchema.extend({
  id: z.uuid(),
  status: BlogStatusSchema,
  rejectionReason: z.string().nullable(),
  publishedAt: IsoTime.nullable(),
  createdAt: IsoTime,
  updatedAt: IsoTime,
  readingMinutes: z.number().int(),
  wordCount: z.number().int(),
  warnings: z.array(z.string()),
  /** The key's name or the author's name; platform views only. */
  origin: z.string().nullable(),
  /** When the post will publish by itself (hold window), null if it waits for the owner. */
  autoPublishAt: IsoTime.nullable(),
  shares: z.array(BlogShareSchema),
});
export type BlogPost = z.infer<typeof BlogPostSchema>;

/** A published post as the public pages and Help show it. */
export const PublicBlogPostSchema = BlogContentSchema.pick({
  slug: true,
  title: true,
  summary: true,
  coverImage: true,
  tags: true,
}).extend({
  publishedAt: IsoTime,
  updatedAt: IsoTime,
  readingMinutes: z.number().int(),
  url: z.string(),
});
export type PublicBlogPost = z.infer<typeof PublicBlogPostSchema>;
export const PublicBlogPostFullSchema = PublicBlogPostSchema.extend({
  bodyMarkdown: z.string(),
  sources: BlogContentSchema.shape.sources,
  author: z.string(),
});
export type PublicBlogPostFull = z.infer<typeof PublicBlogPostFullSchema>;

export const PublicBlogListSchema = z.object({
  posts: z.array(PublicBlogPostSchema),
  total: z.number().int(),
});

// ---- agent API (Bearer key)
export const ApiPostsQuerySchema = z.object({
  since: z.string().max(40).optional(),
  tag: z.string().max(40).optional(),
  q: z.string().max(200).optional(),
  status: BlogStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const ApiSlugParamsSchema = z.object({ slug: BlogSlugSchema });
export const ApiPatchPostSchema = BlogContentSchema.omit({ slug: true }).partial();
export const ApiShareRequestSchema = z.object({
  channels: z.array(SocialNetworkSchema).min(1).default(['facebook', 'linkedin']),
});

// ---- platform: keys, posts, settings
export const ApiKeySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(BlogApiScopeSchema),
  createdAt: IsoTime,
  expiresAt: IsoTime.nullable(),
  revokedAt: IsoTime.nullable(),
  lastUsedAt: IsoTime.nullable(),
  lastIp: z.string().nullable(),
  ipAllowList: z.array(z.string()),
  requests24h: z.number().int(),
  posts24h: z.number().int(),
});
export type ApiKey = z.infer<typeof ApiKeySchema>;
export const CreateApiKeyRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(BlogApiScopeSchema).min(1),
  expiresAt: z.iso.datetime().nullable().optional(),
  ipAllowList: z.array(z.string().trim().min(3).max(64)).max(20).default([]),
});
export const CreatedApiKeySchema = ApiKeySchema.extend({
  /** Shown once. */
  secret: z.string(),
});
export const ApiKeyAuditRowSchema = z.object({
  at: IsoTime,
  keyId: z.uuid(),
  keyName: z.string(),
  method: z.string(),
  path: z.string(),
  status: z.number().int(),
  ip: z.string().nullable(),
});

export const BlogSettingsSchema = z.object({
  /** The kill switch: off stops creating (API rejects) and publishing (no auto-publish, digest or social). */
  enabled: z.boolean(),
  autoPublishFrom: IsoTime.nullable(),
  holdHours: z.number().int(),
  digestEnabled: z.boolean(),
  /** True while the owner still reviews every post (before `autoPublishFrom`). */
  reviewAll: z.boolean(),
});
export type BlogSettings = z.infer<typeof BlogSettingsSchema>;
export const PatchBlogSettingsRequestSchema = z.object({
  enabled: z.boolean().optional(),
  autoPublishFrom: z.iso.datetime().nullable().optional(),
  holdHours: z.number().int().min(0).max(168).optional(),
  digestEnabled: z.boolean().optional(),
});

export const PlatformBlogQuerySchema = z.object({ status: BlogStatusSchema.optional() });
export const PlatformBlogListSchema = z.object({
  posts: z.array(BlogPostSchema),
  pending: z.number().int(),
  settings: BlogSettingsSchema,
});
export const RejectBlogPostRequestSchema = z.object({ reason: z.string().trim().min(1).max(2000) });
export const EditBlogPostRequestSchema = BlogContentSchema.omit({ slug: true }).partial();
export const CreateBlogPostRequestSchema = BlogContentSchema;

// ---- digest preference
export const DigestPreferenceSchema = z.object({ optedIn: z.boolean(), isOwner: z.boolean() });
export const SetDigestPreferenceRequestSchema = z.object({ optedIn: z.boolean() });

// ---- social
export const SocialChannelSchema = z.object({
  network: SocialNetworkSchema,
  connected: z.boolean(),
  accountName: z.string().nullable(),
  status: z.enum(['ok', 'needs_reconnect', 'disconnected']),
  expiresAt: IsoTime.nullable(),
  connectedAt: IsoTime.nullable(),
});
export type SocialChannel = z.infer<typeof SocialChannelSchema>;
export const ConnectSocialChannelRequestSchema = z.object({
  /** Facebook: the Page id; LinkedIn: the organization id. */
  accountId: z.string().trim().min(1).max(100),
  accountName: z.string().trim().max(200).default(''),
  accessToken: z.string().trim().min(10).max(4000),
  refreshToken: z.string().trim().max(4000).optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
});
export const SocialNetworkParamsSchema = z.object({ network: SocialNetworkSchema });

// ---- the server-side blog writer (platform job; super admin only)
export const BlogWriterPriceSchema = z.object({
  /** US dollars per million input tokens. */
  inputPerMTok: z.number().min(0).max(1000),
  /** US dollars per million output tokens. */
  outputPerMTok: z.number().min(0).max(1000),
});
export type BlogWriterPrice = z.infer<typeof BlogWriterPriceSchema>;

export const BlogWriterRunSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['scheduled', 'manual']),
  status: z.enum(['running', 'ok', 'failed', 'skipped']),
  slot: z.string().nullable(),
  topic: z.string().nullable(),
  model: z.string().nullable(),
  startedAt: IsoTime,
  finishedAt: IsoTime.nullable(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  searches: z.number().int(),
  costUsd: z.number(),
  postId: z.uuid().nullable(),
  slug: z.string().nullable(),
  error: z.string().nullable(),
});
export type BlogWriterRun = z.infer<typeof BlogWriterRunSchema>;

export const BlogWriterSchema = z.object({
  enabled: z.boolean(),
  /** 0 = off, 1 or 2 posts a day. */
  postsPerDay: z.number().int().min(0).max(2),
  topics: z.array(z.string()),
  model: z.string(),
  models: z.array(z.string()),
  /** Prices in use per selectable model; null when unknown (the writer refuses to run on it). */
  prices: z.record(z.string(), BlogWriterPriceSchema.nullable()),
  priceOverrides: z.record(z.string(), BlogWriterPriceSchema),
  searchUsd: z.number(),
  capUsd: z.number(),
  spentMonthUsd: z.number(),
  runsMonth: z.number().int(),
  postsMonth: z.number().int(),
  month: z.string(),
  /** What one more run is expected to cost (used to stop before the cap is passed). */
  estimateRunUsd: z.number(),
  keyConfigured: z.boolean(),
  blogEnabled: z.boolean(),
  /** Why the writer would not run right now (null: it would). */
  blockedReason: z.string().nullable(),
  nextSlot: IsoTime.nullable(),
  lastRun: BlogWriterRunSchema.nullable(),
  runs: z.array(BlogWriterRunSchema),
});
export type BlogWriter = z.infer<typeof BlogWriterSchema>;

export const PatchBlogWriterRequestSchema = z.object({
  enabled: z.boolean().optional(),
  postsPerDay: z.number().int().min(0).max(2).optional(),
  topics: z.array(z.string().trim().min(3).max(BLOG_WRITER.topicChars)).max(BLOG_WRITER.topicsMax).optional(),
  model: z.string().trim().min(1).max(100).optional(),
  capUsd: z.number().min(0).max(BLOG_WRITER.maxCapUsd).optional(),
  searchUsd: z.number().min(0).max(1).optional(),
  /** Sets (or, with null, clears) the price override of one model. */
  price: z
    .object({ model: z.string().trim().min(1).max(100), value: BlogWriterPriceSchema.nullable() })
    .optional(),
});
export type PatchBlogWriterRequest = z.infer<typeof PatchBlogWriterRequestSchema>;

export const BlogWriterRunResultSchema = z.object({
  run: BlogWriterRunSchema,
  post: BlogPostSchema.nullable(),
});
