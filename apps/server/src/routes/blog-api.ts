import {
  ApiPatchPostSchema,
  ApiPostsQuerySchema,
  ApiShareRequestSchema,
  ApiSlugParamsSchema,
  BLOG_AUTHOR,
  BLOG_LIMITS,
  BLOG_TAGS,
  BlogContentSchema,
  type BlogPost,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import {
  assertBlogEnabled,
  blogSettings,
  getPost,
  getPostRow,
  listPosts,
  publishPost,
  revisePost,
  submitPost,
} from '../commands/blog.ts';
import { assertPostCap, authenticateKey, logApiRequest, markPostCreated } from '../commands/blog-keys.ts';
import { listSharesForApi, requestShares } from '../commands/social.ts';
import type { Ctx } from '../context.ts';
import { conflict, notFound } from '../errors.ts';
import { typed } from './util.ts';

/** What an agent sees of a post in a list. */
const brief = (p: BlogPost) => ({
  id: p.id,
  slug: p.slug,
  title: p.title,
  summary: p.summary,
  tags: p.tags,
  status: p.status,
  rejectionReason: p.rejectionReason,
  warnings: p.warnings,
  publishedAt: p.publishedAt,
  createdAt: p.createdAt,
});
const full = (p: BlogPost) => ({
  ...brief(p),
  bodyMarkdown: p.bodyMarkdown,
  coverImage: p.coverImage,
  sources: p.sources,
  seo: p.seo,
  social: p.social,
  aiDisclosure: p.aiDisclosure,
  readingMinutes: p.readingMinutes,
  wordCount: p.wordCount,
});

/**
 * The agent API (docs/BLOG-API.md): `/api/v1`, authenticated only by `Authorization: Bearer gwk_...`. Session cookies
 * are never read here, which is why the cookie routes' Origin check is waived for this prefix (auth/origin-check.ts).
 */
export function blogApiRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);
    // onSend (not onResponse) so the audit row is complete before the client gets its answer
    app.addHook('onSend', async (req, reply, payload) => {
      await logApiRequest(ctx, req, reply.statusCode);
      return payload;
    });

    app.get('/api/v1/blog/meta', async (req, reply) => {
      await authenticateKey(ctx, req, reply, 'blog:read');
      const s = await blogSettings(ctx);
      return {
        enabled: s.enabled,
        moderation: s.reviewAll ? 'review_all' : 'hold_then_publish',
        holdHours: s.holdHours,
        autoPublishFrom: s.autoPublishFrom,
        author: BLOG_AUTHOR,
        tags: BLOG_TAGS,
        limits: BLOG_LIMITS,
      };
    });

    app.get('/api/v1/blog/posts', { schema: { querystring: ApiPostsQuerySchema } }, async (req, reply) => {
      const key = await authenticateKey(ctx, req, reply, 'blog:read');
      const q = req.query;
      const posts = await listPosts(ctx, {
        keyId: key.id,
        since: q.since,
        tag: q.tag,
        q: q.q,
        status: q.status,
        limit: q.limit,
      });
      return { posts: posts.map(brief) };
    });

    app.get('/api/v1/blog/posts/:slug', { schema: { params: ApiSlugParamsSchema } }, async (req, reply) => {
      const key = await authenticateKey(ctx, req, reply, 'blog:read');
      const r = await getPostRow(ctx, 'slug', req.params.slug);
      if (!r || (r.status !== 'published' && r.origin_key_id !== key.id))
        throw notFound('post not found', 'post_not_found');
      return full(await getPost(ctx, 'slug', req.params.slug));
    });

    app.post('/api/v1/blog/posts', { schema: { body: BlogContentSchema } }, async (req, reply) => {
      const key = await authenticateKey(ctx, req, reply, 'blog:write', { write: true });
      assertBlogEnabled((await blogSettings(ctx)).enabled);
      // A repeat of an existing slug is answered from the existing post and does not count to the cap.
      if (!(await getPostRow(ctx, 'slug', req.body.slug))) await assertPostCap(ctx, key.id, reply);
      const { post, created } = await submitPost(ctx, req.body, { apiKeyId: key.id }, 'in_review');
      if (created) await markPostCreated(ctx, req);
      reply.code(created ? 201 : 200);
      return full(post);
    });

    app.patch(
      '/api/v1/blog/posts/:slug',
      { schema: { params: ApiSlugParamsSchema, body: ApiPatchPostSchema } },
      async (req, reply) => {
        const key = await authenticateKey(ctx, req, reply, 'blog:write', { write: true });
        const r = await getPostRow(ctx, 'slug', req.params.slug);
        if (!r || r.origin_key_id !== key.id) throw notFound('post not found', 'post_not_found');
        return full(await revisePost(ctx, r.id, req.body, { apiKeyId: key.id }, { ownKeyOnly: true }));
      },
    );

    app.post(
      '/api/v1/blog/posts/:slug/publish',
      { schema: { params: ApiSlugParamsSchema } },
      async (req, reply) => {
        const key = await authenticateKey(ctx, req, reply, 'blog:publish', { write: true });
        const r = await getPostRow(ctx, 'slug', req.params.slug);
        if (!r || r.origin_key_id !== key.id) throw notFound('post not found', 'post_not_found');
        const s = await blogSettings(ctx);
        assertBlogEnabled(s.enabled);
        if (s.reviewAll)
          throw conflict(
            'review_required',
            'the owner reviews every post at the moment; publishing is not available',
          );
        return full(await publishPost(ctx, r.id, { apiKeyId: key.id }));
      },
    );

    app.post(
      '/api/v1/blog/posts/:slug/share',
      { schema: { params: ApiSlugParamsSchema, body: ApiShareRequestSchema } },
      async (req, reply) => {
        await authenticateKey(ctx, req, reply, 'social:write', { write: true });
        assertBlogEnabled((await blogSettings(ctx)).enabled);
        const r = await getPostRow(ctx, 'slug', req.params.slug);
        if (!r || r.status !== 'published') throw notFound('published post not found', 'post_not_found');
        return { shares: await requestShares(ctx, r.id, req.body.channels) };
      },
    );

    app.get('/api/v1/social/shares', async (req, reply) => {
      await authenticateKey(ctx, req, reply, 'social:write');
      return { shares: await listSharesForApi(ctx) };
    });
  };
}
