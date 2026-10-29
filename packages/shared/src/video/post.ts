import { z } from 'zod';
import {
  defaultSchedule,
  PatchVideoScheduleSchema,
  VIDEO_DESTINATIONS,
  VideoCaptionsSchema,
  VideoDestinationOptionsSchema,
  VideoScheduleSchema,
} from './schedule.ts';
import { VIDEO_FORMATS, VIDEO_KINDS, VideoMetaSchema, VideoScriptSchema } from './schema.ts';

/**
 * The review side of the YouTube push: video posts (one per kind, ref and format), their renders, the YouTube upload,
 * the platform setting and the Video topics list. Docs: docs/BLOG-API.md "YouTube".
 */

export const VIDEO_POST_STATUSES = ['draft', 'in_review', 'approved', 'rejected'] as const;
export type VideoPostStatus = (typeof VIDEO_POST_STATUSES)[number];
export const VIDEO_RENDER_STATUSES = ['queued', 'rendering', 'rendered', 'failed'] as const;
export type VideoRenderStatus = (typeof VIDEO_RENDER_STATUSES)[number];
export const VIDEO_PRIVACIES = ['public', 'unlisted', 'private'] as const;
export type VideoPrivacy = (typeof VIDEO_PRIVACIES)[number];

export const VIDEO_POST_LIMITS = {
  /** Renders (revisions) one post may use; a retry of the same revision does not count. */
  maxRenders: 3,
  /** Attempts at rendering one revision. */
  maxAttempts: 3,
  /** The worker is "not running" when its heartbeat is older than this. */
  heartbeatStaleSeconds: 180,
  categoryId: '28',
  /** A rendered video that nobody published is kept at most this long once its post is back in review (a preview). */
  previewKeepDays: 7,
  /** A failed destination keeps its MP4 this long for a retry. */
  failedKeepDays: 3,
  /** A rejected post's files go after this many days. */
  rejectedKeepDays: 1,
  /** The MP4 of a published video goes this long after its slot at the latest. */
  publishedKeepHours: 6,
  /** The disk budget of rendered videos (`AOM_VIDEO_MAX_BYTES`, default 5 GB) and the room a new render needs. */
  defaultMaxBytes: 5 * 1024 ** 3,
  renderReserveBytes: 300 * 1024 ** 2,
} as const;

/** The library import of the help videos: `lib:<slug>`. */
export const VIDEO_LIBRARY_PREFIX = 'lib:';
export const isLibraryRef = (ref: string): boolean => ref.startsWith(VIDEO_LIBRARY_PREFIX);

/** The metadata of a post: the script's `meta` plus the privacy the owner chose for this video (absent: the setting). */
export const VideoPostMetaSchema = VideoMetaSchema.extend({ privacy: z.enum(VIDEO_PRIVACIES).optional() });
export type VideoPostMeta = z.infer<typeof VideoPostMetaSchema>;

export const VideoSettingsSchema = z.object({
  /** The kill switch of everything video: off, nothing is drafted, rendered or uploaded. Default off. */
  enabled: z.boolean(),
  articleVideos: z.boolean(),
  releaseVideos: z.boolean(),
  tutorials: z.boolean(),
  shorts: z.boolean(),
  /** Deprecated: the schedule's number of long days. Used only to derive `schedule` while none was saved. */
  perWeek: z.number().int().min(0).max(14),
  /** Deprecated: the schedule's number of Short days. Used only to derive `schedule` while none was saved. */
  shortsPerWeek: z.number().int().min(0).max(14),
  /**
   * When each format goes out. Always present in what the server returns (derived from `perWeek` / `shortsPerWeek` until
   * the owner saves one); once saved the two counts are ignored.
   */
  schedule: VideoScheduleSchema,
  privacy: z.enum(VIDEO_PRIVACIES),
  /** YouTube playlist ids per kind (optional). */
  playlists: z.object({
    article: z.string().trim().max(100).optional(),
    release: z.string().trim().max(100).optional(),
    tutorial: z.string().trim().max(100).optional(),
  }),
  categoryId: z.string().regex(/^\d{1,3}$/),
});
export type VideoSettings = z.infer<typeof VideoSettingsSchema>;
export const DEFAULT_VIDEO_SETTINGS: VideoSettings = {
  enabled: false,
  articleVideos: true,
  releaseVideos: true,
  tutorials: true,
  shorts: true,
  perWeek: 3,
  shortsPerWeek: 3,
  schedule: defaultSchedule(3, 3),
  privacy: 'public',
  playlists: {},
  categoryId: VIDEO_POST_LIMITS.categoryId,
};
export const PatchVideoSettingsRequestSchema = VideoSettingsSchema.partial().extend({
  schedule: PatchVideoScheduleSchema.optional(),
  playlists: VideoSettingsSchema.shape.playlists.optional(),
});
export type PatchVideoSettingsRequest = z.infer<typeof PatchVideoSettingsRequestSchema>;

const IsoTime = z.iso.datetime();

export const VideoRenderSchema = z.object({
  id: z.uuid(),
  revision: z.number().int(),
  status: z.enum(VIDEO_RENDER_STATUSES),
  attempts: z.number().int(),
  error: z.string().nullable(),
  durationSeconds: z.number().nullable(),
  bytes: z.number().nullable(),
  createdAt: IsoTime,
  finishedAt: IsoTime.nullable(),
  /** Which files the preview route can serve: video, captionsVtt, captionsSrt, thumb, script, log. */
  files: z.array(z.string()),
  /** A library video: the existing help video is the artifact, nothing was rendered. */
  library: z.boolean(),
  /** The clean-up removed the MP4 (or all files): the kept thumbnail, captions and script can still be opened. */
  purged: z.boolean().default(false),
  /** The render does not start before this (the slot minus the render lead); null: at once. */
  notBefore: IsoTime.nullable().default(null),
  /** An explicit preview render of a script that is still in review. */
  preview: z.boolean().default(false),
});
export type VideoRender = z.infer<typeof VideoRenderSchema>;

export const VIDEO_UPLOAD_STATUSES = [
  'pending',
  'posting',
  'sent',
  'failed',
  'skipped',
  'locked_private',
] as const;
export const VideoUploadSchema = z.object({
  status: z.enum(VIDEO_UPLOAD_STATUSES),
  attempts: z.number().int(),
  videoId: z.string().nullable(),
  url: z.string().nullable(),
  error: z.string().nullable(),
  nextAttemptAt: IsoTime.nullable(),
  /** When YouTube makes the video public (the daily slot), or null (private/unlisted at once). */
  publishAt: IsoTime.nullable(),
  privacy: z.enum(VIDEO_PRIVACIES).nullable(),
  /** Steps that were skipped or failed without failing the upload ("thumbnail: the channel is not verified"). */
  warnings: z.array(z.string()),
});
export type VideoUpload = z.infer<typeof VideoUploadSchema>;

export const VIDEO_PHASES = [
  'scripted',
  'in_review',
  'scheduled',
  'rendering',
  'rendered',
  'publishing',
  'published',
  'partial',
  'failed',
  'rejected',
] as const;
export type VideoPhase = (typeof VIDEO_PHASES)[number];
export const VIDEO_PUBLISH_MODES = ['slot', 'now'] as const;

export const VideoShareSchema = z.object({
  network: z.enum(VIDEO_DESTINATIONS),
  status: z.enum(VIDEO_UPLOAD_STATUSES),
  url: z.string().nullable(),
  error: z.string().nullable(),
});
export type VideoShare = z.infer<typeof VideoShareSchema>;

export const VideoCrossPostSchema = z.object({
  id: z.uuid(),
  status: z.enum(['draft', 'in_review', 'approved', 'rejected']),
  title: z.string(),
  content: z.object({
    videoPostId: z.uuid(),
    title: z.string(),
    summary: z.string(),
    coverKey: z.literal('how-to'),
    captions: z.record(z.string(), z.unknown()),
  }),
  rejectionReason: z.string().nullable(),
  approvedAt: IsoTime.nullable(),
  shares: z.array(
    z.object({
      network: z.string(),
      status: z.string(),
      url: z.string().nullable(),
      error: z.string().nullable(),
    }),
  ),
});
export type VideoCrossPost = z.infer<typeof VideoCrossPostSchema>;

export const VideoPostSchema = z.object({
  id: z.uuid(),
  kind: z.enum(VIDEO_KINDS),
  format: z.enum(VIDEO_FORMATS),
  ref: z.string(),
  parentId: z.uuid().nullable(),
  status: z.enum(VIDEO_POST_STATUSES),
  title: z.string(),
  revision: z.number().int(),
  /** Null for a library video (its recorded help video is the artifact; there is no script). */
  script: VideoScriptSchema.nullable(),
  meta: VideoPostMetaSchema,
  rejectionReason: z.string().nullable(),
  origin: z.string().nullable(),
  reviewSince: IsoTime.nullable(),
  approvedAt: IsoTime.nullable(),
  approvedRenderId: z.uuid().nullable(),
  /** The slot the post goes out at (UTC), or null while it is not scheduled. */
  slotAt: IsoTime.nullable().default(null),
  /** `slot`: at `slotAt`. `now`: published as soon as it is rendered. */
  publishMode: z.enum(VIDEO_PUBLISH_MODES).nullable().default(null),
  destinations: z.array(z.enum(VIDEO_DESTINATIONS)).default([]),
  captions: VideoCaptionsSchema.nullable().default(null),
  destinationOptions: VideoDestinationOptionsSchema.nullable().default(null),
  /** When the system moved the post to a later slot because it was not rendered in time (null: it did not). */
  slippedAt: IsoTime.nullable().default(null),
  /** Where the post is in its life, derived from status, render and shares. */
  phase: z.enum(VIDEO_PHASES).default('in_review'),
  /** The share of every destination other than YouTube (YouTube is `upload`). */
  shares: z.array(VideoShareSchema).default([]),
  createdAt: IsoTime,
  updatedAt: IsoTime,
  /** The render of the current revision. */
  render: VideoRenderSchema.nullable(),
  /** How many renders the post has used of `VIDEO_POST_LIMITS.maxRenders`. */
  rendersUsed: z.number().int(),
  library: z.boolean(),
  /** The Short that belongs to this (long) video, if any. */
  shortId: z.uuid().nullable(),
  upload: VideoUploadSchema.nullable(),
  crossPost: VideoCrossPostSchema.nullable(),
});
export type VideoPost = z.infer<typeof VideoPostSchema>;

/**
 * `limit`: drafts the writer may add per rolling week (= the days ticked); `used`: its drafts of the last 7 days that were
 * not rejected; `backlog`: posts in review plus scheduled and not yet published. The writer stops when `used >= limit`
 * or `backlog >= backlogLimit`.
 */
export const VideoCapacityEntrySchema = z.object({
  used: z.number().int(),
  limit: z.number().int(),
  backlog: z.number().int(),
  backlogLimit: z.number().int(),
});
export const VideoCapacitySchema = z.object({
  long: VideoCapacityEntrySchema,
  short: VideoCapacityEntrySchema,
});
export type VideoCapacity = z.infer<typeof VideoCapacitySchema>;

export const VideoStatusSchema = z.object({
  settings: VideoSettingsSchema,
  /** A YouTube channel is connected and healthy. */
  channel: z.object({
    connected: z.boolean(),
    status: z.enum(['ok', 'needs_reconnect', 'disconnected']),
    accountName: z.string().nullable(),
  }),
  /** Settings enabled AND a channel with status ok: the condition for everything automatic. */
  active: z.boolean(),
  worker: z.object({ running: z.boolean(), lastSeen: IsoTime.nullable() }),
  capacity: VideoCapacitySchema,
  /** The next free slot per format (null while the schedule has no days). */
  nextSlot: z.object({ long: IsoTime.nullable(), short: IsoTime.nullable() }),
  /** Bytes of rendered videos on disk and the budget (`AOM_VIDEO_MAX_BYTES`). */
  storage: z.object({ usedBytes: z.number(), maxBytes: z.number() }),
  /** Scheduled posts whose slot is no longer one of the schedule's (the settings changed). */
  offSchedule: z.number().int().default(0),
  /** Posts waiting for the owner's approval. */
  pending: z.number().int(),
  /** Uploads whose video YouTube kept private. */
  lockedPrivate: z.number().int(),
  auditFormUrl: z.string(),
});
export type VideoStatus = z.infer<typeof VideoStatusSchema>;

export const VideoPostListSchema = z.object({ posts: z.array(VideoPostSchema), status: VideoStatusSchema });
export type VideoPostList = z.infer<typeof VideoPostListSchema>;

export const SubmitVideoPostRequestSchema = z.object({
  kind: z.enum(VIDEO_KINDS),
  format: z.enum(VIDEO_FORMATS),
  ref: z.string().trim().min(1).max(120),
  script: VideoScriptSchema,
  /** For a Short: the long video it belongs to. */
  parentId: z.uuid().optional(),
});
export type SubmitVideoPostRequest = z.infer<typeof SubmitVideoPostRequestSchema>;

export const EditVideoPostRequestSchema = z.object({
  /** A whole new script (cues, chapters and meta). */
  script: VideoScriptSchema.optional(),
  /** Just the metadata. Title, description and hashtags are in the rendered description and thumbnail: they re-render. */
  meta: VideoMetaSchema.partial().optional(),
  privacy: z.enum(VIDEO_PRIVACIES).nullable().optional(),
});
export type EditVideoPostRequest = z.infer<typeof EditVideoPostRequestSchema>;
export const ScheduleVideoPostRequestSchema = z.object({
  /** One of the schedule's slots; absent: the next free one. */
  slotAt: IsoTime.optional(),
  /** `now`: publish as soon as rendered (Shorts, and public long videos). */
  mode: z.enum(VIDEO_PUBLISH_MODES).default('slot'),
  /** Absent: the schedule's destinations of the format. */
  destinations: z.array(z.enum(VIDEO_DESTINATIONS)).min(1).optional(),
  captions: VideoCaptionsSchema.optional(),
  /** Choices a destination needs from the owner at scheduling time (TikTok: privacy, interactions, disclosure, consent). */
  destinationOptions: VideoDestinationOptionsSchema.optional(),
});
export type ScheduleVideoPostRequest = z.input<typeof ScheduleVideoPostRequestSchema>;
export const MoveVideoPostRequestSchema = z.object({ slotAt: IsoTime });
export const SwapVideoPostRequestSchema = z.object({ withId: z.uuid() });
export const UnscheduleVideoPostRequestSchema = z.object({ reason: z.string().trim().max(500).optional() });
export const VideoSlotsQuerySchema = z.object({
  format: z.enum(VIDEO_FORMATS),
  count: z.coerce.number().int().min(1).max(60).default(14),
});
export const VideoSlotListSchema = z.object({
  timezone: z.string(),
  slots: z.array(z.object({ at: IsoTime, postId: z.uuid().nullable(), free: z.boolean() })),
});
export type VideoSlotList = z.infer<typeof VideoSlotListSchema>;

export const RejectVideoPostRequestSchema = z.object({ reason: z.string().trim().min(1).max(2000) });

export const VideoLibraryEntrySchema = z.object({
  slug: z.string(),
  title: z.string(),
  durationSeconds: z.number(),
  chapters: z.number().int(),
  imported: z.boolean(),
});
export type VideoLibraryEntry = z.infer<typeof VideoLibraryEntrySchema>;
export const VideoLibraryListSchema = z.object({ videos: z.array(VideoLibraryEntrySchema) });
export const ImportVideoLibraryRequestSchema = z.object({
  /** The help videos to import; absent: all that are not imported yet. */
  slugs: z.array(z.string().trim().min(1).max(80)).max(200).optional(),
});

// ---- Video topics (like the blog topics): new "showcase" videos of what you can do with Guildwise HQ
export const VIDEO_TOPIC_LIMITS = { titleMax: 200, titleMin: 5, briefMax: 800 } as const;
export const VIDEO_TOPIC_STATUSES = ['queued', 'writing', 'drafted', 'rejected'] as const;
export const VideoTopicSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  brief: z.string(),
  origin: z.enum(['platform', 'writer']),
  status: z.enum(VIDEO_TOPIC_STATUSES),
  reason: z.string().nullable(),
  attempts: z.number().int(),
  postId: z.uuid().nullable(),
  queuedAt: IsoTime,
  updatedAt: IsoTime,
});
export type VideoTopic = z.infer<typeof VideoTopicSchema>;
export const VideoTopicListSchema = z.object({ topics: z.array(VideoTopicSchema), queued: z.number().int() });
export type VideoTopicList = z.infer<typeof VideoTopicListSchema>;
export const CreateVideoTopicRequestSchema = z.object({
  title: z.string().trim().min(VIDEO_TOPIC_LIMITS.titleMin).max(VIDEO_TOPIC_LIMITS.titleMax),
  brief: z.string().trim().max(VIDEO_TOPIC_LIMITS.briefMax).default(''),
});
export type CreateVideoTopicRequest = z.infer<typeof CreateVideoTopicRequestSchema>;
export const RejectVideoTopicRequestSchema = z.object({ reason: z.string().trim().min(1).max(500) });
