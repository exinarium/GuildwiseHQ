import {
  BlogContentSchema,
  ConnectSocialChannelRequestSchema,
  CreateApiKeyRequestSchema,
  CreateBlogTopicRequestSchema,
  CreateSocialPostRequestSchema,
  EditBlogPostRequestSchema,
  EditSocialPostRequestSchema,
  IdParamsSchema,
  PatchBlogSettingsRequestSchema,
  PatchBlogWriterRequestSchema,
  PlatformBlogQuerySchema,
  RejectBlogPostRequestSchema,
  RejectBlogTopicRequestSchema,
  RejectSocialPostRequestSchema,
  SOCIAL_NETWORKS,
  SocialNetworkParamsSchema,
  scrubTopic,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireSuperAdmin } from '../auth/guards.ts';
import { draftFromRelease, getRelease } from '../blog/releases.ts';
import { listTopics, moveTopicUp, queueBlogTopic, rejectTopic } from '../blog/topics.ts';
import {
  blogSettings,
  getPost,
  listPosts,
  patchBlogSettings,
  pendingCount,
  publishPost,
  rejectPost,
  revisePost,
  submitPost,
  unpublishPost,
} from '../commands/blog.ts';
import { digestTestMail } from '../commands/blog-digest.ts';
import { apiKeyAudit, createApiKey, listApiKeys, revokeApiKey } from '../commands/blog-keys.ts';
import {
  connectChannel,
  disconnectChannel,
  listChannels,
  requestShares,
  socialProblems,
} from '../commands/social.ts';
import {
  approveSocialPost,
  getSocialPost,
  listReleases,
  pendingSocialPosts,
  rejectSocialPost,
  requestSocialReview,
  reviseSocialPost,
  submitSocialPost,
} from '../commands/social-posts.ts';
import type { Ctx } from '../context.ts';
import { rows } from '../db/sql.ts';
import { badRequest } from '../errors.ts';
import { typed } from './util.ts';

/** Super admin routes of the blog, the agent API keys and the social channels (404 for everyone else). */
export function blogPlatformRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/platform/blog', { schema: { querystring: PlatformBlogQuerySchema } }, async (req) => {
      await requireSuperAdmin(ctx, req);
      return {
        posts: await listPosts(ctx, { status: req.query.status, limit: 200 }),
        pending: await pendingCount(ctx),
        settings: await blogSettings(ctx),
        social: { channels: await listChannels(ctx), ...(await socialProblems(ctx)) },
      };
    });

    app.get('/api/platform/blog/summary', async (req) => {
      await requireSuperAdmin(ctx, req);
      const s = await blogSettings(ctx);
      return {
        pending: await pendingCount(ctx),
        pendingReleases: await pendingSocialPosts(ctx),
        enabled: s.enabled,
      };
    });

    app.get('/api/platform/blog/settings', async (req) => {
      await requireSuperAdmin(ctx, req);
      return blogSettings(ctx);
    });
    app.patch(
      '/api/platform/blog/settings',
      { schema: { body: PatchBlogSettingsRequestSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        return patchBlogSettings(ctx, s.user, req.body);
      },
    );

    app.get('/api/platform/blog/posts/:id', { schema: { params: IdParamsSchema } }, async (req) => {
      await requireSuperAdmin(ctx, req);
      return getPost(ctx, 'id', req.params.id);
    });

    app.post('/api/platform/blog/posts', { schema: { body: BlogContentSchema } }, async (req, reply) => {
      const s = await requireSuperAdmin(ctx, req);
      const { post } = await submitPost(ctx, req.body, { userId: s.user.id }, 'draft');
      reply.code(201);
      return post;
    });

    app.patch(
      '/api/platform/blog/posts/:id',
      { schema: { params: IdParamsSchema, body: EditBlogPostRequestSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        return revisePost(ctx, req.params.id, req.body, { userId: s.user.id });
      },
    );

    app.post('/api/platform/blog/posts/:id/publish', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireSuperAdmin(ctx, req);
      return publishPost(ctx, req.params.id, { userId: s.user.id });
    });
    app.post(
      '/api/platform/blog/posts/:id/reject',
      { schema: { params: IdParamsSchema, body: RejectBlogPostRequestSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        return rejectPost(ctx, s.user, req.params.id, req.body.reason);
      },
    );
    app.post(
      '/api/platform/blog/posts/:id/unpublish',
      { schema: { params: IdParamsSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        return unpublishPost(ctx, s.user, req.params.id);
      },
    );
    /** Share (again) to the connected networks; a network that already has the post is never posted twice. */
    app.post('/api/platform/blog/posts/:id/share', { schema: { params: IdParamsSchema } }, async (req) => {
      await requireSuperAdmin(ctx, req);
      const p = await getPost(ctx, 'id', req.params.id);
      if (p.status !== 'published') throw badRequest('not_published', 'only a published post can be shared');
      await requestShares(ctx, p.id, [...SOCIAL_NETWORKS]);
      return getPost(ctx, 'id', p.id);
    });

    // ---- research topics (docs/design/ceo-blog-topics.md): the super admin's own questions and the queue
    app.get('/api/platform/blog/topics', async (req) => {
      await requireSuperAdmin(ctx, req);
      return listTopics(ctx);
    });
    app.post('/api/platform/blog/topics', { schema: { body: CreateBlogTopicRequestSchema } }, async (req) => {
      const s = await requireSuperAdmin(ctx, req);
      // The same gate as every other source: a question that does not pass the scrubber never enters the queue.
      const r = scrubTopic(req.body, { allowTerms: req.body.allowTerms ?? [] });
      if (!r.ok)
        throw badRequest('topic_rejected', 'the question does not pass the topic checks', r.findings);
      const queued = await queueBlogTopic(ctx, r.topic, 'platform', { by: s.user.id });
      return { ...queued, ...(await listTopics(ctx)) };
    });
    app.post(
      '/api/platform/blog/topics/:id/reject',
      { schema: { params: IdParamsSchema, body: RejectBlogTopicRequestSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        await rejectTopic(ctx, req.params.id, req.body.reason, s.user.id);
        return listTopics(ctx);
      },
    );
    app.post('/api/platform/blog/topics/:id/move', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireSuperAdmin(ctx, req);
      await moveTopicUp(ctx, req.params.id, s.user.id);
      return listTopics(ctx);
    });

    // ---- digests
    app.get('/api/platform/blog/digests', async (req) => {
      await requireSuperAdmin(ctx, req);
      const rs = await rows(ctx.pool, 'SELECT * FROM blog_digests ORDER BY created_at DESC LIMIT 30');
      return {
        digests: rs.map((r) => ({
          digestId: r.digest_id as string,
          state: r.state as string,
          recipients: r.recipients as number,
          posts: (r.post_ids as string[]).length,
          createdAt: new Date(r.created_at).toISOString(),
          note: (r.note ?? null) as string | null,
        })),
      };
    });
    app.post('/api/platform/blog/digests/test', async (req) => {
      const s = await requireSuperAdmin(ctx, req);
      const n = await digestTestMail(ctx, s.user.email, s.user.id);
      if (!n) throw badRequest('no_posts', 'there are no published posts to put in a digest');
      return { sentTo: s.user.email, posts: n };
    });

    // ---- API keys
    app.get('/api/platform/api-keys', async (req) => {
      await requireSuperAdmin(ctx, req);
      return { keys: await listApiKeys(ctx) };
    });
    app.get('/api/platform/api-keys/audit', async (req) => {
      await requireSuperAdmin(ctx, req);
      return { requests: await apiKeyAudit(ctx) };
    });
    app.post(
      '/api/platform/api-keys',
      { schema: { body: CreateApiKeyRequestSchema } },
      async (req, reply) => {
        const s = await requireSuperAdmin(ctx, req);
        reply.code(201);
        return createApiKey(ctx, s.user, req.body);
      },
    );
    app.post('/api/platform/api-keys/:id/revoke', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireSuperAdmin(ctx, req);
      await revokeApiKey(ctx, s.user, req.params.id);
      return { keys: await listApiKeys(ctx) };
    });

    // ---- social channels
    app.get('/api/platform/social/channels', async (req) => {
      await requireSuperAdmin(ctx, req);
      return { channels: await listChannels(ctx), ...(await socialProblems(ctx)) };
    });
    app.put(
      '/api/platform/social/channels/:network',
      { schema: { params: SocialNetworkParamsSchema, body: ConnectSocialChannelRequestSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        return { channels: await connectChannel(ctx, s.user, req.params.network, req.body) };
      },
    );
    app.delete(
      '/api/platform/social/channels/:network',
      { schema: { params: SocialNetworkParamsSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        return { channels: await disconnectChannel(ctx, s.user, req.params.network) };
      },
    );

    // ---- release announcements: a post per release of the product, always approved by hand
    app.get('/api/platform/social/releases', async (req) => {
      await requireSuperAdmin(ctx, req);
      return listReleases(ctx);
    });
    /** "Write by hand": starts a draft for a release with captions prefilled from the changelog and What's New. */
    app.post(
      '/api/platform/social/posts',
      { schema: { body: CreateSocialPostRequestSchema } },
      async (req, reply) => {
        const s = await requireSuperAdmin(ctx, req);
        const release = getRelease(req.body.ref, ctx);
        if (!release) throw badRequest('unknown_release', `there is no release ${req.body.ref}`);
        const { post, created } = await submitSocialPost(
          ctx,
          { kind: req.body.kind, ref: req.body.ref, content: draftFromRelease(release) },
          { userId: s.user.id },
          'draft',
        );
        reply.code(created ? 201 : 200);
        return post;
      },
    );
    app.get('/api/platform/social/posts/:id', { schema: { params: IdParamsSchema } }, async (req) => {
      await requireSuperAdmin(ctx, req);
      return getSocialPost(ctx, req.params.id);
    });
    app.patch(
      '/api/platform/social/posts/:id',
      { schema: { params: IdParamsSchema, body: EditSocialPostRequestSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        return reviseSocialPost(ctx, req.params.id, req.body, { userId: s.user.id });
      },
    );
    app.post('/api/platform/social/posts/:id/submit', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireSuperAdmin(ctx, req);
      return requestSocialReview(ctx, s.user, req.params.id);
    });
    app.post(
      '/api/platform/social/posts/:id/approve',
      { schema: { params: IdParamsSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        return approveSocialPost(ctx, s.user, req.params.id);
      },
    );
    app.post(
      '/api/platform/social/posts/:id/reject',
      { schema: { params: IdParamsSchema, body: RejectSocialPostRequestSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        return rejectSocialPost(ctx, s.user, req.params.id, req.body.reason);
      },
    );
  };
}
