import { z } from 'zod';
import { SocialCaptionsSchema } from './schema.ts';

/**
 * Social posts that are not blog articles: the announcement of a core release (`release`) and the optional cross-post of a
 * tutorial video (`video`, see `VideoSocialPostContentSchema`). They are drafted (by hand,
 * or by a hosting business's drafter), always approved by the super admin, and shared by the same sweep as blog posts.
 */
export const SOCIAL_POST_KINDS = ['release', 'video'] as const;
export type SocialPostKind = (typeof SOCIAL_POST_KINDS)[number];

export const SOCIAL_POST_STATUSES = ['draft', 'in_review', 'approved', 'rejected'] as const;
export type SocialPostStatus = (typeof SOCIAL_POST_STATUSES)[number];

export const SOCIAL_POST_LIMITS = { titleMin: 10, titleMax: 110, summaryMin: 40, summaryMax: 300 } as const;

/** `1.2.0`: a release is named by its three-part version. */
export const ReleaseVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/, 'a version such as 1.2.0');

export const SocialPostContentSchema = z.object({
  version: ReleaseVersionSchema,
  /** `YYYY-MM-DD`, from the changelog. */
  releasedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  title: z.string().min(SOCIAL_POST_LIMITS.titleMin).max(SOCIAL_POST_LIMITS.titleMax),
  /** Plain text: the description of the link card and the fallback caption. */
  summary: z.string().min(SOCIAL_POST_LIMITS.summaryMin).max(SOCIAL_POST_LIMITS.summaryMax),
  /** The one static branded cover (`/blog/cover/release.png`). */
  coverKey: z.literal('release'),
  captions: SocialCaptionsSchema,
});
export type SocialPostContent = z.infer<typeof SocialPostContentSchema>;

/** What a release lists, by Keep a Changelog section (Removed and Deprecated count as changed, Security as fixed). */
export const ReleaseSectionsSchema = z.object({
  added: z.array(z.string()),
  changed: z.array(z.string()),
  fixed: z.array(z.string()),
});
export type ReleaseSections = z.infer<typeof ReleaseSectionsSchema>;

export const ReleaseWhatsNewSchema = z.object({
  id: z.string(),
  title: z.string(),
  date: z.string(),
  body: z.string(),
});
export type ReleaseWhatsNew = z.infer<typeof ReleaseWhatsNewSchema>;

/** One release as the manifest knows it: the changelog section and the public What's New entries that belong to it. */
export const ReleaseSchema = z.object({
  version: ReleaseVersionSchema,
  date: z.string(),
  /** The line under the heading in the changelog, if any. */
  intro: z.string(),
  sections: ReleaseSectionsSchema,
  whatsNew: z.array(ReleaseWhatsNewSchema),
});
export type Release = z.infer<typeof ReleaseSchema>;

/**
 * The cross-post of a tutorial or showcase video (kind `video`, ref = the video post id): the link is the YouTube watch URL,
 * read from the upload when the post is shared. Approved separately from the video itself.
 */
export const VideoSocialPostContentSchema = z.object({
  /** The `video_posts` row this announces. */
  videoPostId: z.uuid(),
  title: z.string().min(SOCIAL_POST_LIMITS.titleMin).max(SOCIAL_POST_LIMITS.titleMax),
  summary: z.string().min(SOCIAL_POST_LIMITS.summaryMin).max(SOCIAL_POST_LIMITS.summaryMax),
  coverKey: z.literal('how-to'),
  captions: SocialCaptionsSchema,
});
export type VideoSocialPostContent = z.infer<typeof VideoSocialPostContentSchema>;

/** What a social post row can hold: a release's content or a video's. */
export const AnySocialPostContentSchema = z.union([SocialPostContentSchema, VideoSocialPostContentSchema]);
export type AnySocialPostContent = z.infer<typeof AnySocialPostContentSchema>;
