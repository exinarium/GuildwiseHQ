import { createReadStream, existsSync, statSync } from 'node:fs';
import {
  CreateVideoTopicRequestSchema,
  EditVideoPostRequestSchema,
  IdParamsSchema,
  ImportVideoLibraryRequestSchema,
  MoveVideoPostRequestSchema,
  PatchVideoSettingsRequestSchema,
  RejectVideoPostRequestSchema,
  RejectVideoTopicRequestSchema,
  ScheduleVideoPostRequestSchema,
  SubmitVideoPostRequestSchema,
  SwapVideoPostRequestSchema,
  UnscheduleVideoPostRequestSchema,
  VIDEO_POST_STATUSES,
  VideoSlotsQuerySchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireSuperAdmin } from '../auth/guards.ts';
import {
  approveVideoPost,
  articlesNeedingVideo,
  artifactKeyOf,
  artifactPath,
  createVideoCrossPost,
  getVideoPost,
  importLibrary,
  listLibrary,
  listSlots,
  listVideoPosts,
  listVideoTopics,
  moveVideoPost,
  moveVideoTopicUp,
  patchVideoSettings,
  previewVideoPost,
  queueVideoTopic,
  rejectVideoPost,
  rejectVideoTopic,
  releasesNeedingVideo,
  resolveLockedUpload,
  retryRender,
  retryUpload,
  reviseVideoPost,
  scheduleVideoPost,
  submitVideoPost,
  swapVideoPosts,
  unscheduleVideoPost,
  videoSettings,
  videoStatus,
} from '../commands/video-posts.ts';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import { badRequest, notFound } from '../errors.ts';
import { typed } from './util.ts';

const TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  vtt: 'text/vtt; charset=utf-8',
  srt: 'text/plain; charset=utf-8',
  png: 'image/png',
  json: 'application/json',
  log: 'text/plain; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
};

/** Super admin routes of the YouTube push: review queue, settings, library, topics and the preview files (404 for everyone else). */
export function videoPlatformRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get(
      '/api/platform/video',
      { schema: { querystring: z.object({ status: z.enum(VIDEO_POST_STATUSES).optional() }) } },
      async (req) => {
        await requireSuperAdmin(ctx, req);
        return listVideoPosts(ctx, req.query.status ? { status: req.query.status } : {});
      },
    );
    app.get('/api/platform/video/status', async (req) => {
      await requireSuperAdmin(ctx, req);
      return videoStatus(ctx);
    });
    app.get('/api/platform/video/settings', async (req) => {
      await requireSuperAdmin(ctx, req);
      return videoSettings(ctx);
    });
    app.patch(
      '/api/platform/video/settings',
      { schema: { body: PatchVideoSettingsRequestSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        return patchVideoSettings(ctx, s.user, req.body);
      },
    );

    /** Articles and releases of the last week that have no video yet (for a hosting business's drafter button). */
    app.get('/api/platform/video/needing', async (req) => {
      await requireSuperAdmin(ctx, req);
      const [articles, releases] = await Promise.all([articlesNeedingVideo(ctx), releasesNeedingVideo(ctx)]);
      return {
        articles: articles.map((a) => ({ slug: a.slug, title: a.title, publishedAt: a.publishedAt })),
        releases: releases.map((r) => ({ version: r.version, date: r.date })),
      };
    });

    // ---- posts
    app.post(
      '/api/platform/video/posts',
      { schema: { body: SubmitVideoPostRequestSchema } },
      async (req, reply) => {
        const s = await requireSuperAdmin(ctx, req);
        const { post, created } = await submitVideoPost(ctx, req.body, { userId: s.user.id }, 'in_review');
        reply.code(created ? 201 : 200);
        return post;
      },
    );
    app.get('/api/platform/video/posts/:id', { schema: { params: IdParamsSchema } }, async (req) => {
      await requireSuperAdmin(ctx, req);
      return getVideoPost(ctx, req.params.id);
    });
    app.patch(
      '/api/platform/video/posts/:id',
      { schema: { params: IdParamsSchema, body: EditVideoPostRequestSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        return reviseVideoPost(ctx, req.params.id, req.body, { userId: s.user.id });
      },
    );
    app.post('/api/platform/video/posts/:id/approve', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireSuperAdmin(ctx, req);
      return approveVideoPost(ctx, s.user, req.params.id);
    });
    // ---- the schedule: Schedule = approve + slot; nothing renders before it (except an explicit preview)
    app.get('/api/platform/video/slots', { schema: { querystring: VideoSlotsQuerySchema } }, async (req) => {
      await requireSuperAdmin(ctx, req);
      return listSlots(ctx, req.query.format, req.query.count);
    });
    app.post(
      '/api/platform/video/posts/:id/schedule',
      { schema: { params: IdParamsSchema, body: ScheduleVideoPostRequestSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        return scheduleVideoPost(ctx, s.user, req.params.id, req.body);
      },
    );
    app.post(
      '/api/platform/video/posts/:id/unschedule',
      { schema: { params: IdParamsSchema, body: UnscheduleVideoPostRequestSchema.optional() } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        return unscheduleVideoPost(ctx, s.user, req.params.id, req.body?.reason);
      },
    );
    app.post(
      '/api/platform/video/posts/:id/move',
      { schema: { params: IdParamsSchema, body: MoveVideoPostRequestSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        return moveVideoPost(ctx, s.user, req.params.id, req.body.slotAt);
      },
    );
    app.post(
      '/api/platform/video/posts/:id/swap',
      { schema: { params: IdParamsSchema, body: SwapVideoPostRequestSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        return swapVideoPosts(ctx, s.user, req.params.id, req.body.withId);
      },
    );
    app.post('/api/platform/video/posts/:id/preview', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireSuperAdmin(ctx, req);
      return previewVideoPost(ctx, s.user, req.params.id);
    });
    app.post(
      '/api/platform/video/posts/:id/reject',
      { schema: { params: IdParamsSchema, body: RejectVideoPostRequestSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        return rejectVideoPost(ctx, s.user, req.params.id, req.body.reason);
      },
    );
    app.post(
      '/api/platform/video/posts/:id/retry-render',
      { schema: { params: IdParamsSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        return retryRender(ctx, s.user.id, req.params.id);
      },
    );
    app.post(
      '/api/platform/video/posts/:id/retry-upload',
      { schema: { params: IdParamsSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        return retryUpload(ctx, s.user.id, req.params.id);
      },
    );
    app.post(
      '/api/platform/video/posts/:id/resolve-locked',
      { schema: { params: IdParamsSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        return resolveLockedUpload(ctx, s.user.id, req.params.id);
      },
    );
    /** Starts the optional cross-post of an uploaded tutorial (a draft social post; approve it through /api/platform/social/posts). */
    app.post(
      '/api/platform/video/posts/:id/crosspost',
      { schema: { params: IdParamsSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        return createVideoCrossPost(ctx, req.params.id, { userId: s.user.id });
      },
    );

    /**
     * The preview files of a render (`video.mp4` or `short.mp4`, `captions.vtt`, `captions.srt`, `thumb.png`, `script.json`,
     * `render.log`, `description.txt`) with Range support for the player. `?revision=` picks another render than the
     * current one. Never cached: a re-render replaces the file.
     */
    app.get(
      '/api/platform/video/posts/:id/files/:name',
      {
        schema: {
          params: z.object({ id: z.uuid(), name: z.string().max(40) }),
          querystring: z.object({ revision: z.coerce.number().int().min(1).optional() }),
        },
      },
      async (req, reply) => {
        await requireSuperAdmin(ctx, req);
        const key = artifactKeyOf(req.params.name);
        if (!key) throw notFound('no such file');
        const post = await one(ctx.pool, 'SELECT revision, approved_render_id FROM video_posts WHERE id=$1', [
          req.params.id,
        ]);
        if (!post) throw notFound('video post not found', 'video_post_not_found');
        const render = await one(
          ctx.pool,
          'SELECT artifacts FROM video_renders WHERE post_id=$1 AND revision=$2',
          [req.params.id, req.query.revision ?? post.revision],
        );
        const file = render ? artifactPath(ctx, render.artifacts ?? {}, key) : null;
        if (!file || !existsSync(file)) throw notFound('the file is not there (yet)');
        const size = statSync(file).size;
        const ext = file.split('.').pop() ?? '';
        reply.header('content-type', TYPES[ext] ?? 'application/octet-stream');
        reply.header('cache-control', 'no-store');
        reply.header('accept-ranges', 'bytes');
        const range = req.headers.range;
        if (range) {
          const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
          let start = m?.[1] ? Number(m[1]) : NaN;
          let end = m?.[2] ? Number(m[2]) : NaN;
          if (!m || (Number.isNaN(start) && Number.isNaN(end)))
            throw badRequest('bad_range', 'unreadable Range header');
          if (Number.isNaN(start)) {
            start = Math.max(0, size - end); // bytes=-N: the last N bytes
            end = size - 1;
          } else if (Number.isNaN(end) || end >= size) end = size - 1;
          if (start > end || start >= size) {
            reply.code(416).header('content-range', `bytes */${size}`);
            return reply.send();
          }
          reply.code(206);
          reply.header('content-range', `bytes ${start}-${end}/${size}`);
          reply.header('content-length', end - start + 1);
          return reply.send(createReadStream(file, { start, end }));
        }
        reply.header('content-length', size);
        return reply.send(createReadStream(file));
      },
    );

    // ---- library (existing help videos)
    app.get('/api/platform/video/library', async (req) => {
      await requireSuperAdmin(ctx, req);
      return { videos: await listLibrary(ctx) };
    });
    app.post(
      '/api/platform/video/library/import',
      { schema: { body: ImportVideoLibraryRequestSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        const r = await importLibrary(ctx, { userId: s.user.id }, req.body.slugs);
        return { created: r.created.length, skipped: r.skipped, posts: r.created };
      },
    );

    // ---- Video topics
    app.get('/api/platform/video/topics', async (req) => {
      await requireSuperAdmin(ctx, req);
      return listVideoTopics(ctx);
    });
    app.post(
      '/api/platform/video/topics',
      { schema: { body: CreateVideoTopicRequestSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        const r = await queueVideoTopic(ctx, req.body, 'platform', s.user.id);
        return { duplicate: r.duplicate, topic: r.topic, ...(await listVideoTopics(ctx)) };
      },
    );
    app.post(
      '/api/platform/video/topics/:id/reject',
      { schema: { params: IdParamsSchema, body: RejectVideoTopicRequestSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        await rejectVideoTopic(ctx, req.params.id, req.body.reason, s.user.id);
        return listVideoTopics(ctx);
      },
    );
    app.post('/api/platform/video/topics/:id/move', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireSuperAdmin(ctx, req);
      await moveVideoTopicUp(ctx, req.params.id, s.user.id);
      return listVideoTopics(ctx);
    });
  };
}
