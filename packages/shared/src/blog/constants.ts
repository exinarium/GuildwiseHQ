/** The blog's fixed vocabulary and limits (docs/design/blog-prd.md section 5), shared by the API, the server pages and the UI. */

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

export const SOCIAL_NETWORKS = ['facebook', 'linkedin'] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];
