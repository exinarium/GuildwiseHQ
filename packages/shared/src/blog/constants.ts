/** The blog's fixed vocabulary and limits, shared by the API, the server pages and the UI. */

export const BLOG_TAGS = [
  { key: 'ai-agents', label: 'AI agents' },
  { key: 'automation', label: 'Automation' },
  { key: 'llm-ops', label: 'LLM ops' },
  { key: 'case-study', label: 'Case studies' },
  { key: 'how-to', label: 'How-to' },
  { key: 'industry-news', label: 'Industry news' },
] as const;
export const BLOG_TAG_KEYS = BLOG_TAGS.map((t) => t.key) as [string, ...string[]];
export const blogTagLabel = (key: string): string => BLOG_TAGS.find((t) => t.key === key)?.label ?? key;

/** The byline of every post (owner decision G8): never a fake human. */
export const BLOG_AUTHOR = 'The Guildwise HQ team';

/** One branded cover per tag, in apps/web/public/blog/. */
export const BLOG_COVER_KEYS = BLOG_TAG_KEYS;

export const BLOG_STATUSES = ['draft', 'in_review', 'published', 'rejected', 'unpublished'] as const;
export type BlogStatus = (typeof BLOG_STATUSES)[number];

export const BLOG_API_SCOPES = ['blog:read', 'blog:write', 'blog:publish', 'social:write'] as const;
export type BlogApiScope = (typeof BLOG_API_SCOPES)[number];

export const BLOG_LIMITS = {
  titleMin: 10,
  titleMax: 110,
  summaryMin: 80,
  summaryMax: 300,
  bodyMin: 1000,
  bodyMax: 40000,
  tagsMax: 5,
  sourcesMax: 15,
  /** Hard cap of posts one key may submit in a rolling 24 hours. */
  postsPer24h: 8,
  readsPerMinute: 60,
  writesPerHour: 10,
} as const;

/** Hand-written articles: looser than the writer's limits (a person's short note is fine), same maxima. */
export const MANUAL_POST_LIMITS = { titleMin: 3, summaryMin: 20, bodyMin: 1, authorMax: 80 } as const;
export const BLOG_IMAGE = {
  maxBytes: 5 * 1024 * 1024,
  perPost: 50,
  types: { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' },
} as const;
/** The only image URL the blog Markdown renders: an uploaded blog image on this site. */
export const BLOG_IMAGE_SRC_RE =
  /^\/blog\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif)$/;
/** Where an article came from: the blog writer (API or hosted job) or a person in the platform UI. */
export const BLOG_ORIGIN_KINDS = ['writer', 'manual'] as const;
export type BlogOriginKind = (typeof BLOG_ORIGIN_KINDS)[number];

export const SOCIAL_NETWORKS = ['facebook', 'linkedin', 'x', 'bluesky'] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];

/**
 * Networks that have a channel row (`social_channels`). YouTube is deliberately NOT in `SOCIAL_NETWORKS`: that list is
 * what the blog and release sweep shares to, and nothing but the video worker uploads to YouTube. Instagram and TikTok are
 * video-only destinations (Reels, Shorts) and are likewise not in `SOCIAL_NETWORKS`.
 */
export const SOCIAL_CHANNEL_NETWORKS = [...SOCIAL_NETWORKS, 'youtube', 'instagram', 'tiktok'] as const;
export type SocialChannelNetwork = (typeof SOCIAL_CHANNEL_NETWORKS)[number];

/**
 * The one source of truth for caption limits and hashtag counts per network. `text` is the caption alone (Facebook,
 * LinkedIn); `total` is everything the caption may hold except the link: for X the 280 characters minus the space and
 * the 23 a link counts (the hashtags share it), for Bluesky the 300 graphemes (the link is the card, not text).
 * `tags` is [min, max] hashtags: the max is enforced by the schema, the min is what the writer and the editor aim for.
 * The maxima leave room for the standing and popular pool tags `buildHashtags` adds to the topical ones.
 */
export const SOCIAL_LIMITS = {
  facebook: { text: 500, tags: [0, 5] },
  linkedin: { text: 700, tags: [3, 8] },
  x: { total: 256, tags: [1, 3] },
  bluesky: { total: 300, tags: [1, 3] },
} as const satisfies Record<
  SocialNetwork,
  { text?: number; total?: number; tags: readonly [number, number] }
>;

/** A hashtag without the `#`: starts with a letter, then letters, digits and underscores (2-50 characters). */
export const HASHTAG_RE = /^[\p{L}][\p{L}\p{N}_]{1,49}$/u;

/** The server-side blog writer. */
export const BLOG_WRITER = {
  /** Selectable models. Only the first has built-in prices; any other needs a price set by the super admin. */
  models: ['claude-haiku-4-5', 'claude-haiku-5-5'] as const,
  defaultModel: 'claude-haiku-4-5',
  defaultCapUsd: 10,
  maxCapUsd: 1000,
  /** US dollars per search of Anthropic's web search tool ($10 per 1,000 searches), editable. */
  defaultSearchUsd: 0.01,
  maxSearches: 5,
  topicsMax: 40,
  topicChars: 200,
  /** Slots (hour, UTC) of one or two posts a day: 08:00 and 15:00 Africa/Johannesburg (UTC+2, no daylight saving). */
  slotHoursUtc: { 1: [6], 2: [6, 13] } as Record<number, number[]>,
} as const;
export type BlogWriterModel = (typeof BLOG_WRITER.models)[number];

export const DEFAULT_WRITER_TOPICS: readonly string[] = [
  'How to give an AI agent a narrow job and a clear definition of done',
  'Reviewing AI agent output without slowing the team down',
  'Where AI automation helps a small business and where it does not',
  'Keeping a human in charge of a team of AI agents: approvals, budgets and kill switches',
  'What AI agents cost to run and how to keep the bill predictable',
  'Testing and evaluating AI agents before you trust them with real work',
  'Securing AI agents: secrets, permissions and prompt injection',
  'Automating routine operations with AI: reporting, triage and follow-ups',
  'Choosing between one general AI agent and several specialised ones',
  'Recent developments in AI agent tooling and what they mean for small teams',
];
