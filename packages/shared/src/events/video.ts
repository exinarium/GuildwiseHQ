import { z } from 'zod';
import { VideoPostMetaSchema } from '../video/post.ts';
import { VIDEO_DESTINATIONS, VideoCaptionsSchema } from '../video/schedule.ts';
import { VIDEO_FORMATS, VIDEO_KINDS, VideoScriptSchema } from '../video/schema.ts';
import { BlogOriginSchema } from './blog.ts';
import { defineEvent, Id } from './define.ts';

/**
 * The YouTube push. Streams `video-<postId>` (posts) and `video-topics` / `video-settings`. Renders and the upload are
 * operational (tables `video_renders`, `social_shares`), only the owner's decisions and the drafts are events.
 */
export const videoEvents = [
  defineEvent(
    'VideoPostSubmitted',
    z.object({
      postId: Id,
      kind: z.enum(VIDEO_KINDS),
      format: z.enum(VIDEO_FORMATS),
      /** Article slug, release version, topic id or `lib:<slug>`. One post per kind, ref and format. */
      ref: z.string().min(1).max(120),
      /** A Short points at its long video. */
      parentId: Id.optional(),
      /** Null for a library video: the recorded help video is the artifact. */
      script: VideoScriptSchema.nullable(),
      meta: VideoPostMetaSchema,
      origin: BlogOriginSchema,
      status: z.enum(['draft', 'in_review']),
    }),
  ),
  /** An edit. `rerender`: the render changes (new revision, new render); else only metadata changed. */
  defineEvent(
    'VideoPostRevised',
    z.object({
      postId: Id,
      script: VideoScriptSchema.nullable(),
      meta: VideoPostMetaSchema,
      revision: z.number().int().min(1),
      rerender: z.boolean(),
      by: BlogOriginSchema,
    }),
  ),
  /**
   * Always a person. Scheduling a post is approving it: `renderId` is absent now (nothing is rendered before the owner
   * approves the script; the worker uses the render of the post's revision) and present on older events.
   */
  defineEvent('VideoPostApproved', z.object({ postId: Id, renderId: Id.optional(), by: Id })),
  /**
   * The slot of an approved post (appended right after `VideoPostApproved`, and again for a move, a swap, a slip by the
   * system or a re-flow). `mode` `now`: published as soon as it is rendered.
   */
  defineEvent(
    'VideoPostScheduled',
    z.object({
      postId: Id,
      slotAt: z.iso.datetime(),
      mode: z.enum(['slot', 'now']),
      destinations: z.array(z.enum(VIDEO_DESTINATIONS)).min(1),
      captions: VideoCaptionsSchema.optional(),
      reason: z.enum(['approved', 'moved', 'slipped', 'reflow', 'migrated']),
      by: z.union([Id, z.literal('system')]),
    }),
  ),
  /** Back to review: refused once any destination has the video or is posting. */
  defineEvent(
    'VideoPostUnscheduled',
    z.object({ postId: Id, reason: z.string().max(500).optional(), by: Id }),
  ),
  /** The owner asked for a preview render of the current revision (audit only; the render row is operational). */
  defineEvent('VideoPreviewRequested', z.object({ postId: Id, revision: z.number().int().min(1), by: Id })),
  defineEvent('VideoPostRejected', z.object({ postId: Id, reason: z.string().min(1).max(2000), by: Id })),
  /** YouTube kept the uploaded video private although another privacy was requested (the audit is missing). */
  defineEvent('VideoUploadLockedPrivate', z.object({ postId: Id, videoId: z.string().max(40) })),
  /** The owner asked for a render or an upload to be tried again, or said a locked upload was dealt with. */
  defineEvent(
    'VideoRetryRequested',
    z.object({ postId: Id, what: z.enum(['render', 'upload', 'resolve-locked']), by: Id }),
  ),
  defineEvent(
    'VideoSettingsChanged',
    z.object({
      change: z.record(z.string(), z.unknown()),
      by: Id,
    }),
  ),
  defineEvent(
    'VideoTopicQueued',
    z.object({
      topicId: Id,
      title: z.string().min(1).max(200),
      brief: z.string().max(800),
      origin: z.enum(['platform', 'writer']),
      by: Id.nullable(),
    }),
  ),
  /** A writer run took the topic. */
  defineEvent('VideoTopicTaken', z.object({ topicId: Id })),
  /** The run failed: the topic is queued again (after two failures it is rejected). */
  defineEvent('VideoTopicReleased', z.object({ topicId: Id, reason: z.string().max(500).optional() })),
  defineEvent(
    'VideoTopicRejected',
    z.object({ topicId: Id, reason: z.string().min(1).max(500), by: Id.nullable() }),
  ),
  defineEvent('VideoTopicMoved', z.object({ topicId: Id, by: Id })),
] as const;
