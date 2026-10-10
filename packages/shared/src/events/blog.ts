import { z } from 'zod';
import { BLOG_API_SCOPES, SOCIAL_NETWORKS } from '../blog/constants.ts';
import { BlogContentSchema } from '../blog/schema.ts';
import { defineEvent, Id, IsoDate } from './define.ts';

/** Who wrote a post: a platform API key, or a super admin typing in the platform UI. */
export const BlogOriginSchema = z.object({ apiKeyId: Id.optional(), userId: Id.optional() });

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
