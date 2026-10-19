import { z } from 'zod';

/**
 * A blog research topic (docs/design/ceo-blog-topics.md section 2.2): one generic question and an area. This is the
 * whole payload that may reach the blog writer: no context, no example, no source material.
 */
export const TOPIC_AREAS = [
  'deploy',
  'sandbox',
  'auth',
  'secrets',
  'agent-loops',
  'context-limits',
  'cost',
  'testing',
  'review',
  'integrations',
  'other',
] as const;
export const TopicAreaSchema = z.enum(TOPIC_AREAS);
export type TopicArea = z.infer<typeof TopicAreaSchema>;

export const TOPIC_AUDIENCES = ['developer', 'ops', 'founder'] as const;

export const TOPIC_LIMITS = { questionMin: 30, questionMax: 160, maxDigits: 3 } as const;

/** Where a queued topic came from. `customer` carries no identity of any kind. */
export const TOPIC_ORIGINS = ['platform', 'customer'] as const;
export type TopicOrigin = (typeof TOPIC_ORIGINS)[number];

/** Lifecycle of a platform-side topic (`blog_topics.status`). */
export const TOPIC_STATUSES = [
  'queued',
  'writing',
  'drafted',
  'published',
  'declined',
  'rejected',
  'duplicate',
] as const;
export type TopicStatus = (typeof TOPIC_STATUSES)[number];

export const TopicProposalSchema = z.object({
  question: z.string().min(TOPIC_LIMITS.questionMin).max(TOPIC_LIMITS.questionMax),
  area: TopicAreaSchema,
  audience: z.enum(TOPIC_AUDIENCES).optional(),
});
export type TopicProposal = z.infer<typeof TopicProposalSchema>;

/** How many topic articles a customer organization may feed the blog per month (owner decision, section 11). */
export const CUSTOMER_TOPICS_PER_MONTH = 4;
