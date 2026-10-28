import { z } from 'zod';
import {
  BLOG_API_SCOPES,
  BLOG_STATUSES,
  BLOG_WRITER,
  SOCIAL_CHANNEL_NETWORKS,
  SOCIAL_NETWORKS,
} from '../blog/constants.ts';
import { BlogContentSchema, BlogSlugSchema } from '../blog/schema.ts';
import {
  ReleaseSchema,
  ReleaseVersionSchema,
  SOCIAL_POST_KINDS,
  SOCIAL_POST_STATUSES,
  SocialPostContentSchema,
} from '../blog/social-post.ts';
import { TOPIC_LIMITS, TOPIC_ORIGINS, TOPIC_STATUSES, TopicAreaSchema } from '../blog/topic.ts';
import { IsoTime } from './common.ts';

/** The blog and its agent API. */

export const BlogStatusSchema = z.enum(BLOG_STATUSES);
export const BlogApiScopeSchema = z.enum(BLOG_API_SCOPES);
export const SocialNetworkSchema = z.enum(SOCIAL_NETWORKS);
/** A network with a channel row: the four share networks and YouTube (uploads only, never shared to by the sweep). */
export const SocialChannelNetworkSchema = z.enum(SOCIAL_CHANNEL_NETWORKS);

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
  channels: z.array(SocialNetworkSchema).min(1).default(['facebook', 'linkedin', 'x', 'bluesky']),
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
  network: SocialChannelNetworkSchema,
  connected: z.boolean(),
  accountName: z.string().nullable(),
  status: z.enum(['ok', 'needs_reconnect', 'disconnected']),
  expiresAt: IsoTime.nullable(),
  connectedAt: IsoTime.nullable(),
});
export type SocialChannel = z.infer<typeof SocialChannelSchema>;
/** Facebook and LinkedIn: one pasted token. */
export const ConnectTokenChannelSchema = z.object({
  /** Facebook: the Page id; LinkedIn: the organization id. */
  accountId: z
    .string()
    .trim()
    .min(1)
    .max(150)
    // LinkedIn: a pasted `urn:li:organization:5515715` is stored as `5515715` (the server adds the prefix).
    .transform((v) => v.replace(/^urn:li:organization:/i, '').trim())
    .pipe(z.string().min(1).max(100)),
  accountName: z.string().trim().max(200).default(''),
  accessToken: z.string().trim().min(10).max(4000),
  refreshToken: z.string().trim().max(4000).optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
});
/** X: OAuth 1.0a user context keys. They do not expire. */
export const ConnectXChannelSchema = z.object({
  apiKey: z.string().trim().min(5).max(200),
  apiSecret: z.string().trim().min(5).max(200),
  accessToken: z.string().trim().min(5).max(200),
  accessSecret: z.string().trim().min(5).max(200),
  accountName: z.string().trim().max(200).default(''),
});
/** Bluesky: the handle and an app password (a session is created per post). */
export const ConnectBlueskyChannelSchema = z.object({
  handle: z.string().trim().min(3).max(253),
  appPassword: z.string().trim().min(8).max(100),
});
/** YouTube: a refresh token of the channel's Google account (scope youtube.force-ssl), pasted; validated with channels.list. */
export const ConnectYoutubeChannelSchema = z.strictObject({
  refreshToken: z.string().trim().min(10).max(4000),
});
export const ConnectSocialChannelRequestSchema = z.union([
  ConnectXChannelSchema,
  ConnectBlueskyChannelSchema,
  ConnectTokenChannelSchema,
  ConnectYoutubeChannelSchema,
]);
export type ConnectSocialChannelRequest = z.infer<typeof ConnectSocialChannelRequestSchema>;
export const SocialNetworkParamsSchema = z.object({ network: SocialChannelNetworkSchema });

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
  kind: z.enum(['scheduled', 'manual', 'release']),
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
  /** How many of a day's articles may come from the topic queue before the rotation (default 1). */
  queuedPerDay: z.number().int().min(0).max(10).default(1),
  /** Draft a social post for each new core release (always held for the super admin's approval). Default on. */
  releasePosts: z.boolean().default(true),
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
  queuedPerDay: z.number().int().min(0).max(10).optional(),
  releasePosts: z.boolean().optional(),
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

// ---- the research-topic queue (docs/design/ceo-blog-topics.md). No organization appears in any of it.

export const BlogTopicSchema = z.object({
  id: z.uuid(),
  question: z.string(),
  area: TopicAreaSchema,
  origin: z.enum(TOPIC_ORIGINS),
  status: z.enum(TOPIC_STATUSES),
  reason: z.string().nullable(),
  postId: z.uuid().nullable(),
  slug: z.string().nullable(),
  queuedAt: IsoTime,
  updatedAt: IsoTime,
});
export type BlogTopic = z.infer<typeof BlogTopicSchema>;

export const BlogTopicListSchema = z.object({
  topics: z.array(BlogTopicSchema),
  queued: z.number().int(),
});
export type BlogTopicList = z.infer<typeof BlogTopicListSchema>;

export const CreateBlogTopicRequestSchema = z.object({
  question: z
    .string()
    .trim()
    .min(1)
    .max(TOPIC_LIMITS.questionMax + 40),
  area: TopicAreaSchema,
  /** Proper nouns the super admin confirms are public (the scrubber's `unknown_proper_noun` override). */
  allowTerms: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
});
export type CreateBlogTopicRequest = z.infer<typeof CreateBlogTopicRequestSchema>;

export const RejectBlogTopicRequestSchema = z.object({ reason: z.string().trim().min(1).max(500) });

// ---- release announcements (social posts that are not articles)
export const SocialPostSchema = z.object({
  id: z.uuid(),
  kind: z.enum(SOCIAL_POST_KINDS),
  ref: z.string(),
  status: z.enum(SOCIAL_POST_STATUSES),
  title: z.string(),
  content: SocialPostContentSchema,
  rejectionReason: z.string().nullable(),
  /** The person's name, or "Blog writer" for the hosted drafter. */
  origin: z.string().nullable(),
  reviewSince: IsoTime.nullable(),
  approvedAt: IsoTime.nullable(),
  createdAt: IsoTime,
  updatedAt: IsoTime,
  shares: z.array(BlogShareSchema),
});
export type SocialPost = z.infer<typeof SocialPostSchema>;

/** A release of the product with the post that announces it (null: none yet). */
export const ReleaseRowSchema = ReleaseSchema.extend({ post: SocialPostSchema.nullable() });
export type ReleaseRow = z.infer<typeof ReleaseRowSchema>;
export const ReleaseListSchema = z.object({
  releases: z.array(ReleaseRowSchema),
  /** Posts waiting for the super admin's approval. */
  pending: z.number().int(),
});
export type ReleaseList = z.infer<typeof ReleaseListSchema>;

/** Start a post for a release: the captions are prefilled from the manifest for the super admin to write by hand. */
export const CreateSocialPostRequestSchema = z.object({
  kind: z.enum(SOCIAL_POST_KINDS),
  ref: ReleaseVersionSchema,
});
export const EditSocialPostRequestSchema = SocialPostContentSchema.pick({
  title: true,
  summary: true,
  captions: true,
}).partial();
export const RejectSocialPostRequestSchema = z.object({ reason: z.string().trim().min(1).max(2000) });
