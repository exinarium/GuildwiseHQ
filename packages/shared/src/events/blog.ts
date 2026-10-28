import { z } from 'zod';
import { BLOG_API_SCOPES, SOCIAL_NETWORKS } from '../blog/constants.ts';
import { BlogContentSchema } from '../blog/schema.ts';
import { SOCIAL_POST_KINDS, SocialPostContentSchema } from '../blog/social-post.ts';
import { TOPIC_LIMITS, TopicAreaSchema } from '../blog/topic.ts';
import { defineEvent, Id, IsoDate } from './define.ts';

/** Who wrote a post: a platform API key, or a super admin typing in the platform UI. */
export const BlogOriginSchema = z.object({
  apiKeyId: Id.optional(),
  userId: Id.optional(),
  /** A platform job (no key, no person): the server-side blog writer. */
  system: z.literal('blog-writer').optional(),
});

const SettingsChange = z.object({
  enabled: z.boolean().optional(),
  /** From this instant posts auto-publish after the hold; before it every post waits for the owner. `null`: never auto-publish. */
  autoPublishFrom: IsoDate.nullable().optional(),
  holdHours: z.number().int().min(0).max(168).optional(),
  digestEnabled: z.boolean().optional(),
});

export const blogEvents = [
  defineEvent(
    'BlogPostSubmitted',
    z.object({
      postId: Id,
      content: BlogContentSchema,
      contentHash: z.string(),
      origin: BlogOriginSchema,
      /** `in_review` for API submissions; `draft` for a super admin's own first save. */
      status: z.enum(['draft', 'in_review']),
      /** Content-check findings (suspicious links, ...) that keep the post from auto-publishing. */
      warnings: z.array(z.string()).default([]),
      /** A launch-set article pre-loaded by the `blog-launch-2026-10` data migration: never shared to social networks, never in the digest. */
      launch: z.boolean().optional(),
      /** The queued research topic this article answers (`blog_topics.id`); absent for the rotation and for hand-written posts. */
      topicId: Id.optional(),
    }),
  ),
  defineEvent(
    'BlogPostRevised',
    z.object({
      postId: Id,
      content: BlogContentSchema,
      contentHash: z.string(),
      by: BlogOriginSchema,
      /** A rejected or draft post goes back to review when revised. */
      resubmit: z.boolean().default(true),
      warnings: z.array(z.string()).default([]),
    }),
  ),
  defineEvent(
    'BlogPostPublished',
    z.object({ postId: Id, auto: z.boolean(), by: BlogOriginSchema.optional() }),
  ),
  defineEvent('BlogPostRejected', z.object({ postId: Id, reason: z.string().min(1).max(2000), by: Id })),
  defineEvent('BlogPostUnpublished', z.object({ postId: Id, by: Id })),
  defineEvent('BlogSettingsChanged', z.object({ change: SettingsChange, by: Id })),
  /** The super admin changed the blog writer's settings (the values are summarised, never secrets). */
  defineEvent('BlogWriterSettingsChanged', z.object({ change: z.record(z.string(), z.unknown()), by: Id })),
  defineEvent(
    'ApiKeyCreated',
    z.object({
      keyId: Id,
      name: z.string().min(1).max(100),
      scopes: z.array(z.enum(BLOG_API_SCOPES)).min(1),
      prefix: z.string().min(4).max(16),
      expiresAt: IsoDate.nullable().optional(),
      by: Id,
    }),
  ),
  // ---- the research-topic queue (docs/design/ceo-blog-topics.md). Stream `blog-topics`; no organization anywhere.
  /**
   * A research question joined the writer's queue. Strict on purpose: a question, an area and a bucket, and nowhere to
   * put source material. Customer-origin topics are appended by the hand-off with the system actor and no causation id.
   */
  defineEvent(
    'BlogTopicQueued',
    z.strictObject({
      topicId: Id,
      question: z.string().min(TOPIC_LIMITS.questionMin).max(TOPIC_LIMITS.questionMax),
      area: TopicAreaSchema,
      origin: z.enum(['platform', 'customer']),
    }),
  ),
  /** The writer took the topic for a run (a run takes it for one attempt). */
  defineEvent('BlogTopicWriting', z.object({ topicId: Id, runId: Id })),
  /** The run failed for a technical reason: the topic is queued again, or declined after the second attempt. */
  defineEvent('BlogTopicReleased', z.object({ topicId: Id, runId: Id, reason: z.string().max(500) })),
  /** The writer found no public sources for the question (its `problem` field). */
  defineEvent(
    'BlogTopicDeclined',
    z.object({ topicId: Id, reason: z.string().max(500), runId: Id.nullable() }),
  ),
  /** A super admin removed the topic from the queue (or it was withdrawn with a customer's consent). */
  defineEvent(
    'BlogTopicRejected',
    z.object({ topicId: Id, reason: z.string().min(1).max(500), by: Id.nullable() }),
  ),
  /** The question is already covered by a published post (`postId`) or by another queued topic (`ofTopicId`). */
  defineEvent(
    'BlogTopicDuplicate',
    z.object({ topicId: Id, postId: Id.optional(), ofTopicId: Id.optional() }),
  ),
  /** A super admin moved a queued topic to the front of the queue. */
  defineEvent('BlogTopicMoved', z.object({ topicId: Id, by: Id })),
  defineEvent('ApiKeyRevoked', z.object({ keyId: Id, by: Id })),
  defineEvent(
    'UserDigestPreferenceSet',
    z.object({ userId: Id, optedIn: z.boolean(), via: z.enum(['signup', 'invite', 'settings', 'link']) }),
  ),
  defineEvent(
    'BlogDigestSent',
    z.object({
      digestId: z.string(),
      cutoff: IsoDate,
      postIds: z.array(Id),
      recipients: z.number().int().nonnegative(),
    }),
  ),
  defineEvent('BlogDigestSkipped', z.object({ digestId: z.string(), reason: z.string() })),
  defineEvent(
    'SocialChannelConnected',
    z.object({ network: z.enum(SOCIAL_NETWORKS), accountName: z.string().max(200), by: Id }),
  ),
  defineEvent('SocialChannelDisconnected', z.object({ network: z.enum(SOCIAL_NETWORKS), by: Id })),
  // ---- social posts that are not articles (a release announcement). Stream `social-post-<postId>`.
  defineEvent(
    'SocialPostSubmitted',
    z.object({
      postId: Id,
      kind: z.enum(SOCIAL_POST_KINDS),
      /** For a release: its version. One post per kind and ref. */
      ref: z.string().min(1).max(100),
      content: SocialPostContentSchema,
      origin: BlogOriginSchema,
      status: z.enum(['draft', 'in_review']),
    }),
  ),
  defineEvent(
    'SocialPostRevised',
    z.object({ postId: Id, content: SocialPostContentSchema, by: BlogOriginSchema }),
  ),
  /** A draft goes to the super admin's review queue. */
  defineEvent('SocialPostReviewRequested', z.object({ postId: Id, by: Id })),
  /** Always a person: a release post never publishes by itself. */
  defineEvent('SocialPostApproved', z.object({ postId: Id, by: Id })),
  defineEvent('SocialPostRejected', z.object({ postId: Id, reason: z.string().min(1).max(2000), by: Id })),
  defineEvent(
    'SocialShareSucceeded',
    z.object({
      postId: Id,
      network: z.enum(SOCIAL_NETWORKS),
      externalId: z.string(),
      url: z.string().nullable(),
    }),
  ),
  defineEvent(
    'SocialShareFailed',
    z.object({
      postId: Id,
      network: z.enum(SOCIAL_NETWORKS),
      error: z.string().max(500),
      final: z.boolean(),
    }),
  ),
];
